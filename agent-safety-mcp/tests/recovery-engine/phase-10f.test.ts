/**
 * Phase 10F Tests: Durable External-Effect Protocol
 * Tests effect-state transitions, crash windows, UNKNOWN handling, and concurrent recovery
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  installAfterEachCleanup,
  loadLiveDatabaseTestConfig,
  verifyLiveDatabaseTestIdentity,
} from "../helpers/live-db-guard";

const liveConfig = loadLiveDatabaseTestConfig();
const describeLive = liveConfig.enabled ? describe : describe.skip;
import { Pool } from "pg";
import { ActionCoordinator } from "../../src/recovery-engine/coordinator";
import { ActionReconciler } from "../../src/recovery-engine/reconciliation";
import {
  ActionDisposition,
  ActionState,
  EffectState,
  VerdictDisposition,
  Verdict,
  Action,
} from "../../src/recovery-engine/types";
import { ActionVerifier } from "../../src/recovery-engine/reconciliation";

const TEST_COORDINATOR_ID = "550e8400-e29b-41d4-a716-446655440000";
const TEST_EPISODE_IDS = ["episode-test-1", "episode-test-2", "episode-test-3"] as const;

// Mock Verifier for testing
class TestVerifier implements ActionVerifier {
  private responses: Map<string, Verdict> = new Map();
  private callCount: Map<string, number> = new Map();

  registerResponse(idemKey: string, verdict: Verdict): void {
    this.responses.set(idemKey, verdict);
  }

  getCallCount(idemKey: string): number {
    return this.callCount.get(idemKey) || 0;
  }

  resetCalls(): void {
    this.callCount.clear();
  }

  async verify(action: Action): Promise<Verdict> {
    const count = (this.callCount.get(action.idemKey) || 0) + 1;
    this.callCount.set(action.idemKey, count);

    const verdict = this.responses.get(action.idemKey);
    if (!verdict) {
      return {
        disposition: VerdictDisposition.Unknown,
        externalRef: "",
        outcome: {},
        reason: "no response registered for this action",
      };
    }
    return verdict;
  }

  async getEffect?(actionType: string, actionArgs: any): Promise<any> {
    return undefined;
  }
}

// Mock Embedder
class TestEmbedder {
  readonly identity = { provider: "test", model: "test-1024" };

  async embed(text: string): Promise<number[]> {
    return new Array(1024).fill(0);
  }
}

// Helper to ensure test agents exist
async function ensureTestAgent(db: Pool, agentId: string, key: string): Promise<void> {
  try {
    await db.query(
      `INSERT INTO agents (id, key, name, metadata) 
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [agentId, key, `test-${key}`, { testAgent: true }]
    );
  } catch (e) {
    // Ignore if agent already exists or other error
  }
}

// Helper to ensure test episodes exist
async function ensureTestEpisode(db: Pool, episodeId: string): Promise<void> {
  try {
    await db.query(
      `INSERT INTO episodes (episode_id, narrative, outcome, status) 
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (episode_id) DO NOTHING`,
      [episodeId, `Test episode for ${episodeId}`, "test", "pending"]
    );
  } catch (e) {
    // Ignore if episode already exists
  }
}


// Helper to clean up test data
async function cleanupTestData(db: Pool): Promise<void> {
  if (!liveConfig.enabled || !liveConfig.identity) {
    throw new Error("Refusing Phase 10F cleanup without a verified isolated test database");
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await verifyLiveDatabaseTestIdentity(client, liveConfig);
    const dependents = await client.query(
      `SELECT count(*)::int AS count FROM (
         SELECT ae.id
           FROM action_evidence ae JOIN actions a ON a.id = ae.action_id
          WHERE a.action_type = $1 AND a.agent_id = $2 AND a.episode_id = ANY($3::text[])
         UNION ALL
         SELECT te.id
           FROM test_external_effects te JOIN actions a ON a.id = te.action_id
          WHERE a.action_type = $1 AND a.agent_id = $2 AND a.episode_id = ANY($3::text[])
         UNION ALL
         SELECT arv.action_id
           FROM action_resource_versions arv JOIN actions a ON a.idempotency_key = arv.action_id
          WHERE a.action_type = $1 AND a.agent_id = $2 AND a.episode_id = ANY($3::text[])
       ) AS fixture_dependents`,
      ["test-action", TEST_COORDINATOR_ID, [...TEST_EPISODE_IDS]]
    );
    if (Number(dependents.rows[0]?.count ?? 0) !== 0) {
      throw new Error("Refusing to clean Phase 10F actions with associated evidence or resource records");
    }
    await client.query(
      `DELETE FROM actions
        WHERE action_type = $1 AND agent_id = $2
          AND episode_id = ANY($3::text[])`,
      ["test-action", TEST_COORDINATOR_ID, [...TEST_EPISODE_IDS]]
    );
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* connection may already be aborted */ }
    throw error;
  } finally {
    client.release();
  }
}
describeLive("Phase 10F: Effect-State Transitions", () => {
  let db: Pool;
  let coordinator: ActionCoordinator;
  let reconciler: ActionReconciler;
  let verifier: TestVerifier;
  let databaseIdentityVerified = false;

  const TEST_AGENT_IDS = {
    coordinator: TEST_COORDINATOR_ID,
    reconciler: "550e8400-e29b-41d4-a716-446655440001",
  };

  beforeEach(async () => {
    const dbUrl = liveConfig.databaseUrl;
    if (!dbUrl) {
      console.warn("RUN_LIVE_DB_TESTS=1 and TEST_DATABASE_URL are required; skipping Phase 10F tests");
      return;
    }

    db = new Pool({ connectionString: dbUrl });
    databaseIdentityVerified = false;
    await verifyLiveDatabaseTestIdentity(db, liveConfig);
    databaseIdentityVerified = true;
    await cleanupTestData(db);

        // Ensure test agents exist
    await ensureTestAgent(db, TEST_AGENT_IDS.coordinator, "test-coordinator");
    await ensureTestAgent(db, TEST_AGENT_IDS.reconciler, "test-reconciler");
        await ensureTestEpisode(db, "episode-test-1");
    await ensureTestEpisode(db, "episode-test-2");
    await ensureTestEpisode(db, "episode-test-3");

    coordinator = new ActionCoordinator(db, TEST_AGENT_IDS.coordinator, 120);
    verifier = new TestVerifier();
    reconciler = new ActionReconciler(
      db,
      coordinator,
      verifier,
      new TestEmbedder(),
      TEST_AGENT_IDS.reconciler,
      120
    );
  });

  installAfterEachCleanup(afterEach, async () => {
    if (!db) return;
    try {
      if (databaseIdentityVerified) await cleanupTestData(db);
    } finally {
      await db.end();
      db = undefined as unknown as Pool;
      databaseIdentityVerified = false;
    }
  });

  it("should initialize action with effect_state=NOT_STARTED", async () => {
    const result = await coordinator.intend(
      "episode-test-1",
      "test-action",
      { param: "value" }
    );

    expect(result.disposition).toBe(ActionDisposition.Owned);
    const action = result.action;
    expect(action.effectState).toBe("NOT_STARTED");
    expect(action.effectStartedAt).toBeUndefined();
  });

  it("should transition effect_state: NOT_STARTED ? IN_PROGRESS ? APPLIED", async () => {
    const result = await coordinator.intend(
      "episode-test-2",
      "test-action",
      { param: "value" }
    );
    const idemKey = result.action.idemKey;

    // Transition to IN_PROGRESS
    const inProgress = await coordinator.updateEffectState(
      idemKey,
      "IN_PROGRESS",
      "NOT_STARTED"
    );
    expect(inProgress).toBe(true);

    // Verify IN_PROGRESS
    let action = await coordinator.load(idemKey);
    expect(action?.effectState).toBe("IN_PROGRESS");
    expect(action?.effectStartedAt).toBeDefined();

    // Transition to APPLIED
    const applied = await coordinator.updateEffectState(
      idemKey,
      "APPLIED",
      "IN_PROGRESS",
      { externalRef: "ext-1", outcome: { success: true } }
    );
    expect(applied).toBe(true);

    // Verify APPLIED
    action = await coordinator.load(idemKey);
    expect(action?.effectState).toBe("APPLIED");
    expect(action?.effectCompletedAt).toBeDefined();
  });

  it("should prevent stale transitions with WHERE guards", async () => {
    const result = await coordinator.intend(
      "episode-test-3",
      "test-action",
      { param: "value" }
    );
    const idemKey = result.action.idemKey;

    // Transition to IN_PROGRESS
    await coordinator.updateEffectState(
      idemKey,
      "IN_PROGRESS",
      "NOT_STARTED"
    );

    // Try to transition from wrong state (should fail)
    const stale = await coordinator.updateEffectState(
      idemKey,
      "APPLIED",
      "NOT_STARTED"
    );
    expect(stale).toBe(false);

    // Verify state unchanged
    const action = await coordinator.load(idemKey);
    expect(action?.effectState).toBe("IN_PROGRESS");
  });
});


















