# Phase 10F: Durable External-Effect Protocol Design

## Executive Summary

Phase 10F introduces explicit **effect-state tracking** separate from action status to safely handle crashes during external system calls. The protocol distinguishes between the action's lifecycle status (PENDING → COMMITTED | FAILED | ESCALATED) and its external-effect progress (NOT_STARTED → IN_PROGRESS → APPLIED | NOT_APPLIED | UNKNOWN). This separation enables:

- **Precise crash-window recovery**: Different recovery strategies for crashes before, during, and after external calls
- **UNKNOWN handling**: Never blindly retry when outcome is indeterminate; escalate to human review instead
- **Exactly-once external execution**: When external systems support idempotency keys and outcome queries
- **Backward compatibility**: Additive schema migration; pre-existing COMMITTED/FAILED actions map safely

## Architecture Overview

### Current Three-Phase Protocol (Phases 1–3)

1. **Phase 1 (Intend)**: INSERT intent with ON CONFLICT DO NOTHING; acquire lease; determine disposition
2. **Phase 2 (Execute)**: Only Owned disposition executes external call; others defer or retry
3. **Phase 3 (Commit)**: Atomic serializable transaction: resolve intent + mutate world state + write memory

### Phase 10F Enhancement

**Effect-state machine** runs parallel to action status machine:

`
Action Status:  PENDING → COMMITTED (or FAILED, or ESCALATED)
Effect State:   NOT_STARTED → IN_PROGRESS → {APPLIED, NOT_APPLIED, UNKNOWN}
`

The coordinator tracks **when** effects happen; the reconciler tracks **what** the external system confirms.

---

## Effect States and Transitions

### State Definitions

| State | Meaning | Persistence | Crash Safety |
|-------|---------|-------------|--------------|
| **NOT_STARTED** | External call not yet attempted; action phase 1 complete. | effect_state='NOT_STARTED', effect_started_at=NULL | Safe: no external effect possible yet |
| **IN_PROGRESS** | External call is in flight; process holds lease. | effect_state='IN_PROGRESS', effect_started_at=now() | Unsafe: external system may have received and processed the call |
| **APPLIED** | External system confirms idempotency_key completed successfully. | effect_state='APPLIED', effect_completed_at=now(), verifier_response='APPLIED' | Safe: verifier confirms idempotent re-check will not re-execute |
| **NOT_APPLIED** | External system confirms idempotency_key does not exist or failed. | effect_state='NOT_APPLIED', effect_completed_at=now(), verifier_response='NOT_APPLIED' | Safe: effect definitely did not happen; safe to fail the action |
| **UNKNOWN** | Outcome indeterminate (timeout, inconsistent state, verifier error, no idempotency support). | effect_state='UNKNOWN', verified_at=now(), verifier_response='UNKNOWN' | Conservative: no recovery action; escalate to human |

### State Transition Diagram

`
NOT_STARTED
    ↓
    ├→ (Coordinator begins external call)
    ↓
IN_PROGRESS
    ├→ (External call completes successfully)
    ↓ 
APPLIED
    ├→ (Coordinator updates status to COMMITTED)
    ↓
[COMMITTED status; effect still APPLIED; done]
    
    OR
    
IN_PROGRESS
    ├→ (External call fails or returns error)
    ↓
NOT_APPLIED
    ├→ (Coordinator marks status as FAILED)
    ↓
[FAILED status; effect NOT_APPLIED; done]
    
    OR (Crash during IN_PROGRESS)
    
IN_PROGRESS
    ├→ (Crash; recovery runs)
    ├→ (Verifier checks ground truth)
    ├→ Verifier returns APPLIED → transition to APPLIED, update status to COMMITTED
    ├→ Verifier returns NOT_APPLIED → transition to NOT_APPLIED, mark status as FAILED
    ├→ Verifier returns UNKNOWN → transition to UNKNOWN, mark status as ESCALATED
`

### State Transition Operations

All transitions are performed as isolated UPDATE statements with appropriate WHERE clauses:

#### 1. NOT_STARTED → IN_PROGRESS
`sql
UPDATE actions 
  SET effect_state='IN_PROGRESS', effect_started_at=now()
WHERE idempotency_key= AND lease_owner= AND effect_state='NOT_STARTED'
`
- **Who**: ActionCoordinator (before external call)
- **Precondition**: Owns lease; effect_state is NOT_STARTED
- **Idempotency**: UNIQUE(idempotency_key) ensures only one row; lease_owner check ensures only owner can proceed

#### 2. IN_PROGRESS → APPLIED
`sql
UPDATE actions 
  SET effect_state='APPLIED', effect_completed_at=now(), 
      external_reference=, outcome=
WHERE idempotency_key= AND status='PENDING' AND effect_state='IN_PROGRESS'
`
- **Who**: ActionCoordinator (after successful external call)
- **Precondition**: External call succeeded; effect_state still IN_PROGRESS; status still PENDING
- **Idempotency**: ON CONFLICT on idempotency_key deduplicates; repeat calls idempotent

#### 3. IN_PROGRESS → NOT_APPLIED
`sql
UPDATE actions 
  SET effect_state='NOT_APPLIED', effect_completed_at=now()
WHERE idempotency_key= AND status='PENDING' AND effect_state='IN_PROGRESS'
`
- **Who**: ActionCoordinator (after external call fails locally)
- **Precondition**: External call failed; effect_state IN_PROGRESS; status PENDING
- **Idempotency**: Repeats are safe; same effect_state transition

#### 4. IN_PROGRESS → UNKNOWN
`sql
UPDATE actions 
  SET effect_state='UNKNOWN', verified_at=now(), verifier_response='UNKNOWN'
WHERE idempotency_key= AND status='PENDING' AND effect_state='IN_PROGRESS'
`
- **Who**: ActionReconciler (after verifier cannot determine outcome)
- **Precondition**: Verifier returned UNKNOWN; effect_state IN_PROGRESS
- **Idempotency**: Subsequent verifier calls also return UNKNOWN; repeated UPDATEs idempotent

#### 5. APPLIED → COMMITTED
`sql
UPDATE actions 
  SET status='COMMITTED', lease_owner=NULL, resolved_at=now()
WHERE idempotency_key= AND status='PENDING' AND effect_state='APPLIED'
`
- **Who**: ActionCoordinator (phase 3, after external call succeeds)
- **Precondition**: effect_state APPLIED; status still PENDING; holds lease
- **Idempotency**: Compare-and-set on status; only first caller succeeds; repeats are no-ops

#### 6. NOT_APPLIED → FAILED
`sql
UPDATE actions 
  SET status='FAILED', lease_owner=NULL, resolved_at=now()
WHERE idempotency_key= AND status='PENDING' AND effect_state='NOT_APPLIED'
`
- **Who**: ActionCoordinator or ActionReconciler
- **Precondition**: effect_state NOT_APPLIED; status PENDING; reconciler owns lease
- **Idempotency**: Compare-and-set on status; repeats are no-ops

#### 7. UNKNOWN → ESCALATED
`sql
UPDATE actions 
  SET status='ESCALATED', lease_owner=NULL, resolved_at=now()
WHERE idempotency_key= AND status='PENDING' AND effect_state='UNKNOWN'
`
- **Who**: ActionReconciler (after verifier returns UNKNOWN)
- **Precondition**: effect_state UNKNOWN; status PENDING; reconciler owns lease
- **Idempotency**: Compare-and-set on status; repeats are no-ops
- **Guarantee**: Never transitions back to IN_PROGRESS; human review required

---

## Crash-Window Analysis

### Window 1: Before External Call (effect_state=NOT_STARTED)

**Scenario**: Coordinator crashes after phase 1 (intend) but before external call.

**Database State**: 
- status=PENDING
- effect_state=NOT_STARTED
- lease_owner=[dead process]
- lease_expires_at=[past]

**Recovery**:
1. Reconciler claims expired lease
2. Calls verifier: "Did idempotency_key complete on external system?"
3. Verifier checks external system for idempotency_key

**Possible Outcomes**:
- **Verifier returns APPLIED**: Effect somehow happened (e.g., retry by caller, system processed another request). Update effect_state→APPLIED, status→COMMITTED.
- **Verifier returns NOT_APPLIED**: Effect did not happen (idempotency_key never seen). Update effect_state→NOT_APPLIED, status→FAILED.
- **Verifier returns UNKNOWN**: Cannot determine (external system has no idempotency-key support, or timeout). Update effect_state→UNKNOWN, status→ESCALATED. **Never retry.**

**Key Property**: No external call has been issued yet; safe to await verifier's authoritative answer.

---

### Window 2: During External Call (effect_state=IN_PROGRESS)

**Scenario**: Coordinator crashes while external call is in flight.

**Database State**:
- status=PENDING
- effect_state=IN_PROGRESS
- effect_started_at=[recent]
- lease_owner=[dead process]
- lease_expires_at=[past]

**Recovery**:
1. Reconciler claims expired lease
2. Calls verifier: "Did the effect complete?"
3. Verifier queries external system by idempotency_key

**Possible Outcomes**:
- **Verifier returns APPLIED**: External system confirms completion. Update effect_state→APPLIED, status→COMMITTED. **Do not retry.**
- **Verifier returns NOT_APPLIED**: External system confirms no effect. Update effect_state→NOT_APPLIED, status→FAILED.
- **Verifier returns UNKNOWN**: Cannot determine (call may have arrived, or may not have; external system cannot query by idempotency_key). Update effect_state→UNKNOWN, status→ESCALATED. **Never retry; escalate for human investigation.**

**Critical**: External system may have **already processed the request**. Retrying blindly causes duplicate execution. Exactly-once is only possible if:
1. External system supports idempotency keys
2. External system can query outcome by idempotency_key
3. Verifier has access to both

**Stale-Worker Prevention**: If multiple reconcilers are running and both claim the same action, the database's UNIQUE constraint on idempotency_key ensures only the first UPDATE succeeds; the second is a no-op.

---

### Window 3: After Effect Completes, Before Status Updated (effect_state=APPLIED|NOT_APPLIED, status=PENDING)

**Scenario**: Coordinator successfully called external system, moved effect_state→APPLIED|NOT_APPLIED, but crashes before phase 3 commit.

**Database State**:
- status=PENDING (still)
- effect_state=APPLIED or NOT_APPLIED
- effect_completed_at=[set]
- verifier_response=[set] (optional)
- lease_owner=[dead process]
- lease_expires_at=[past]

**Recovery**:
1. Reconciler claims expired lease
2. **Checks effect_state**:
   - If APPLIED: Read cached verifier_response if available; if set, skip verifier call and commit directly
   - If NOT_APPLIED: Mark status→FAILED without verifier re-call
3. If no cached verifier_response and effect_state=APPLIED: Call verifier to confirm, then commit

**Optimization**: Avoid redundant verifier queries by caching verifier_response at effect completion time.

**Key Property**: Effect is already known to be durable; safe to commit without re-calling external system.

---

### Window 4: After Status Committed (status=COMMITTED or FAILED, effect_state=APPLIED or NOT_APPLIED)

**Scenario**: Both effect_state and status are finalized.

**Database State**:
- status=COMMITTED or FAILED or ESCALATED
- effect_state=[set to result]
- resolved_at=[set]

**Recovery**: No recovery needed. Idempotency check at phase 1 (Intend) returns AlreadyCommitted, and outcome is returned to caller.

---

## Schema Migration: 20240101000015

### Proposed Additive Migration

`sql
-- Add effect-state tracking columns to actions table
ALTER TABLE actions ADD COLUMN IF NOT EXISTS effect_state VARCHAR(50) 
  DEFAULT 'NOT_STARTED' CHECK (effect_state IN ('NOT_STARTED', 'IN_PROGRESS', 'APPLIED', 'NOT_APPLIED', 'UNKNOWN'));

ALTER TABLE actions ADD COLUMN IF NOT EXISTS effect_started_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE actions ADD COLUMN IF NOT EXISTS effect_completed_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE actions ADD COLUMN IF NOT EXISTS verifier_response VARCHAR(50) 
  CHECK (verifier_response IN ('APPLIED', 'NOT_APPLIED', 'UNKNOWN') OR verifier_response IS NULL);

ALTER TABLE actions ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP WITH TIME ZONE;

-- Constraint: verifier_response and verified_at must both be set or both be null
ALTER TABLE actions ADD CONSTRAINT verifier_response_verified_at_consistency 
  CHECK ((verifier_response IS NOT NULL AND verified_at IS NOT NULL) OR (verifier_response IS NULL AND verified_at IS NULL));

-- Backward compatibility: pre-existing COMMITTED actions map to effect_state=APPLIED
-- (assumption: COMMITTED status means the action completed successfully and was verified)
UPDATE actions SET effect_state='APPLIED' WHERE effect_state='NOT_STARTED' AND status='COMMITTED';

-- Pre-existing FAILED actions map to effect_state=UNKNOWN (conservative)
-- Reason: FAILED status does not tell us whether the external effect actually happened.
-- A coordinator may have crashed before calling the verifier, leaving the external outcome uncertain.
-- Only the reconciler's verifier can establish authoritative outcome; leave UNKNOWN for reconciler to resolve.
UPDATE actions SET effect_state='UNKNOWN'
  WHERE effect_state='NOT_STARTED' AND status='FAILED' AND resolved_at IS NULL;
-- Leave verified_at=NULL and verifier_response=NULL: no actual verifier result was recorded;
-- reconciler will call verifier to establish authoritative outcome.

-- Indexes for efficiency
CREATE INDEX IF NOT EXISTS idx_actions_effect_in_progress 
  ON actions(effect_state) WHERE effect_state='IN_PROGRESS' AND status='PENDING';

CREATE INDEX IF NOT EXISTS idx_actions_effect_unknown 
  ON actions(effect_state) WHERE effect_state='UNKNOWN' AND status='PENDING';
`

### Existing Constraints Preserved

- UNIQUE(idempotency_key): Unchanged; prevents duplicate intents
- FOREIGN KEY (lease_owner REFERENCES agents): Unchanged; lease ownership
- CHECK (status IN ('PENDING', 'COMMITTED', 'FAILED')): Unchanged; still guards action status
- idx_actions_lease_expiry ON (lease_expires_at) WHERE status='PENDING': Unchanged; reconciler efficiency

### Backward Compatibility

- **Old code (pre-Phase 10F)**: Does not read or write effect_state; columns default to NOT_STARTED and NULL
- **Mixed deployments**: Phase 10F code reads effect_state; if NULL, treats as NOT_STARTED; reconciler updates it based on verifier result
- **COMMITTED actions**: Safely map to effect_state=APPLIED (assumption: commit succeeded, effect was durable)
- **FAILED actions**: Conservatively map to effect_state=UNKNOWN (reasoning: coordinator may have crashed before verifying; external outcome is indeterminate; reconciler will verify)
- **Graceful transition**: No breaking changes; existing actions continue to resolve via reconciler; reconciler gradually fills in authoritative effect_state via verifier

---

## Verifier Contract

### ActionVerifier Interface Enhancement

`	ypescript
export interface ActionVerifier {
  /**
   * Verify queries external ground truth for an action's outcome.
   * Must handle all crash windows safely.
   */
  verify(action: Action): Promise<Verdict>;

  /**
   * getEffect (optional) extracts the desired world state from actionArgs
   * for the coordinator to apply during phase 3 commit.
   */
  getEffect?(actionType: string, actionArgs: any): Promise<WorldEffect | undefined>;

  /**
   * onEffectBegin (optional) hook called when effect_state transitions to IN_PROGRESS.
   * Allows verifier to record attempt in external system (for debugging).
   */
  onEffectBegin?(action: Action): Promise<void>;

  /**
   * onEffectCompleted (optional) hook called when effect_state transitions to APPLIED/NOT_APPLIED.
   * Allows verifier to log success/failure.
   */
  onEffectCompleted?(action: Action, succeeded: boolean, result?: any): Promise<void>;
}

export interface Verdict {
  /**
   * disposition: APPLIED | NOT_APPLIED | UNKNOWN
   */
  disposition: VerdictDisposition;

  /**
   * externalRef: identifier returned by external system (e.g., transaction ID, resource ID)
   */
  externalRef: string;

  /**
   * outcome: structured data about the effect (e.g., created resource, error detail)
   */
  outcome: Record<string, any>;

  /**
   * reason: human-readable explanation (e.g., "idempotency_key found in system X with result Y")
   */
  reason: string;
}

export enum VerdictDisposition {
  /**
   * APPLIED (0): Authoritative evidence that the effect happened.
   * Preconditions:
   * - External system supports idempotency keys OR
   * - Verifier can confirm resource/state change attributable to this action
   */
  Applied = 0,

  /**
   * NOT_APPLIED (1): Authoritative evidence that the effect did not happen.
   * Preconditions:
   * - idempotency_key not found in external system, OR
   * - External system confirms operation failed/was rejected
   */
  NotApplied = 1,

  /**
   * UNKNOWN (2): Cannot establish authoritative outcome.
   * Reasons:
   * - External system does not support idempotency keys or outcome queries
   * - Timeout communicating with external system
   * - Transient error from verifier (network, auth failure)
   * - External system returns conflicting/inconsistent state
   *
   * Implication: Action stays PENDING with effect_state=UNKNOWN; never retried.
   */
  Unknown = 2,
}
`

### Verifier Semantics

| Verdict | Meaning | Recovery | Next Status |
|---------|---------|----------|------------|
| **APPLIED** | External system confirms success by idempotency_key or resource state. | Commit action to COMMITTED. | COMMITTED |
| **NOT_APPLIED** | External system confirms absence or explicit failure. | Mark action FAILED. | FAILED |
| **UNKNOWN** | Outcome cannot be determined. Timeouts, missing idempotency support, transient errors all map here. | Escalate to ESCALATED; leave for human review; never retry. | ESCALATED |

### Critical Distinction: Errors vs. Outcomes

**Timeout or Communication Error**:
- If verifier cannot reach external system: return UNKNOWN (not throw)
- Reason: Timeout is itself evidence of uncertainty; retrying is unsafe

**Confirmed Failure (e.g., HTTP 4xx, permission denied)**:
- If external system rejects the request: return NOT_APPLIED
- Reason: Authoritative proof that effect did not happen

**Network Transient (e.g., connection reset)**:
- If verifier cannot determine if request was received: return UNKNOWN
- Reason: Request may have been processed; retrying is unsafe

---

## Recovery Algorithm

### ActionReconciler.reconcileOne(action: Action)

`	ypescript
async reconcileOne(action: Action): Promise<void> {
  // Precondition: reconciler owns lease; effect_state may be NOT_STARTED or IN_PROGRESS

  // Step 1: Determine starting point
  let verdict: Verdict;
  
  // Window 3 optimization: if effect_state is APPLIED/NOT_APPLIED and verifier_response cached
  if ((action.effectState === 'APPLIED' || action.effectState === 'NOT_APPLIED') && action.verifierResponse) {
    // Use cached response; skip verifier call
    verdict = { disposition: action.verifierResponse, externalRef: action.externalRef, ... };
  } else {
    // Call verifier for ground truth
    verdict = await this.verifier.verify(action);
  }

  // Step 2: Transition effect_state and status based on verdict
  switch (verdict.disposition) {
    case VerdictDisposition.Applied:
      // Window 2 or 3: external system confirms completion
      await this.updateEffectState(action.idemKey, 'APPLIED', verdict);
      await this.commitRecovered(action, verdict);
      break;

    case VerdictDisposition.NotApplied:
      // Window 1 or 2: external system confirms no effect
      await this.updateEffectState(action.idemKey, 'NOT_APPLIED', verdict);
      await this.markFailed(action, verdict.reason);
      break;

    case VerdictDisposition.Unknown:
      // Cannot establish outcome; escalate
      await this.updateEffectState(action.idemKey, 'UNKNOWN', verdict);
      await this.escalate(action, verdict.reason);
      break;
  }
}
`

### Prevention of Stale Writes

**Problem**: Multiple reconcilers may try to claim and reconcile the same action.

**Solution**:
1. **Lease-based exclusion**: FOR UPDATE SKIP LOCKED prevents concurrent recovery of the same row
2. **Status compare-and-set**: UPDATE WHERE status='PENDING' ensures only first reconciler wins
3. **Effect-state guards**: UPDATE WHERE effect_state=[expected] guards against stale transitions

**Example**:
`	ypescript
// Reconciler A and B both claim action X
// Both try: UPDATE actions SET status='COMMITTED' WHERE idemKey=X AND status='PENDING'
// Only one UPDATE succeeds (rowCount=1); the other gets rowCount=0 and exits gracefully
`

### Never Retry on UNKNOWN

**Critical Invariant**: If verifier returns UNKNOWN, action transitions to:
- effect_state = UNKNOWN (never transitions back to NOT_STARTED or IN_PROGRESS)
- status = ESCALATED (never transitions back to PENDING)

**Implication**: Reconciler leaves action in place; does not attempt re-execution. Human operator or secondary audit process must investigate and manually resolve.

---

## External-System Capability Matrix

### Scenarios and Achievable Guarantees

| System Capability | Verifier Strategy | Exactly-Once? | Recovery |
|---|---|---|---|
| **Supports idempotency keys + outcome query** | Query system by idempotency_key; returns success/failure. | ✅ **IF external system enforces** | Verifier returns APPLIED/NOT_APPLIED; reconciler commits/fails safely. Protocol provides deduplication infrastructure; external system must enforce idempotence. |
| **Idempotent but no outcome query** (e.g., K8s "create if not exists") | Verifier checks resource exists and matches expected state. | ✅ **IF idempotency is durable** | Verifier infers APPLIED if resource exists; NOT_APPLIED if absent. Depends on external system's idempotency implementation being durable across retries. |
| **No idempotency keys, but queryable state** (e.g., DNS CNAME change) | Verifier queries state; compares against expected outcome. | ⚠️ **Limited** | Works if state change is unique to this action; fragile if side effects are indistinguishable. Risk of false APPLIED if multiple actions produce same state. |
| **No idempotency, no query** (e.g., send email, fire webhook) | Verifier cannot determine outcome. | ❌ **NO** | Verifier returns UNKNOWN; action escalates; operator must investigate externally. No protocol-level deduplication possible. |

### Capability Requirements for Each Verdict

| Verdict | Requires | Example |
|---------|----------|---------|
| **APPLIED** | Idempotency key support + query API. Or: queryable state unique to this action. | "SELECT status FROM payment WHERE idempotency_key= AND status='COMPLETED'" |
| **NOT_APPLIED** | Idempotency key support + query API. Or: initial state queryable. | "SELECT status FROM payment WHERE idempotency_key=" returns NULL; confirms no attempt. |
| **UNKNOWN** | No verifiable evidence available. | System does not support idempotency keys; verifier cannot safely infer outcome. |

### Guarantees Provided by Phase 10F

**With external system supporting both idempotency keys and outcome queries**:
- ✅ Crash safety: All windows covered; verifier is source of truth; never blindly retries on UNKNOWN
- ✅ Deduplication infrastructure: Protocol ensures idempotency_key is passed consistently and verifier outcome is durable
- ⚠️ Exactly-once **requires**: External system must reliably enforce idempotency-key uniqueness and return deterministic outcomes
- ⚠️ Exactly-once **depends on**: Verifier correctly implementing the query (malformed queries may return false outcomes)

**With external system supporting idempotency keys but no outcome query** (e.g., K8s "create if not exists"):
- ✅ Crash safety: Verifier checks resource state; prevents blind retries
- ✅ At-least-once execution with deduplication: Repeats are safe if external system enforces idempotence
- ⚠️ Exactly-once **requires**: External system's idempotency mechanism to be durable and deterministic
- ⚠️ Requires: Careful verifier implementation to avoid false positives (resource exists but from different action)

**With external system supporting queryable state but no idempotency keys**:
- ✅ Crash safety: Verifier queries state; recovers correctly if state is unique to this action
- ⚠️ At-most-once (conservative): No deduplication; may escalate to UNKNOWN on recovery if state is ambiguous
- ❌ Exactly-once **not achievable**: Cannot distinguish this action's state from other concurrent actions' state

**With external system supporting neither idempotency nor queries**:
- ✅ Crash safety: Does not blindly retry; escalates to UNKNOWN for operator review
- ❌ At-most-once **not guaranteed**: Operator must resolve ambiguous outcomes manually
- ❌ Exactly-once **not achievable**: No protocol-level deduplication or verification possible

---

## Testing Plan

### Test Categories

#### 1. Effect-State Transitions
- NOT_STARTED → IN_PROGRESS (coordinator initiates external call)
- IN_PROGRESS → APPLIED (external call succeeds; verifier confirms)
- IN_PROGRESS → NOT_APPLIED (external call fails; verifier confirms)
- IN_PROGRESS → UNKNOWN (verifier cannot determine outcome)
- APPLIED → COMMITTED (phase 3 completes)
- NOT_APPLIED → FAILED (coordinator/reconciler marks failed)
- UNKNOWN → ESCALATED (reconciler escalates)

#### 2. Crash Windows
- **Window 1** (before external call): Crash after intend, before coordinator.execute(). Reconciler should call verifier; verify outcome.
- **Window 2** (during external call): Crash mid-flight. Reconciler claims lease, calls verifier; handles APPLIED/NOT_APPLIED/UNKNOWN.
- **Window 3** (after effect completes, before commit): Crash after effect_completed_at set, before status updated. Reconciler should skip verifier if verifier_response cached.
- **Window 4** (after commit): No recovery needed; idempotency check handles retry.

#### 3. Duplicate Delivery
- Submit same action twice concurrently: First INSERT wins; second reads existing row; both return same outcome.
- Retry after COMMITTED: Action returns AlreadyCommitted; outcome from previous execution.

#### 4. Concurrent Recovery Workers
- Multiple reconcilers claim same expired lease: First UPDATE wins via SKIP LOCKED and WHERE status='PENDING'; second is no-op.
- Both transition effect_state: First UPDATE succeeds; second is no-op (WHERE effect_state guard).
- Stale writes are prevented: Only first reconciler to claim action updates status.

#### 5. Stale Leases
- Lease expires while coordinator is idle: Reconciler claims and recovers.
- Lease expired but coordinator still holding: Reconciler claims via SKIP LOCKED; coordinator's next UPDATE fails gracefully (WHERE lease_owner=?).

#### 6. Real Subprocess Crash/Restart
- Coordinator in subprocess; subprocess killed mid-action: Parent process observes effect_state=IN_PROGRESS and status=PENDING; spawns reconciler; verifies outcome.
- Reconciler running in separate process: Can run continuously; recovers orphaned actions from dead siblings.

### Test Fixtures

**Mock Verifier**:
- Configurable to return APPLIED, NOT_APPLIED, or UNKNOWN
- Records all verify() calls for audit
- Supports simulating timeout (returns UNKNOWN after delay)

**Test Database**:
- Fresh actions table per test
- test_external_effects table for simulating external system state
- Migrations applied before each test

**Test Scenarios**:
`	ypescript
describe('Phase 10F: Effect States', () => {
  describe('Transitions', () => {
    it('NOT_STARTED → IN_PROGRESS', async () => {...});
    it('IN_PROGRESS → APPLIED', async () => {...});
    it('IN_PROGRESS → NOT_APPLIED', async () => {...});
    it('IN_PROGRESS → UNKNOWN', async () => {...});
    it('APPLIED → COMMITTED', async () => {...});
    it('NOT_APPLIED → FAILED', async () => {...});
    it('UNKNOWN → ESCALATED', async () => {...});
  });

  describe('Crash Windows', () => {
    it('Window 1: Before external call', async () => {...});
    it('Window 2: During external call', async () => {...});
    it('Window 3: After effect completes, before commit', async () => {...});
    it('Window 4: After commit; idempotency handles retry', async () => {...});
  });

  describe('Concurrent Recovery', () => {
    it('Multiple reconcilers; only first updates status', async () => {...});
    it('Stale worker prevented by SKIP LOCKED and WHERE guards', async () => {...});
  });

  describe('Real Process Crash', () => {
    it('Subprocess killed mid-action; parent recovers', async () => {...});
    it('Reconciler running in separate process recovers siblings', async () => {...});
  });
});
`

---

## Implementation Sequence

### Phase 1: Schema and Types
1. Apply migration 20240101000015 (effect_state columns, constraints, indexes)
2. Add EffectState enum to types.ts
3. Update Action interface to include effectState, effectStartedAt, effectCompletedAt, verifierResponse, verifiedAt
4. Update Verdict interface to include disposition string mapping

### Phase 2: ActionCoordinator Enhancement
1. Update intend() to set effect_state='NOT_STARTED' (automatic via DEFAULT)
2. Add updateEffectState() helper for safe transitions
3. Before execute() external call: transition effect_state→IN_PROGRESS
4. After successful external call: transition effect_state→APPLIED, call phase 3 commit
5. On external call failure: transition effect_state→NOT_APPLIED, mark status→FAILED
6. Add onEffectBegin() hook call (if verifier implements)
7. Add onEffectCompleted() hook call (if verifier implements)

### Phase 3: ActionReconciler Enhancement
1. Update reconcileOne() to read cached verifier_response (Window 3 optimization)
2. Add updateEffectState() helper for safe transitions
3. Route verifier dispositions to effect-state transitions:
   - APPLIED → updateEffectState(APPLIED) → commitRecovered()
   - NOT_APPLIED → updateEffectState(NOT_APPLIED) → markFailed()
   - UNKNOWN → updateEffectState(UNKNOWN) → escalate()
4. Add escalate() for UNKNOWN disposition (status→ESCALATED, leave action in place)

### Phase 4: Testing
1. Write Phase 10F test suite (state transitions, crash windows, concurrency)
2. Verify all 318 existing tests still pass
3. Add Phase 10F tests to CI/CD pipeline

---

## Design Questions and Decisions

### Q1: Should effect_state be a separate column or part of status?

**Decision**: **Separate columns**. Action status (PENDING | COMMITTED | FAILED | ESCALATED) is the overall lifecycle; effect_state (NOT_STARTED | IN_PROGRESS | APPLIED | NOT_APPLIED | UNKNOWN) tracks external-call progress. Separation enables:
- Clear semantics: status answers "is this action done?", effect_state answers "what happened to the external call?"
- Safe transitions: A crash during commit leaves effect_state=APPLIED (effect durable) but status=PENDING (commit not yet recorded); recovery recognizes this and re-commits
- Backward compatibility: Pre-existing COMMITTED/FAILED actions are mapped to effect_state={APPLIED,NOT_APPLIED} during migration


### Q1b: Why map existing FAILED actions to UNKNOWN instead of NOT_APPLIED?

**Decision**: **UNKNOWN is conservative**. A FAILED action only tells us the action eventually transitioned to FAILED status. It does NOT tell us:
- Did the original coordinator successfully call the external system?
- Did the external system receive and process the call?
- Did the coordinator crash before calling the verifier?

**Example**: Coordinator executes external call, the call succeeds, but the coordinator crashes before phase 3 commit. The action is left PENDING, and eventually times out and is reconciled. But if someone manually marked it FAILED (e.g., operator intervention), the action still has an uncertain external outcome.

**Conservative approach**: Map all pre-existing FAILED actions to effect_state=UNKNOWN; let the reconciler's verifier establish authoritative outcome. If the verifier cannot determine outcome, the action correctly escalates to operator review.

**Result**: No silent false assumptions about pre-existing FAILED actions; reconciler verifies ground truth before finalizing outcome.
### Q2: Should UNKNOWN trigger a retry with exponential backoff?

**Decision**: **No**. UNKNOWN means the outcome is genuinely indeterminate. Retrying:
- **Risk**: External system may have processed the request; retry causes duplicate execution
- **Mitigation**: Escalate to ESCALATED status; leave for human or secondary audit process to investigate
- **Rationale**: This is the core thesis of the exactly-once protocol: uncertainty must not become silent failure

### Q3: Should verifier cache be stored in verifier_response column?

**Decision**: **Yes, for Window 3 optimization**. If a crash occurs after the external effect completes but before phase 3 commit:
- Reconciler reads verifier_response (already cached)
- Skips redundant external system query
- Commits directly
- Result: Faster recovery, reduced external system load

### Q4: Should reconciler and coordinator share the same verifier instance?

**Decision**: **Yes, via VerifierRegistry**. Verifiers are stateless (or have immutable state). Sharing allows:
- Single source of truth for external system capabilities
- Consistent outcome assessment
- Easier testing and debugging

### Q5: What happens if an action is never escalated or resolved?

**Decision**: Operator must investigate and manually resolve:
- Query actions table: SELECT * FROM actions WHERE status='ESCALATED' OR (status='PENDING' AND resolved_at IS NULL)
- Review outcome column for verifier's reason
- Either mark FAILED or create a new action to retry

---

## Unresolved Design Questions

None at this time. All decisions documented above.

---

## Summary of Design Changes

| Artifact | Change |
|---|---|
| **Schema** | Add effect_state, effect_started_at, effect_completed_at, verifier_response, verified_at columns; add CHECK constraints; add indexes |
| **ActionCoordinator** | Before external call: transition effect_state→IN_PROGRESS; after: transition to APPLIED/NOT_APPLIED; phase 3 updates status |
| **ActionReconciler** | Read effect_state; route verifier disposition to transitions; escalate on UNKNOWN; skip verifier if cached |
| **Verifier** | Add hooks onEffectBegin(), onEffectCompleted(); distinguish UNKNOWN from errors |
| **Tests** | Add Phase 10F suite: state transitions, crash windows, concurrency, subprocess crashes |

---

## Backward Compatibility

✅ **Migration is additive**: No columns dropped; no constraints removed; pre-existing data preserved
✅ **Old code compatible**: Pre-Phase 10F code ignores effect_state columns; uses status column as before
✅ **Mixed deployments**: Old and new code can coexist; new reconciler gradually fills effect_state during recovery
✅ **No data loss**: All existing actions remain queryable and recoverable



