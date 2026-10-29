/**
 * Actions Module - Exactly-once protocol implementation
 */

export {
  ActionDisposition,
  dispositionToString,
  ActionState,
  type ActionStateValue,
  VerdictDisposition,
  verdictDispositionToString,
  type Action,
  type Verdict as ActionVerdict,  // Rename to avoid conflict with core.Verdict
  type Receipt,
  type WorldEffect,
  type AtomicCommit,
  type MemoryWrite,
  type ReconciliationStats,
  AmbiguousCommitError,
} from "./types";
export * from "./idempotency";
export { ActionCoordinator } from "./coordinator";
export { ActionReconciler, ActionVerifier, Embedder } from "./reconciliation";
export {
  VerifierRegistry,
  ProductionActionVerifierDispatcher,
  getVerifierRegistry,
  setVerifierRegistry,
  resetVerifierRegistry,
} from "./verifier_registry";


