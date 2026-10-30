/**
 * Action Protocol Types - ported from Anchor Go
 * These types model the exactly-once action protocol
 */

/**
 * Disposition is the result of phase 1. It tells the caller whether it may
 * proceed to phase 2, and if not, why not.
 */
export enum ActionDisposition {
  /**
   * Owned means this process inserted the intent and holds a live lease.
   * It is the only disposition that permits executing the external call.
   */
  Owned = 0,

  /**
   * AlreadyCommitted means an identical action already completed and was verified.
   * The recorded outcome is returned and nothing is executed. This is the
   * deduplication path that makes a retried request safe.
   */
  AlreadyCommitted = 1,

  /**
   * Busy means another agent holds a live lease on this exact action.
   * The caller backs off and re-reads rather than racing it.
   */
  Busy = 2,

  /**
   * Orphaned means a PENDING intent exists whose lease has expired: some process
   * began this action and died. The external world may or may not have changed.
   * Only the reconciler may resolve it, because resolving it requires querying
   * the external system for ground truth.
   */
  Orphaned = 3,

  /**
   * Failed means a previous attempt was verified as not applied, or could not
   * be resolved. It is surfaced to an operator and never silently retried.
   */
  Failed = 4,
}

export function dispositionToString(d: ActionDisposition): string {
  switch (d) {
    case ActionDisposition.Owned:
      return "OWNED";
    case ActionDisposition.AlreadyCommitted:
      return "ALREADY_COMMITTED";
    case ActionDisposition.Busy:
      return "BUSY";
    case ActionDisposition.Orphaned:
      return "ORPHANED";
    case ActionDisposition.Failed:
      return "FAILED";
    default:
      return "UNKNOWN";
  }
}

/**
 * State values for actions.status. These are persisted, so the strings
 * are part of the on-disk contract and must not be renamed casually.
 */
export const ActionState = {
  Pending: "PENDING",
  Committed: "COMMITTED",
  Failed: "FAILED",
  Escalated: "ESCALATED",
} as const;

export type ActionStateValue = (typeof ActionState)[keyof typeof ActionState];

/**
 * EffectState tracks the external-effect progress independent of action status.
 * NOT_STARTED -> IN_PROGRESS -> {APPLIED, NOT_APPLIED, UNKNOWN}
 */
export const EffectState = {
  NotStarted: "NOT_STARTED",
  InProgress: "IN_PROGRESS",
  Applied: "APPLIED",
  NotApplied: "NOT_APPLIED",
  Unknown: "UNKNOWN",
} as const;

export type EffectStateValue = (typeof EffectState)[keyof typeof EffectState];

export function effectStateToString(state: EffectStateValue): string {
  return state;
}

/**
 * Verdict disposition from external verification.
 * Returned by verifiers to indicate whether an action was applied.
 */
export enum VerdictDisposition {
  /**
   * Applied: the external system confirms the action happened
   */
  Applied = 0,

  /**
   * NotApplied: the external system confirms the action did not happen
   */
  NotApplied = 1,

  /**
   * Unknown: insufficient evidence; escalate to human
   */
  Unknown = 2,
}

/**
 * Stable label for a verdict disposition.
 *
 * Persisted evidence records this label rather than the numeric enum so a stored
 * payload stays readable and keeps its meaning even if enum ordinals ever change.
 * Rows written before that change hold the ordinal, so numbers and already-mapped
 * labels normalize to the same label when read back.
 */
export function verdictDispositionToString(
  value: VerdictDisposition | string | number | null | undefined
): string {
  if (typeof value === "string") {
    const label = value.trim().toUpperCase();
    return label === "APPLIED" || label === "NOT_APPLIED" || label === "UNKNOWN"
      ? label
      : "UNKNOWN";
  }
  switch (value) {
    case VerdictDisposition.Applied:
      return "APPLIED";
    case VerdictDisposition.NotApplied:
      return "NOT_APPLIED";
    case VerdictDisposition.Unknown:
      return "UNKNOWN";
    default:
      return "UNKNOWN";
  }
}

/**
 * Action represents a row of actions in the database.
 */
export interface Action {
  idemKey: string;
  episodeId: string;
  agentId: string;
  actionType: string;
  actionArgs: Record<string, any>;
  status: ActionStateValue;
  leaseOwner?: string;
  leaseExpires?: Date;
  externalRef: string;
  outcome: Record<string, any>;
  attempts: number;
  createdAt?: Date;
  resolvedAt?: Date;
  
  // Phase 10F: Effect-state tracking
  effectState?: EffectStateValue;
  effectStartedAt?: Date;
  effectCompletedAt?: Date;
  verifierResponse?: VerdictDisposition | null;
  verifiedAt?: Date | null;
}

/**
 * Verdict from external verification of an action.
 */
export interface Verdict {
  disposition: VerdictDisposition;
  externalRef: string;
  outcome: Record<string, any>;
  reason: string;
}

/**
 * Receipt from external action execution.
 *
 * outcome.status distinguishes three cases:
 *   "success"  — the external effect is confirmed applied. Routes to COMMITTED/APPLIED.
 *   "failed"   — the external effect is confirmed NOT applied (e.g. API returned 4xx,
 *                rollback confirmed). Routes to FAILED/NOT_APPLIED.
 *   "unknown"  — the outcome cannot be confirmed (e.g. network timeout, partial response,
 *                no acknowledgement). The action remains PENDING with effect_state=UNKNOWN
 *                so the reconciler can query external ground truth. Never use "unknown"
 *                when you have positive evidence of success or failure.
 *
 * Callers MUST NOT use "failed" for uncertain outcomes. Use "unknown" instead.
 */
export interface Receipt {
  externalRef: string;
  outcome: Record<string, any> & { status: "success" | "failed" | "unknown" };
}

/**
 * WorldEffect describes the state mutation caused by an action.
 */
export interface WorldEffect {
  clusterId?: string;
  desiredNodes?: number;
  lastAction: string;
}

/**
 * Commit describes everything phase 3 writes in a single transaction.
 */
export interface AtomicCommit {
  idemKey: string;
  leaseOwner: string;
  receipt?: Receipt;
  worldEffect?: WorldEffect;
  memoryWrite: MemoryWrite;
  /** Verifier evidence to persist in the same transaction as recovered state. */
  evidenceWrite?: ActionEvidenceWrite;
}

export interface ActionEvidenceWrite {
  source: string;
  evidenceType: string;
  externalReference: string;
  payload: Record<string, unknown>;
}

/**
 * MemoryWrite is the episode mutation that commits alongside the action.
 */
export interface MemoryWrite {
  episodeId: string;
  narrative: string;
  outcome: string;
  embedding: number[];
  embeddingProvider: string;
  embeddingModel: string;
}

/**
 * ReconcilationStats summarizes one reconciliation pass.
 */
export interface ReconciliationStats {
  claimed: number;
  committed: number;
  failed: number;
  escalated: number;
}

/**
 * AmbiguousCommitError signals that phase 3 may or may not have committed.
 */
export class AmbiguousCommitError extends Error {
  constructor(
    public idemKey: string,
    cause: Error
  ) {
    super(
      `phase 3 commit ambiguous for intent ${idemKey}, routing to reconciler: ${cause.message}`
    );
    this.name = "AmbiguousCommitError";
  }
}
