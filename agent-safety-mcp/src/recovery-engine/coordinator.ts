/**
 * Coordinator - Phase 1, 2, and 3 of the exactly-once protocol
 * Ported from Anchor Go intent.go
 */

import { Pool, PoolClient } from "pg";
import { validate as validateUUID } from "uuid";
import { StepStatus } from "../conflict-engine/types";
import { generateIdempotencyKey, canonicalJson } from "./idempotency";
import {
  Action,
  ActionDisposition,
  ActionState,
  AtomicCommit,
  MemoryWrite,
  Receipt,
} from "./types";

const INSERT_INTENT = `
INSERT INTO actions (idempotency_key, episode_id, agent_id, action_type, arguments,
                            status, lease_owner, lease_expires_at, attempts)
VALUES ($1, $2, $3, $4, $5, 'PENDING', $3, now() + $6::INTERVAL, 1)
ON CONFLICT (idempotency_key) DO NOTHING
RETURNING idempotency_key`;

const SELECT_INTENT = `
SELECT idempotency_key, episode_id, agent_id, action_type, arguments, status,
       lease_owner, lease_expires_at, coalesce(external_reference, ''), outcome, attempts,
       created_at, resolved_at,
       coalesce(effect_state, 'NOT_STARTED') as effect_state,
       effect_started_at, effect_completed_at, verifier_response, verified_at
  FROM actions
 WHERE idempotency_key = $1`;

const RESOLVE_INTENT = `
UPDATE actions
   SET status = 'COMMITTED', external_reference = $2, outcome = $3,
       resolved_at = now(), lease_owner = NULL,
       effect_state = 'APPLIED', effect_completed_at = now()
 WHERE idempotency_key = $1 AND status = 'PENDING'
   AND lease_owner = $4 AND lease_expires_at > now()
   AND effect_state = 'IN_PROGRESS'
RETURNING idempotency_key, episode_id`;

const FAIL_INTENT = `
UPDATE actions
   SET status = 'FAILED', external_reference = $2, outcome = $3,
       resolved_at = now(), lease_owner = NULL,
       effect_state = 'NOT_APPLIED', effect_completed_at = now()
 WHERE idempotency_key = $1 AND status = 'PENDING'
   AND lease_owner = $4 AND lease_expires_at > now()
   AND effect_state = 'IN_PROGRESS'
RETURNING idempotency_key`;

// UNKNOWN: caller cannot confirm whether the effect occurred. Leave PENDING so
// the reconciler can query external ground truth. Never transitions to terminal.
const UNKNOWN_INTENT = `
UPDATE actions
   SET effect_state = 'UNKNOWN', outcome = $2, effect_completed_at = now()
 WHERE idempotency_key = $1 AND status = 'PENDING'
   AND lease_owner = $3 AND lease_expires_at > now()
   AND effect_state = 'IN_PROGRESS'
RETURNING idempotency_key`;

const RESOLVE_RECOVERED_INTENT = `
UPDATE actions
   SET status = 'COMMITTED', external_reference = $2, outcome = $3,
       resolved_at = now(), lease_owner = NULL
 WHERE idempotency_key = $1 AND status = 'PENDING'
   AND effect_state = 'APPLIED'
   AND lease_owner = $4 AND lease_expires_at > now()`;

// A retried recovery is accepted only when the unique action row records the
// exact recovery receipt and episode identity supplied by the retry.
const SELECT_COMMITTED_RECOVERY = `
SELECT idempotency_key, episode_id
  FROM actions
 WHERE idempotency_key = $1 AND status = 'COMMITTED'
   AND effect_state = 'APPLIED' AND external_reference = $2
   AND outcome = $3::jsonb AND episode_id = $4
 FOR UPDATE`;

const SELECT_RECOVERY_MEMORY = `
SELECT narrative, outcome, status
  FROM episodes
 WHERE episode_id = $1 AND status = 'resolved' AND outcome = $2
   AND narrative = $3 AND embedding = $4::vector
 FOR UPDATE`;

const MUTATE_CLUSTER = `
UPDATE managed_clusters
   SET desired_nodes = COALESCE($2, desired_nodes),
       last_action = $3,
       version = version + 1
 WHERE cluster_id = $1`;

const WRITE_MEMORY = `
UPDATE episodes
   SET narrative = $2, outcome = $3, embedding = $4,
       status = 'resolved', expires_at = NULL
 WHERE episode_id = $1`;

// The lifecycle rows an action stands for are locked before they are inspected.
// Locking is what makes the validation below meaningful: two concurrent
// completions serialize on the row, so the state that was read is the state that
// is written, and a rejected row aborts the whole transaction rather than
// leaving the action committed next to an unrepaired step.
const LOCK_EPISODE = `
SELECT status FROM episodes WHERE episode_id = $1 FOR UPDATE`;

// A completed action resolves the episode it was prepared under. episodes.outcome
// is a VARCHAR(50) and every existing writer stores a short status word there
// ('pending' at prepare, 'recovered' after reconciliation), so the completed
// status word is recorded rather than the receipt JSON, which stays on the
// action row. The write is skipped for an episode that is already resolved so a
// replay cannot replace what an earlier writer (including recovery) recorded.
const RESOLVE_EPISODE = `
UPDATE episodes
   SET status = 'resolved', outcome = $2, updated_at = now()
 WHERE episode_id = $1 AND status <> 'resolved'`;

// intent_steps.id is the primary key, and the row must still belong to the intent
// encoded in the episode id, so a step id can never complete a row of another
// intent.
const LOCK_INTENT_STEP = `
SELECT status, intent_id FROM intent_steps WHERE id = $1::uuid FOR UPDATE`;

const COMPLETE_INTENT_STEP = `
UPDATE intent_steps
   SET status = $3, updated_at = now()
 WHERE id = $1::uuid AND intent_id = $2::uuid AND status <> $3`;

/**
 * lock_timeout aborts the current statement with SQLSTATE 55P03. Treat it as a
 * failed authorization rather than an effect start.
 */
function isLockTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "55P03"
  );
}

/**
 * Split the deterministic episode id written by prepare_action (intent:step)
 * back into the keys it encodes. The episode id is the only link between an
 * action and the step it executes, so anything that does not carry exactly two
 * UUIDs yields no keys and the caller leaves both lifecycle tables untouched:
 * a malformed or partial id must never be used as a key that could match an
 * unrelated row.
 */
function parseEpisodeId(
  episodeId: unknown
): { episodeId: string; intentId: string; stepId: string } | null {
  if (typeof episodeId !== "string") return null;
  const parts = episodeId.split(":");
  if (parts.length !== 2) return null;
  const [intentId, stepId] = parts;
  if (!validateUUID(intentId) || !validateUUID(stepId)) return null;
  return { episodeId, intentId, stepId };
}

/**
 * ActionCoordinator runs the three-phase exactly-once protocol.
 */
export class ActionCoordinator {
  private leaseTTL: number; // in seconds

  constructor(
    private db: Pool,
    private agentId: string,
    leaseTTLSeconds: number = 120
  ) {
    this.leaseTTL = leaseTTLSeconds;
  }

  /**
   * Intend runs phase 1. It records the durable intent to act before any external
   * call happens, which is what makes recovery possible at all: a crash after this
   * point leaves evidence that the action may be in flight.
   *
   * The insert is the deduplication primitive. ON CONFLICT DO NOTHING means exactly
   * one caller receives a row back; every other caller falls through to reading the
   * existing row and branching on its status.
   */
  async intend(
    episodeId: string,
    actionType: string,
    actionArgs: any
  ): Promise<{ action: Action; disposition: ActionDisposition }> {
    try {
      const canonArgs = canonicalJson(actionArgs).toString('utf-8');
      const idemKey = generateIdempotencyKey(episodeId, actionType, actionArgs);

      const result = await this.db.query(INSERT_INTENT, [
        idemKey,
        episodeId,
        this.agentId,
        actionType,
        canonArgs,
        `${this.leaseTTL} seconds`,
      ]);

      if ((result.rowCount ?? 0) > 0) {
        // We inserted it, so we own the lease and may execute.
        return {
          action: {
            idemKey,
            episodeId,
            agentId: this.agentId,
            actionType,
            actionArgs: typeof actionArgs === "string" ? JSON.parse(actionArgs) : actionArgs,
            status: ActionState.Pending,
            leaseOwner: this.agentId,
            attempts: 1,
            externalRef: "",
            outcome: {},
            effectState: "NOT_STARTED",
            effectStartedAt: undefined,
          },
          disposition: ActionDisposition.Owned,
        };
      }

      // Someone else got there first. Read their row and decide.
      return this.inspectExisting(episodeId, actionType, actionArgs);
    } catch (error) {
      throw new Error(`Phase 1 failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Atomically create the action and copy the intent's original read set. */
  async intendWithResourceSnapshot(
    episodeId: string,
    intentId: string,
    actionType: string,
    actionArgs: any
  ): Promise<{ action: Action; disposition: ActionDisposition }> {
    const canonArgs = canonicalJson(actionArgs).toString("utf-8");
    const idemKey = generateIdempotencyKey(episodeId, actionType, actionArgs);
    const client = await this.db.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      const reads = await client.query(
        `SELECT resource_id, observed_version FROM intent_reads WHERE intent_id = $1 ORDER BY resource_id`,
        [intentId]
      );
      const inserted = await client.query(INSERT_INTENT, [
        idemKey, episodeId, this.agentId, actionType, canonArgs, `${this.leaseTTL} seconds`,
      ]);
      if ((inserted.rowCount ?? 0) > 0) {
        for (const read of reads.rows) {
          await client.query(
            `INSERT INTO action_resource_versions (action_id, resource_id, observed_version)
             VALUES ($1, $2, $3)`,
            [idemKey, read.resource_id, read.observed_version]
          );
        }
        await client.query("COMMIT");
        return {
          action: {
            idemKey, episodeId, agentId: this.agentId, actionType,
            actionArgs: typeof actionArgs === "string" ? JSON.parse(actionArgs) : actionArgs,
            status: ActionState.Pending, leaseOwner: this.agentId,
            leaseExpires: new Date(Date.now() + this.leaseTTL * 1000), attempts: 1,
            externalRef: "", outcome: {}, effectState: "NOT_STARTED",
          },
          disposition: ActionDisposition.Owned,
        };
      }
      await client.query("ROLLBACK");
      return this.inspectExisting(episodeId, actionType, actionArgs);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw new Error(`Phase 1 snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      client.release();
    }
  }

  /**
   * Compare the immutable action snapshot with current persisted resource
   * versions. This is a read-only diagnostic; authorizeEffectStart is the
   * authoritative gate used before an external effect starts.
   */
  async validateResourceSnapshot(idemKey: string): Promise<void> {
    const snapshot = await this.db.query(
      `SELECT arv.resource_id, arv.observed_version, r.version AS current_version
         FROM action_resource_versions arv
         LEFT JOIN resources r ON r.id = arv.resource_id
        WHERE arv.action_id = $1 ORDER BY arv.resource_id`,
      [idemKey]
    );
    const expected = await this.db.query(
      `SELECT count(*)::int AS count FROM intent_reads ir
        WHERE ir.intent_id = (SELECT split_part(episode_id, ':', 1)::uuid FROM actions WHERE idempotency_key = $1)`,
      [idemKey]
    );
    if (snapshot.rows.length !== Number(expected.rows[0]?.count ?? 0)) {
      throw new Error("Action dependency snapshot is missing");
    }
    for (const row of snapshot.rows) {
      if (row.current_version == null || Number(row.current_version) !== Number(row.observed_version)) {
        throw new Error(`Action dependency is missing or stale: ${row.resource_id}`);
      }
    }
  }

  /**
   * authorizeEffectStart is the linearization point between resource writes and
   * the start of an external effect.
   *
   * It locks every dependency row in ascending resource ID order, compares the
   * fresh persisted versions with the immutable action snapshot, and performs
   * the NOT_STARTED -> IN_PROGRESS transition in the same short READ COMMITTED
   * transaction. The transaction commits and the client is released before the
   * caller runs any external executor, so no lock is held across the request.
   *
   * Lock timeout, database errors, missing/stale/incomplete snapshots, and a
   * failed conditional update all fail closed: the transaction rolls back and
   * no effect is authorized.
   */
  async authorizeEffectStart(
    idemKey: string,
    expectedLeaseOwner: string
  ): Promise<void> {
    if (!expectedLeaseOwner) {
      throw new Error("Expected lease owner is required to authorize an effect");
    }

    const client = await this.db.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query("SET LOCAL lock_timeout = '2000ms'");

      const snapshotResult = await client.query(
        `SELECT resource_id, observed_version FROM action_resource_versions WHERE action_id = $1 ORDER BY resource_id`,
        [idemKey]
      );
      // Sort defensively: lock order must not depend on the planner or driver.
      const snapshot = [...snapshotResult.rows].sort((left, right) =>
        left.resource_id < right.resource_id
          ? -1
          : left.resource_id > right.resource_id
            ? 1
            : 0
      );

      // Compare the snapshot with the intent read set by identity, not by size:
      // a count alone would accept a snapshot that swapped one dependency for
      // another and would leave the real dependency unlocked. intent_reads is
      // insert-only, so both sides are stable for the life of the action.
      const expectedResult = await client.query(
        `WITH snapshot AS (
           SELECT resource_id FROM action_resource_versions WHERE action_id = $1
         ), reads AS (
           SELECT resource_id FROM intent_reads
            WHERE intent_id = (SELECT split_part(episode_id, ':', 1)::uuid FROM actions WHERE idempotency_key = $1)
         )
         SELECT
           (SELECT count(*)::int FROM (SELECT resource_id FROM snapshot EXCEPT SELECT resource_id FROM reads) AS missing) +
           (SELECT count(*)::int FROM (SELECT resource_id FROM reads EXCEPT SELECT resource_id FROM snapshot) AS extra) AS difference`,
        [idemKey]
      );
      const completeness = expectedResult.rows[0];
      if (!completeness || Number(completeness.difference) !== 0) {
        throw new Error(
          "Action dependency snapshot does not match the intent read set"
        );
      }

      for (const row of snapshot) {
        const locked = await client.query(
          `SELECT version FROM resources WHERE id = $1 FOR UPDATE`,
          [row.resource_id]
        );
        if (
          locked.rows.length === 0 ||
          Number(locked.rows[0].version) !== Number(row.observed_version)
        ) {
          throw new Error(
            `Action dependency is missing or stale: ${row.resource_id}`
          );
        }
      }

      const started = await client.query(
        `UPDATE actions
            SET effect_state = 'IN_PROGRESS', effect_started_at = now()
          WHERE idempotency_key = $1
            AND status = 'PENDING'
            AND effect_state = 'NOT_STARTED'
            AND lease_owner = $2
            AND lease_expires_at > clock_timestamp()
          RETURNING idempotency_key`,
        [idemKey, expectedLeaseOwner]
      );
      if ((started.rowCount ?? 0) === 0) {
        throw new Error("Action is not awaiting execution under a live lease");
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (isLockTimeout(error)) {
        throw new Error(
          `Effect start authorization timed out waiting for a resource lock: ${idemKey}`
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * inspectExisting branches on the status of an intent another actor already owns.
   */
  private async inspectExisting(
    episodeId: string,
    actionType: string,
    actionArgs: any
  ): Promise<{ action: Action; disposition: ActionDisposition }> {
    const idemKey = generateIdempotencyKey(episodeId, actionType, actionArgs);
    const action = await this.load(idemKey);

    if (!action) {
      return {
        action: {
          idemKey,
          episodeId,
          agentId: this.agentId,
          actionType,
          actionArgs: typeof actionArgs === "string" ? JSON.parse(actionArgs) : actionArgs,
          status: ActionState.Failed,
          externalRef: "",
          outcome: {},
          attempts: 0,
        },
        disposition: ActionDisposition.Failed,
      };
    }

    switch (action.status) {
      case ActionState.Committed: {
        // The action already happened and was verified. Return the recorded
        // outcome. Executing again here is precisely the double-action this
        // protocol exists to prevent.
        return {
          action,
          disposition: ActionDisposition.AlreadyCommitted,
        };
      }

      case ActionState.Failed: {
        return {
          action,
          disposition: ActionDisposition.Failed,
        };
      }

      case ActionState.Pending: {
        const now = new Date();
        if (
          action.leaseExpires &&
          action.leaseExpires.getTime() > now.getTime()
        ) {
          // Another agent is actively working this action.
          return {
            action,
            disposition: ActionDisposition.Busy,
          };
        }

        // The lease lapsed, so the owning process is presumed dead. We must not
        // simply take over and execute: the dead process may have already made
        // the external call. Only the reconciler, which queries ground truth,
        // may resolve this.
        return {
          action,
          disposition: ActionDisposition.Orphaned,
        };
      }

      default:
        throw new Error(
          `Intent ${idemKey} has unrecognized status ${action.status}`
        );
    }
  }

  /**
   * Load reads a single intent by key.
   */
  async load(idemKey: string): Promise<Action | null> {
    try {
      const result = await this.db.query(SELECT_INTENT, [idemKey]);

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      return {
        idemKey: row.idempotency_key,
        episodeId: row.episode_id,
        agentId: row.agent_id,
        actionType: row.action_type,
        actionArgs: typeof row.arguments === "string" ? JSON.parse(row.arguments) : row.arguments,
        status: row.status,
        leaseOwner: row.lease_owner,
        leaseExpires: row.lease_expires_at ? new Date(row.lease_expires_at) : undefined,
        externalRef: row.coalesce,
        outcome: typeof row.outcome === "string" ? JSON.parse(row.outcome) : row.outcome,
        attempts: row.attempts,
        createdAt: row.created_at ? new Date(row.created_at) : undefined,
        resolvedAt: row.resolved_at ? new Date(row.resolved_at) : undefined,
        effectState: row.effect_state,
        effectStartedAt: row.effect_started_at ? new Date(row.effect_started_at) : undefined,
        effectCompletedAt: row.effect_completed_at ? new Date(row.effect_completed_at) : undefined,
        verifierResponse: row.verifier_response,
        verifiedAt: row.verified_at ? new Date(row.verified_at) : undefined,
      };
    } catch (error) {
      throw new Error(`Failed to load intent: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Complete phase 3 for an externally executed action.
   *
   * receipt.outcome.status drives the state transition:
   *   "success"  → COMMITTED / APPLIED  (effect confirmed applied)
   *   "failed"   → FAILED / NOT_APPLIED (effect confirmed not applied)
   *   "unknown"  → stays PENDING, effect_state=UNKNOWN (reconciler resolves)
   *
   * The conditional UPDATE is the atomic deduplication primitive. Concurrent
   * callers can only commit a PENDING action once. Later callers observe and
   * return the committed outcome rather than replacing it.
   */
  async complete(
    idemKey: string,
    receipt: Receipt
  ): Promise<{ action: Action; alreadyCommitted: boolean }> {
    try {
      const outcomeStatus = receipt.outcome.status;

      // Unknown outcome: leave PENDING, set effect_state=UNKNOWN for reconciler.
      if (outcomeStatus === "unknown") {
        const result = await this.db.query(UNKNOWN_INTENT, [
          idemKey,
          JSON.stringify(receipt.outcome),
          this.agentId,
        ]);
        if ((result.rowCount ?? 0) > 0) {
          const action = await this.load(idemKey);
          if (!action) throw new Error(`Action disappeared after unknown completion: ${idemKey}`);
          return { action, alreadyCommitted: false };
        }
        // UPDATE matched nothing — check why
        const existing = await this.load(idemKey);
        if (!existing) throw new Error(`Action not found: ${idemKey}`);
        if (existing.status === ActionState.Committed) return { action: existing, alreadyCommitted: true };
        if (existing.status === ActionState.Failed) {
          throw new Error(
            `Cannot complete action: action is in FAILED state. Manual operator intervention required.`
          );
        }
        throw new Error(
          `Action ${idemKey} could not be marked unknown (not pending, effect not in progress, or caller does not hold a valid lease)`
        );
      }

      const failedReceipt = outcomeStatus === "failed";
      const result = await this.db.query(
        failedReceipt ? FAIL_INTENT : RESOLVE_INTENT,
        [
          idemKey,
          receipt.externalRef,
          JSON.stringify(receipt.outcome),
          this.agentId,
        ]
      );

      if ((result.rowCount ?? 0) > 0) {
        const action = await this.load(idemKey);
        if (!action) {
          throw new Error(`Action disappeared after completion: ${idemKey}`);
        }
        return { action, alreadyCommitted: false };
      }

      const existing = await this.load(idemKey);
      if (!existing) {
        throw new Error(`Action not found: ${idemKey}`);
      }
      if (existing.status === ActionState.Committed) {
        return { action: existing, alreadyCommitted: true };
      }
      if (existing.status === ActionState.Failed) {
        throw new Error(
          `Cannot complete action: action is in FAILED state. Manual operator intervention required.`
        );
      }

      throw new Error(
        `Action ${idemKey} could not be completed (not pending, effect not in progress, or caller does not hold a valid lease)`
      );
    } catch (error) {
      throw new Error(
        `Failed to complete action: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Complete a successful action and converge the lifecycle rows it stands for.
   *
   * A success commits the action, resolves its episode and marks its intent step
   * done in one transaction. Writing the lifecycle rows separately would let the
   * action become COMMITTED while the step stayed pending and the episode stayed
   * open with nothing to repair it; because all three writes share one
   * transaction, a failure in either lifecycle write rolls the action commit back
   * and the caller can retry against an action that is still PENDING.
   *
   * Failed and unknown outcomes never touch the step or the episode: they are
   * delegated to complete() unchanged, which also preserves the existing replay
   * contract for those outcomes. A replayed success (the action was already
   * COMMITTED before this call) still converges the lifecycle rows, in its own
   * transaction, so a retry repairs a step or episode left behind by an older
   * commit path. The parent intent is never touched here.
   */
  async completeWithLifecycle(
    idemKey: string,
    receipt: Receipt
  ): Promise<{ action: Action; alreadyCommitted: boolean }> {
    if (receipt.outcome.status !== "success") {
      return this.complete(idemKey, receipt);
    }

    let committed = false;
    try {
      const client = await this.db.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");

        const resolved = await client.query(RESOLVE_INTENT, [
          idemKey,
          receipt.externalRef,
          JSON.stringify(receipt.outcome),
          this.agentId,
        ]);
        committed = (resolved.rowCount ?? 0) > 0;

        if (committed) {
          await this.convergeLifecycle(
            client,
            resolved.rows[0]?.episode_id,
            receipt.outcome.status
          );
        } else {
          // This call did not transition the action. If an earlier call (or
          // recovery) already committed it, converge what that commit left
          // behind; the action row itself stays untouched because the
          // conditional update above matched nothing.
          const current = await client.query(SELECT_INTENT, [idemKey]);
          const existing = current.rows[0];
          if (existing?.status === ActionState.Committed) {
            await this.convergeLifecycle(
              client,
              existing.episode_id,
              receipt.outcome.status
            );
          }
        }

        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }

      const action = await this.load(idemKey);
      if (!action) {
        throw new Error(`Action not found: ${idemKey}`);
      }
      if (committed) {
        return { action, alreadyCommitted: false };
      }
      if (action.status === ActionState.Committed) {
        return { action, alreadyCommitted: true };
      }
      if (action.status === ActionState.Failed) {
        throw new Error(
          `Cannot complete action: action is in FAILED state. Manual operator intervention required.`
        );
      }

      throw new Error(
        `Action ${idemKey} could not be completed (not pending, effect not in progress, or caller does not hold a valid lease)`
      );
    } catch (error) {
      throw new Error(
        `Failed to complete action: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Converge the episode and step rows an action stands for.
   *
   * A well-formed episode id names exactly one episode and one step, so either
   * row missing means the action cannot be accounted for and the caller's
   * transaction is aborted. A step that belongs to a different intent, or that a
   * conflict invalidated, is refused for the same reason: completing it would
   * record work that the conflict machinery decided must not happen. A step that
   * is already done is a no-op, which makes a repeated completion converge
   * instead of failing.
   *
   * An absent, partial or non-UUID episode id resolves to no keys and neither
   * table is touched, preserving behaviour for legacy action rows that predate
   * the intent:step convention.
   */
  private async convergeLifecycle(
    tx: Pick<PoolClient, "query">,
    episodeId: unknown,
    outcomeStatus: string
  ): Promise<void> {
    const ids = parseEpisodeId(episodeId);
    if (!ids) {
      return;
    }

    // All validation happens before either write, so a rejected row never needs
    // the rollback to hide a half-converged lifecycle.
    const episode = await tx.query(LOCK_EPISODE, [ids.episodeId]);
    const episodeRow = episode.rows[0];
    if (!episodeRow) {
      throw new Error(
        `Episode ${ids.episodeId} does not exist; refusing to commit the action against it`
      );
    }

    const step = await tx.query(LOCK_INTENT_STEP, [ids.stepId]);
    const stepRow = step.rows[0];
    if (!stepRow) {
      throw new Error(
        `Intent step ${ids.stepId} does not exist; refusing to commit the action against it`
      );
    }
    if (String(stepRow.intent_id).toLowerCase() !== ids.intentId.toLowerCase()) {
      throw new Error(
        `Intent step ${ids.stepId} belongs to intent ${stepRow.intent_id}, not ${ids.intentId}`
      );
    }
    if (stepRow.status === StepStatus.INVALIDATED) {
      throw new Error(
        `Intent step ${ids.stepId} was invalidated by a conflict and cannot be completed`
      );
    }
    if (
      stepRow.status !== StepStatus.DONE &&
      stepRow.status !== StepStatus.PENDING &&
      stepRow.status !== StepStatus.REPAIRED
    ) {
      throw new Error(
        `Intent step ${ids.stepId} is in state ${stepRow.status} and cannot be completed`
      );
    }

    // An episode the recovery path already resolved keeps its own outcome and
    // narrative; only a still-open episode records the completed status word.
    if (episodeRow.status !== "resolved") {
      await tx.query(RESOLVE_EPISODE, [ids.episodeId, outcomeStatus]);
    }

    if (stepRow.status !== StepStatus.DONE) {
      await tx.query(COMPLETE_INTENT_STEP, [
        ids.stepId,
        ids.intentId,
        StepStatus.DONE,
      ]);
    }
  }

  /**
   * CommitAtomic runs phase 3: the intent resolution, the world-status mutation, and
   * the memory write with its embedding, in one serializable transaction.
   *
   * This single transaction is the thesis. If the memory write were a second
   * transaction, or lived in a separate vector database, it could fail alone and
   * leave the agent's history disagreeing with what it actually did.
   */
  async commitAtomic(commit: AtomicCommit): Promise<void> {
    const maxAttempts = 8;

    for (let attempt = 1; ; attempt++) {
      const client = await this.db.connect();
      try {
        await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");

        // Prepare outcome and external ref
        let outcome: any = {};
        let externalRef = "";

        if (commit.receipt) {
          outcome = commit.receipt.outcome;
          externalRef = commit.receipt.externalRef;
        }

        // If no outcome, use empty object (schema CHECK requires evidence)
        if (!outcome || Object.keys(outcome).length === 0) {
          outcome = {};
        }

        // Resolve intent
        const resolveResult = await client.query(RESOLVE_RECOVERED_INTENT, [
          commit.idemKey,
          externalRef,
          JSON.stringify(outcome),
          commit.leaseOwner,
        ]);

        if (resolveResult.rowCount === 0) {
          const committed = await client.query(SELECT_COMMITTED_RECOVERY, [
            commit.idemKey,
            externalRef,
            JSON.stringify(outcome),
            commit.memoryWrite.episodeId,
          ]);
          if (committed.rows.length === 0 || commit.worldEffect) {
            throw new Error(
              `Intent ${commit.idemKey} was no longer PENDING at commit time`
            );
          }

          const memory = await client.query(SELECT_RECOVERY_MEMORY, [
            commit.memoryWrite.episodeId,
            commit.memoryWrite.outcome,
            commit.memoryWrite.narrative,
            JSON.stringify(commit.memoryWrite.embedding),
          ]);
          if (!memory.rows[0]) {
            throw new Error(
              `Committed recovery ${commit.idemKey} does not match its persisted memory`
            );
          }

          // The original transaction committed all of these writes atomically;
          // verify rather than rewrite memory on an ambiguous-acknowledgment retry.
          await this.convergeLifecycle(
            client,
            commit.memoryWrite.episodeId,
            "success"
          );
          await client.query("COMMIT");
          return;
        }

        // Mutate cluster/world status if provided
        if (commit.worldEffect) {
          await client.query(MUTATE_CLUSTER, [
            commit.worldEffect.clusterId,
            commit.worldEffect.desiredNodes,
            commit.worldEffect.lastAction,
          ]);
        }

        // Write memory with embedding
        const memoryResult = await client.query(WRITE_MEMORY, [
          commit.memoryWrite.episodeId,
          commit.memoryWrite.narrative,
          commit.memoryWrite.outcome,
          JSON.stringify(commit.memoryWrite.embedding),
        ]);
        if ((memoryResult.rowCount ?? 0) === 0) {
          throw new Error(`Episode ${commit.memoryWrite.episodeId} does not exist; recovery memory was not written`);
        }

        // Recovery converged the same lifecycle rows a caller-driven commit
        // does, in this transaction: WRITE_MEMORY has already resolved the
        // episode with the 'recovered' outcome, so only the pending step is
        // left to complete. A step that cannot be completed aborts the memory
        // write too, and the serialization retry re-runs the whole unit.
        await this.convergeLifecycle(client, commit.memoryWrite.episodeId, "success");

        await client.query("COMMIT");
        return;
      } catch (error) {
        await client.query("ROLLBACK");

        const errorMsg =
          error instanceof Error ? error.message : String(error);

        // Check if retryable (serialization error)
        if (errorMsg.includes("40001") || errorMsg.includes("SERIALIZABLE")) {
          if (attempt >= maxAttempts) {
            throw new Error(
              `Phase 3: gave up after ${attempt} serialization retries: ${errorMsg}`
            );
          }

          // Exponential backoff
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(100 * Math.pow(2, attempt - 1), 5000))
          );
          continue;
        }

        throw new Error(`Phase 3: ${errorMsg}`);
      } finally {
        client.release();
      }
    }
  }
  /**
   * updateEffectState safely transitions effect_state to a new value.
   * Phase 10F: NOT_STARTED ? IN_PROGRESS ? {APPLIED, NOT_APPLIED, UNKNOWN}
   */
  async updateEffectState(
    idemKey: string,
    targetState: string,
    fromState?: string,
    data?: { externalRef?: string; outcome?: any; completedAt?: boolean },
    expectedLeaseOwner?: string
  ): Promise<boolean> {
    let updateSql = `UPDATE actions SET effect_state = $2`;
    const params: any[] = [idemKey, targetState];
    let paramIndex = 3;

    // Add effect_started_at when transitioning to IN_PROGRESS
    if (targetState === "IN_PROGRESS") {
      updateSql += `, effect_started_at = now()`;
    }

    // Add effect_completed_at and other fields when transitioning to terminal effect state
    if (targetState === "APPLIED" || targetState === "NOT_APPLIED") {
      updateSql += `, effect_completed_at = now()`;
      if (data?.externalRef) {
        updateSql += `, external_reference = $${paramIndex}`;
        params.push(data.externalRef);
        paramIndex++;
      }
      if (data?.outcome) {
        updateSql += `, outcome = $${paramIndex}`;
        params.push(JSON.stringify(data.outcome));
        paramIndex++;
      }
    }

    // Add WHERE clause
    updateSql += ` WHERE idempotency_key = $1`;
    if (fromState) {
      updateSql += ` AND effect_state = $${paramIndex}`;
      params.push(fromState);
      paramIndex++;
    }
    updateSql += ` AND status = 'PENDING'`;
    if (expectedLeaseOwner) {
      updateSql += ` AND lease_owner = $${paramIndex} AND lease_expires_at > now()`;
      params.push(expectedLeaseOwner);
    }

    try {
      const result = await this.db.query(updateSql, params);
      return (result.rowCount ?? 0) > 0;
    } catch (error) {
      throw new Error(
        `Failed to update effect_state for ${idemKey}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * updateActionStatus transitions action status from PENDING to a terminal state.
   * Phase 10F: Uses effect_state guard to prevent stale updates.
   */
  async updateActionStatus(
    idemKey: string,
    targetStatus: string,
    expectedEffectState?: string,
    outcome?: Record<string, any>
  ): Promise<boolean> {
    let updateSql = `UPDATE actions SET status = $2, lease_owner = NULL, resolved_at = now()`;
    const params: any[] = [idemKey, targetStatus];
    let paramIndex = 3;

    if (outcome) {
      updateSql += `, outcome = $${paramIndex}`;
      params.push(JSON.stringify(outcome));
      paramIndex++;
    }

    updateSql += ` WHERE idempotency_key = $1 AND status = 'PENDING'`;

    if (expectedEffectState) {
      updateSql += ` AND effect_state = $${paramIndex}`;
      params.push(expectedEffectState);
      paramIndex++;
    }

    try {
      const result = await this.db.query(updateSql, params);
      return (result.rowCount ?? 0) > 0;
    } catch (error) {
      throw new Error(
        `Failed to update action status for ${idemKey}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}



