import type { ReconciliationStats } from "../recovery-engine/types";

export type RecoveryRuntimeState = "disabled" | "starting" | "running" | "idle" | "error";
export interface RecoveryRuntimeHealth {
  state: RecoveryRuntimeState;
  enabled: boolean;
  productionVerifierCount: number;
  lastPassAt: string | null;
  lastPass: ReconciliationStats | null;
  failure: boolean;
  observedAt: string;
}

let current: RecoveryRuntimeHealth = {
  state: "starting", enabled: false, productionVerifierCount: 0,
  lastPassAt: null, lastPass: null, failure: false, observedAt: new Date().toISOString(),
};

export function setRecoveryRuntimeHealth(update: Partial<RecoveryRuntimeHealth>): void {
  current = { ...current, ...update, observedAt: new Date().toISOString() };
}

export function recordRecoveryPass(stats: ReconciliationStats): void {
  current = {
    ...current, state: "idle", enabled: true, lastPassAt: new Date().toISOString(),
    lastPass: { claimed: stats.claimed, committed: stats.committed, failed: stats.failed, escalated: stats.escalated },
    failure: false,
    observedAt: new Date().toISOString(),
  };
}

export function recordRecoveryFailure(): void {
  current = { ...current, state: "error", enabled: true, lastPassAt: new Date().toISOString(), lastPass: null, failure: true, observedAt: new Date().toISOString() };
}

export function getRecoveryRuntimeHealth(): RecoveryRuntimeHealth {
  return { ...current, lastPass: current.lastPass ? { ...current.lastPass } : null };
}
