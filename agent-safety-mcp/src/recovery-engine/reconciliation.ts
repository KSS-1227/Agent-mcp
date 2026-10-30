/**
 * Reconciliation - Handles crash recovery and orphaned intents
 * Ported from Anchor Go reconcile.go
 */

import { Pool } from "pg";
import { Action, ActionState, EffectState, ReconciliationStats, VerdictDisposition, Verdict, verdictDispositionToString } from "./types";
import { ActionCoordinator } from "./coordinator";
import { recordRecoveryFailure, recordRecoveryPass, setRecoveryRuntimeHealth } from "../health/recovery-runtime";
import type { EmbeddingIdentity } from "./embedding-identity";
import { GITHUB_CREATE_ISSUE, githubMarker } from "./github-issue";

export const CLAIM_EXPIRED = `
WITH claimable AS (
  SELECT idempotency_key
    FROM actions
   WHERE status = 'PENDING' AND lease_expires_at < now()
     AND coalesce(effect_state, 'NOT_STARTED') <> 'UNKNOWN'
   ORDER BY lease_expires_at
   LIMIT $3
   FOR UPDATE SKIP LOCKED
)
UPDATE actions ai
   SET lease_owner = $1,
       lease_expires_at = now() + $2::INTERVAL,
       attempts = attempts + 1
  FROM claimable c
 WHERE ai.idempotency_key = c.idempotency_key
RETURNING ai.idempotency_key, ai.episode_id, ai.agent_id, ai.action_type, ai.arguments,
          ai.status, ai.lease_owner, ai.lease_expires_at,
          coalesce(ai.external_reference, ''), ai.outcome, ai.attempts,
          ai.created_at, ai.resolved_at,
          coalesce(ai.effect_state, 'NOT_STARTED') as effect_state,
          ai.effect_started_at, ai.effect_completed_at, ai.verifier_response, ai.verified_at`;

export const CLAIM_ACTION = `
UPDATE actions
   SET lease_owner = $2,
       lease_expires_at = now() + $3::INTERVAL,
       attempts = attempts + 1
 WHERE idempotency_key = $1
   AND status = 'PENDING'
   AND (lease_expires_at IS NULL OR lease_expires_at <= now())
RETURNING idempotency_key`;

const MARK_FAILED_SQL = `
UPDATE actions
   SET status = 'FAILED', outcome = $2, resolved_at = now(), lease_owner = NULL
 WHERE idempotency_key = $1 AND status = 'PENDING'
   AND effect_state = 'NOT_APPLIED'
   AND lease_owner = $3 AND lease_expires_at > now()`;

export const MARK_UNKNOWN_SQL = `
UPDATE actions
   SET effect_state = 'UNKNOWN', verifier_response = 'UNKNOWN', verified_at = now(),
       effect_completed_at = coalesce(effect_completed_at, now()), outcome = $2,
       lease_owner = NULL, lease_expires_at = NULL
 WHERE idempotency_key = $1 AND status = 'PENDING'
   AND lease_owner = $3 AND lease_expires_at > now()
   AND coalesce(effect_state, 'NOT_STARTED') = $4`;

const PENDING_OLDER_THAN = `
SELECT idempotency_key, episode_id, agent_id, action_type, arguments, status,
       lease_owner, lease_expires_at, coalesce(external_reference, ''), outcome, attempts,
       created_at, resolved_at,
       coalesce(effect_state, 'NOT_STARTED') as effect_state,
       effect_started_at, effect_completed_at, verifier_response, verified_at
  FROM actions
 WHERE status = 'PENDING' AND created_at < now() - $1::INTERVAL
 ORDER BY created_at`;

/**
 * External verifier interface - implemented by adapters for different systems
 */
export interface ActionVerifier {
  verify(action: Action): Promise<Verdict>;
  getEffect?(actionType: string, actionArgs: any): Promise<any>;
}

/**
 * Embedder interface for converting text to vectors
 */
export interface Embedder {
  readonly identity: EmbeddingIdentity;
  embed(text: string): Promise<number[]>;
}

export const EPISODE_EMBEDDING_DIMENSIONS = 1024;

function hasValidVerifierEvidence(verdict: Verdict): boolean {
  return (
    verdict !== null &&
    typeof verdict === "object" &&
    (verdict.disposition === VerdictDisposition.Applied ||
      verdict.disposition === VerdictDisposition.NotApplied ||
      verdict.disposition === VerdictDisposition.Unknown) &&
    typeof verdict.externalRef === "string" &&
    typeof verdict.outcome === "object" &&
    verdict.outcome !== null &&
    !Array.isArray(verdict.outcome) &&
    typeof verdict.reason === "string" &&
    verdict.reason.trim().length > 0
  );
}

/**
 * ActionReconciler resolves intents abandoned by processes that died mid-action.
 *
 * This is the component that makes the exactly-once claim true rather than
 * aspirational. Retrying an external call gets you at-least-once. What gets you
 * exactly-once is that every abandoned intent is settled by asking the external
 * system what actually happened, and that the answer commits in the same
 * transaction as the memory describing it.
 *
 * The reconciler never re-executes an action. It only observes and records.
 */
export class ActionReconciler {
  private leaseTTL: number; // in seconds
  private batch: number = 32;
  private loopTimer?: ReturnType<typeof setInterval>;
  private loopStart?: Promise<void>;
  private activePass?: Promise<void>;

  constructor(
    private db: Pool,
    private coordinator: ActionCoordinator,
    private verifier: ActionVerifier,
    private embedder: Embedder,
    private agentId: string,
    leaseTTLSeconds: number = 120
  ) {
    this.leaseTTL = leaseTTLSeconds;
  }

  /**
   * claimExpired atomically takes ownership of intents whose lease has lapsed.
   *
   * SKIP LOCKED is what makes running several reconcilers safe: a row already
   * locked by a peer is passed over rather than blocking this scan. Without it,
   * two reconcilers serialize behind each other and a single slow verification
   * stalls every other recovery.
   */
  private async claimExpired(): Promise<Action[]> {
    const result = await this.db.query(CLAIM_EXPIRED, [
      this.agentId,
      `${this.leaseTTL} seconds`,
      this.batch,
    ]);

    return result.rows.map((row) => ({
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
    }));
  }

  /**
   * RunOnce performs a single reconciliation pass.
   */
  async runOnce(): Promise<ReconciliationStats> {
    const claimed = await this.claimExpired();
    const stats: ReconciliationStats = {
      claimed: claimed.length,
      committed: 0,
      failed: 0,
      escalated: 0,
    };

    for (const action of claimed) {
      await this.reconcileOne(action);
    }

    // Recount from the database to reflect committed status
    for (const action of claimed) {
      const current = await this.coordinator.load(action.idemKey);
      if (current) {
        switch (current.status) {
          case ActionState.Committed:
            stats.committed++;
            break;
          case ActionState.Failed:
            stats.failed++;
            break;
          default:
            stats.escalated++;
        }
      }
    }

    return stats;
  }

  /** Atomically claim and reconcile one explicitly selected orphaned action. */
  async reconcileAction(idemKey: string): Promise<boolean> {
    const claim = await this.db.query(CLAIM_ACTION, [
      idemKey,
      this.agentId,
      `${this.leaseTTL} seconds`,
    ]);
    if ((claim.rowCount ?? 0) === 0) return false;

    const action = await this.coordinator.load(idemKey);
    if (!action) throw new Error(`Action disappeared after lease claim: ${idemKey}`);

    await this.reconcileOne(action);
    return true;
  }

  /**
   * reconcileOne settles a single abandoned intent against external ground truth.
   * Phase 10F: Transitions effect_state based on verifier disposition, then updates action status.
   */
  private async reconcileOne(action: Action): Promise<void> {
    let observedEffectState = action.effectState || EffectState.InProgress;
    try {
      // Phase 10F: Window 3 optimization - if effect already completed and verifier_response cached, skip re-query
      let verdict: Verdict;
      const hasCompletedEffect = action.effectCompletedAt && (action.effectState === 'APPLIED' || action.effectState === 'NOT_APPLIED');
      
      if (hasCompletedEffect && action.verifierResponse) {
        // Use cached verifier response; skip external system query
        verdict = {
          disposition: action.verifierResponse as VerdictDisposition,
          externalRef: action.externalRef,
          outcome: action.outcome || {},
          reason: `cached verifier response from ${action.verifiedAt?.toISOString()}`,
        };
      } else {
        // Call verifier for ground truth
        verdict = await this.verifier.verify(action);
      }

      if (!hasValidVerifierEvidence(verdict)) {
        throw new Error("Verifier returned invalid evidence");
      }

      // Actions with an executor-owned start transition can still be NOT_STARTED
      // when their lease expires before execution begins. Preserve that observed
      // state as the compare-and-set source during recovery.
      switch (verdict.disposition) {
        case VerdictDisposition.Applied:
        {
          if (!action.episodeId?.trim()) {
            throw new Error("Recovery cannot be committed because the action has no episode ID");
          }
          // Prepare and validate the memory write before marking the external
          // effect APPLIED. The persisted episodes.embedding column is vector(1024).
          const narrative = this.recoveredNarrative(action, verdict);
          const embedding = await this.embedder.embed(narrative);
          const identity = this.embedder?.identity;
          if (!identity || typeof identity.provider !== "string" || typeof identity.model !== "string") {
            throw new Error("Recovery embedder did not provide embedding provenance");
          }
          const { provider, model } = identity;
          if (!provider?.trim() || !model?.trim()) {
            throw new Error("Recovery embedder did not provide embedding provenance");
          }
          if (
            !Array.isArray(embedding) ||
            embedding.length !== EPISODE_EMBEDDING_DIMENSIONS ||
            !embedding.every((value) => typeof value === "number" && Number.isFinite(value))
          ) {
            throw new Error(
              `Episode embedder must return ${EPISODE_EMBEDDING_DIMENSIONS} finite dimensions`
            );
          }
          const worldEffect = this.verifier.getEffect
            ? await this.verifier.getEffect(action.actionType, action.actionArgs)
            : undefined;
          // Update effect_state → APPLIED if not already
          if (action.effectState !== 'APPLIED') {
            const updated = await this.updateEffectState(
              action.idemKey,
              EffectState.Applied,
              observedEffectState
            );
            if (!updated) throw new Error("Could not transition effect state to APPLIED");
            observedEffectState = EffectState.Applied;
          }
          // Commit the recovered action
          await this.commitRecovered(action, verdict, narrative, embedding, { provider, model }, worldEffect);
          break;
        }

        case VerdictDisposition.NotApplied:
          // Update effect_state → NOT_APPLIED
          if (action.effectState !== 'NOT_APPLIED') {
            const updated = await this.updateEffectState(
              action.idemKey,
              EffectState.NotApplied,
              observedEffectState
            );
            if (!updated) throw new Error("Could not transition effect state to NOT_APPLIED");
            observedEffectState = EffectState.NotApplied;
          }
          // Mark action as FAILED
          await this.markFailed(action, verdict.reason);
          break;

        case VerdictDisposition.Unknown:
          // The schema has no ESCALATED status. Park UNKNOWN actions as PENDING
          // with no lease so the background loop does not retry them indefinitely.
          await this.markUnknown(action, verdict.reason, observedEffectState);
          return;

        default:
          await this.markUnknown(
            action,
            `Unknown verifier disposition: ${verdict.disposition}`,
            observedEffectState
          );
          return;
      }
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : String(error);
      // Failures stay unresolved and are parked for explicit manual review.
      await this.markUnknown(action, `Recovery attempt failed: ${reason}`, observedEffectState);
    }
  }

  /**
   * Phase 10F: updateEffectState transitions effect_state safely.
   */
  private async updateEffectState(
    idemKey: string,
    targetState: string,
    fromState?: string,
    data?: { verifierResponse?: string }
  ): Promise<boolean> {
    let updateSql = `UPDATE actions SET effect_state = $2`;
    const params: any[] = [idemKey, targetState];
    let paramIndex = 3;

    // Set verified_at and verifier_response when transitioning to terminal effect states
    if (targetState === 'UNKNOWN') {
      updateSql += `, verified_at = now(), verifier_response = $${paramIndex}`;
      params.push(data?.verifierResponse || 'UNKNOWN');
      paramIndex++;
    } else if (targetState === 'APPLIED' || targetState === 'NOT_APPLIED') {
      updateSql += `, effect_completed_at = now()`;
      if (data?.verifierResponse) {
        updateSql += `, verified_at = now(), verifier_response = $${paramIndex}`;
        params.push(data.verifierResponse);
        paramIndex++;
      }
    }

    updateSql += ` WHERE idempotency_key = $1 AND status = 'PENDING'`;
    if (fromState) {
      updateSql += ` AND effect_state = $${paramIndex}`;
      params.push(fromState);
      paramIndex++;
    }
    updateSql += ` AND lease_owner = $${paramIndex} AND lease_expires_at > now()`;
    params.push(this.agentId);

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
   * commitRecovered writes the memory of an action that a dead process performed.
   *
   * The narrative deliberately records that recovery happened. That is not
   * bookkeeping noise: it is the truthful account of the incident.
   */
  private recoveredNarrative(action: Action, verdict: Verdict): string {
    return (
      `Action ${action.actionType} was verified as applied after the originating process failed ` +
      `before recording it. Recovered by reconciler on attempt ${action.attempts}. ` +
      `Evidence: ${verdict.reason}`
    );
  }

  private async commitRecovered(
    action: Action,
    verdict: Verdict,
    narrative: string,
    embedding: number[],
    embeddingIdentity: EmbeddingIdentity,
    worldEffect?: any
  ): Promise<void> {
    const externalRef = verdict.externalRef || action.externalRef;

    await this.coordinator.commitAtomic({
      idemKey: action.idemKey,
      leaseOwner: this.agentId,
      receipt: {
        externalRef,
        outcome: { status: "success" as const, ...verdict.outcome },
      },
      ...(action.actionType === GITHUB_CREATE_ISSUE
        ? {
            evidenceWrite: {
              source: action.actionType,
              evidenceType: "verified_external_effect",
              externalReference: externalRef,
              payload: {
                // Persist the stable label, never the enum ordinal: evidence is an
                // audited record that must stay readable on its own.
                disposition: verdictDispositionToString(verdict.disposition),
                reason: verdict.reason,
                outcome: verdict.outcome,
                correlationMarker: githubMarker(action),
              },
            },
          }
        : {}),
      worldEffect,
      memoryWrite: {
        episodeId: action.episodeId,
        narrative,
        outcome: "recovered",
        embedding,
        embeddingProvider: embeddingIdentity.provider,
        embeddingModel: embeddingIdentity.model,
      },
    });
  }

  /**
   * markFailed marks an intent that was verified as not applied.
   */
  private async markFailed(action: Action, reason: string): Promise<void> {
    const payload = JSON.stringify({
      disposition: VerdictDisposition.NotApplied,
      reason,
    });

    const result = await this.db.query(MARK_FAILED_SQL, [
      action.idemKey,
      payload,
      this.agentId,
    ]);

    if ((result.rowCount ?? 0) === 0) {
      throw new Error(`Could not mark action ${action.idemKey} failed`);
    }

    console.warn(
      `Intent verified as not applied, surfacing to operator: ${action.idemKey} (${action.actionType})`
    );
  }

  /**
   * Record an indeterminate recovery in the supported PENDING state and release
   * the lease; automatic recovery does not claim UNKNOWN actions again.
   * 
   */
  private async markUnknown(action: Action, reason: string, expectedEffectState: string): Promise<void> {
    const payload = JSON.stringify({
      disposition: VerdictDisposition.Unknown,
      reason,
      attempts: action.attempts,
      needs_operator: true,
      last_unknown_at: new Date().toISOString(),
    });

    try {
      const result = await this.db.query(MARK_UNKNOWN_SQL, [
        action.idemKey,
        payload,
        this.agentId,
        expectedEffectState,
      ]);
      if ((result.rowCount ?? 0) === 0) {
        console.warn(
          `Recovery unresolved for ${action.idemKey} (${action.actionType}): could not record UNKNOWN because lease, status, or effect state changed`
        );
        return;
      }
      console.warn(
        `Recovery parked as PENDING/UNKNOWN for ${action.idemKey} (${action.actionType}); automatic retry disabled: ${reason}`
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(
        `Recovery remains unresolved for ${action.idemKey} (${action.actionType}); failed to record UNKNOWN: ${detail}`
      );
    }
  }

  /**
   * Run reconciles on startup and then on a timer until stopped.
   *
   * The startup pass matters as much as the timer: a process that crashed
   * mid-action leaves an intent that nothing else will notice.
   */
  async run(intervalSeconds: number = 30): Promise<() => Promise<void>> {
    if (!this.loopStart) {
      setRecoveryRuntimeHealth({ state: "starting", enabled: true, lastPassAt: null, lastPass: null, failure: false });
      this.loopStart = (async () => {
        const stats = await this.runOnce();
        recordRecoveryPass(stats);
        this.logStats(stats);
        this.loopTimer = setInterval(() => {
          if (this.activePass) return;
          setRecoveryRuntimeHealth({ state: "running" });
          this.activePass = this.runOnce()
            .then((result) => { recordRecoveryPass(result); this.logStats(result); })
            .catch((error) => {
              recordRecoveryFailure();
              console.error("Reconciliation pass failed:", error instanceof Error ? error.message : String(error));
            })
            .finally(() => {
              this.activePass = undefined;
            });
        }, intervalSeconds * 1000);
      })();
    }

    try {
      await this.loopStart;
    } catch (error) {
      this.loopStart = undefined;
      throw error;
    }
    return () => this.stop();
  }

  async stop(): Promise<void> {
    if (this.loopTimer) {
      clearInterval(this.loopTimer);
      this.loopTimer = undefined;
    }
    await this.activePass;
    setRecoveryRuntimeHealth({ state: "disabled", enabled: false });
  }

  private logStats(stats: ReconciliationStats): void {
    if (stats.claimed > 0) {
      console.log(
        `Reconciliation pass complete: claimed=${stats.claimed}, committed=${stats.committed}, failed=${stats.failed}, unresolved=${stats.escalated}`
      );
    }
  }

  /**
   * PendingOlderThan lists unresolved intents older than a given age.
   */
  async pendingOlderThan(ageSeconds: number): Promise<Action[]> {
    const result = await this.db.query(PENDING_OLDER_THAN, [
      `${ageSeconds} seconds`,
    ]);

    return result.rows.map((row) => ({
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
    }));
  }
}
