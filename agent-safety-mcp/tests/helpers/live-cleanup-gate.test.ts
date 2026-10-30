import { describe, expect, it, vi } from "vitest";
import {
  LIVE_FIXTURE_DELETE_ORDER,
  deleteExactMissingStep,
  formatLiveCleanupUnresolved,
  reportLiveFixtureResidue,
  runLiveFixtureCleanup,
  withLiveCleanupClient,
  type LiveCleanupClient,
  type LiveCleanupPool,
  type LiveCleanupQueryable,
  type LiveFixturePlan,
} from "./live-db-guard";

interface Call { sql: string; params?: unknown[] }

const plan: LiveFixturePlan = {
  namespace: "test:live-recovery:1b4e28ba-2fa1-11d2-883f-0016d3cca427",
  agentIds: ["agent-actor", "agent-reconciler"], intentIds: ["intent-1"],
  stepIds: ["step-1"], episodeIds: ["intent-1:step-1"], actionKeys: ["action-1"],
};
const granted = { liveEnabled: true, cleanupAuthorized: true, identityVerified: true, preflightPassed: true };
const absentCascadeTables = ["tasks", "auth_users", "intent_reads", "conflicts", "action_resource_versions"];
const tableFrom = (sql: string): string => /(?:FROM|DELETE FROM)\s+(\w+)/i.exec(sql)?.[1] ?? "unknown";
const isDelete = (sql: string): boolean => /^\s*DELETE\s+FROM/i.test(sql);
const isCount = (sql: string): boolean => /count\(\*\)/i.test(sql);

interface FakeOptions {
  identityError?: boolean; schemaError?: boolean; unowned?: { table: string; id: string }[];
  cascade?: { table: string; id: string }[]; omitIds?: string[];
  episodeNarratives?: Record<string, string>;
  dependents?: { table: string; id: string; action_key: string }[];
  dependentQueryError?: string;
  deleteCount?: (table: string, ids: string[]) => number; deleteError?: string;
  rollbackError?: boolean; residue?: (table: string) => number;
}

function fakeClient(options: FakeOptions = {}) {
  const calls: Call[] = [];
  let released: boolean | undefined;
  const client: LiveCleanupClient = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      const table = tableFrom(sql);
      if (sql === "SELECT identity recheck" && options.identityError) throw new Error("identity mismatch");
      if (sql === "SELECT schema recheck" && options.schemaError) throw new Error("schema mismatch");
      if (sql === "ROLLBACK" && options.rollbackError) throw new Error("rollback failed");
      if ((sql.includes("FROM action_evidence") || sql.includes("FROM test_external_effects")) && options.dependentQueryError === table) {
        throw new Error(`${table} dependent query failed`);
      }
      if (isDelete(sql)) {
        if (options.deleteError === table) throw new Error("delete denied");
        const ids = params?.[0] as string[];
        return { rowCount: options.deleteCount?.(table, ids) ?? ids.length, rows: [] };
      }
      if (isCount(sql)) return { rows: [{ remaining: options.residue?.(table) ?? 0 }] };
      if (sql.includes("FROM action_evidence") || sql.includes("FROM test_external_effects")) {
        return { rows: (options.dependents ?? []).filter((row) => row.table === table).map(({ id, action_key }) => ({ id, action_key })) };
      }
      if (sql.includes("FROM tasks") || sql.includes("FROM auth_users") || sql.includes("FROM intent_reads") || sql.includes("FROM conflicts") || sql.includes("FROM action_resource_versions")) {
        return { rows: (options.cascade ?? []).filter((row) => row.table === table).map(({ id }) => ({ id })) };
      }
      if (sql.includes("SELECT id, intent_id")) {
        const provenIntents = params?.[1] as string[];
        return { rows: (params?.[0] as string[]).filter((id) => !options.omitIds?.includes(id)).map((id) => ({ id, intent_id: "intent-1", owned: provenIntents.includes("intent-1") && !options.unowned?.some((row) => row.table === table && row.id === id) })) };
      }
      if (sql.includes("metadata->>'purpose'")) {
        const provenAgents = params?.[1] as string[];
        return { rows: (params?.[0] as string[]).filter((id) => !options.omitIds?.includes(id)).map((id) => ({ id, owned: provenAgents.includes("agent-actor") && !options.unowned?.some((row) => row.table === table && row.id === id) })) };
      }
      if (sql.includes("left(key")) {
        return { rows: (params?.[0] as string[]).filter((id) => !options.omitIds?.includes(id)).map((id) => ({ id, owned: !options.unowned?.some((row) => row.table === table && row.id === id) })) };
      }
      if (sql.includes("SELECT episode_id AS id")) {
        return { rows: (params?.[0] as string[]).filter((id) => !options.omitIds?.includes(id)).map((id) => ({ id, narrative: options.episodeNarratives?.[id] ?? plan.namespace })) };
      }
      if (sql.includes("SELECT idempotency_key AS id") && sql.includes("WHERE idempotency_key = ANY")) {
        const provenEpisodes = params?.[1] as string[];
        const provenAgents = params?.[2] as string[];
        return { rows: (params?.[0] as string[]).filter((id) => !options.omitIds?.includes(id)).map((id) => ({ id, owned: provenEpisodes.includes(plan.episodeIds[0]) && provenAgents.includes("agent-actor") && !options.unowned?.some((row) => row.table === table && row.id === id) })) };
      }
      if (sql.includes("SELECT id FROM intents") && sql.includes("WHERE agent_id = ANY")) {
        return { rows: plan.intentIds.filter((id) => !options.omitIds?.includes(id)).map((id) => ({ id })) };
      }
      if (sql.includes("SELECT id FROM intents")) {
        return { rows: (params?.[0] as string[]).filter((id) => !options.omitIds?.includes(id)).map((id) => ({ id, owned: true })) };
      }
      if (sql.includes("SELECT id FROM agents")) {
        return { rows: (params?.[0] as string[]).filter((id) => !options.omitIds?.includes(id)).map((id) => ({ id, owned: !options.unowned?.some((row) => row.table === table && row.id === id) })) };
      }
      if (sql.includes("SELECT id FROM intent_steps")) {
        return { rows: options.omitIds?.includes("step-1") ? [] : [{ id: "step-1" }] };
      }
      if (sql.includes("SELECT idempotency_key AS id FROM actions")) {
        return { rows: options.omitIds?.includes("action-1") ? [] : [{ id: "action-1" }] };
      }
      return { rows: [] };
    },
    release: (destroy) => { released = destroy ?? false; },
  };
  return { client, calls, released: () => released };
}

function cleanupOptions(client: LiveCleanupQueryable, options: FakeOptions = {}) {
  return {
    prerequisites: granted,
    reverifyIdentity: vi.fn(async (same: LiveCleanupQueryable) => { expect(same).toBe(client); await same.query("SELECT identity recheck"); if (options.identityError) throw new Error("identity mismatch"); }),
    reverifySchema: vi.fn(async (same: LiveCleanupQueryable) => { expect(same).toBe(client); await same.query("SELECT schema recheck"); if (options.schemaError) throw new Error("schema mismatch"); }),
  };
}
const deletes = (calls: Call[]) => calls.filter((call) => isDelete(call.sql));

describe("runLiveFixtureCleanup safety", () => {
  it("does no SQL when cleanup authorization is absent", async () => {
    const { client, calls } = fakeClient();
    const opts = cleanupOptions(client);
    const report = await runLiveFixtureCleanup(client, plan, { ...opts, prerequisites: { ...granted, cleanupAuthorized: false } });
    expect(report.refusal).toBe("cleanup-not-authorized");
    expect(calls).toHaveLength(0);
    expect(opts.reverifyIdentity).not.toHaveBeenCalled();
  });

  it.each(["identityError", "schemaError"] as const)("rolls back and never deletes after %s", async (failure) => {
    const { client, calls } = fakeClient({ [failure]: true });
    const report = await runLiveFixtureCleanup(client, plan, cleanupOptions(client, { [failure]: true }));
    expect(report.ok).toBe(false);
    expect(deletes(calls)).toHaveLength(0);
    expect(calls.some((call) => call.sql === "ROLLBACK")).toBe(true);
  });

  it("rechecks, proves ownership, and deletes through one client in a transaction", async () => {
    const { client, calls } = fakeClient();
    const opts = cleanupOptions(client);
    const report = await runLiveFixtureCleanup(client, plan, opts);
    expect(report.unresolved).toEqual([]);
    expect(report.ok).toBe(true);
    expect(calls[0].sql).toBe("BEGIN ISOLATION LEVEL SERIALIZABLE");
    expect(calls.findIndex((call) => call.sql === "SELECT identity recheck")).toBeLessThan(calls.findIndex((call) => call.sql.includes("FROM agents")));
    expect(deletes(calls).map((call) => tableFrom(call.sql))).toEqual([...LIVE_FIXTURE_DELETE_ORDER]);
    const commitIndex = calls.findIndex((call) => call.sql === "COMMIT");
    expect(commitIndex).toBeGreaterThan(calls.findIndex((call) => isDelete(call.sql)));
    const trackedIds: Record<string, string[]> = {
      actions: plan.actionKeys,
      intent_steps: plan.stepIds,
      intents: plan.intentIds,
      episodes: plan.episodeIds,
      agents: plan.agentIds,
    };
    for (const call of deletes(calls)) {
      expect(call.sql).toMatch(/WHERE .+ = ANY\(/i);
      const ids = call.params?.[0] as string[];
      expect(ids.every((id) => trackedIds[tableFrom(call.sql)].includes(id))).toBe(true);
    }
    for (const call of calls.filter((item) => item.sql.includes("FROM action_evidence") || item.sql.includes("FROM test_external_effects"))) {
      expect(call.params?.[0]).toEqual(plan.actionKeys);
    }
    expect(calls.some((call) => /TRUNCATE|DELETE\s+FROM\s+\w+\s*;/i.test(call.sql))).toBe(false);
  });

  it("rejects an episode whose step suffix is not a proven step for its intent", async () => {
    const wrong = { ...plan, episodeIds: ["intent-1:other-step"] };
    const { client, calls } = fakeClient();
    const report = await runLiveFixtureCleanup(client, wrong, cleanupOptions(client));
    expect(report.unresolved).toContainEqual({ table: "episodes", id: "intent-1:other-step", reason: "ownership-unverified" });
    expect(deletes(calls)).toHaveLength(0);
  });

  it("recognizes the exact episode and action for a recorded intentional missing step", async () => {
    const missingStepPlan: LiveFixturePlan = {
      ...plan,
      intentionallyRemovedSteps: [{ intentId: "intent-1", stepId: "step-1" }],
    };
    const { client, calls } = fakeClient({ omitIds: ["step-1"] });
    const report = await runLiveFixtureCleanup(client, missingStepPlan, cleanupOptions(client));
    expect(report.ok).toBe(true);
    expect(report.unresolved).toEqual([]);
    expect(report.deleted.episodes).toBe(1);
    expect(report.deleted.actions).toBe(1);
    expect(deletes(calls).map((call) => tableFrom(call.sql))).toEqual(
      LIVE_FIXTURE_DELETE_ORDER.filter((table) => table !== "intent_steps")
    );
  });

  it("rejects a recorded missing step when the episode encodes a different step", async () => {
    const wrongStepPlan: LiveFixturePlan = {
      ...plan,
      episodeIds: ["intent-1:step-other"],
      intentionallyRemovedSteps: [{ intentId: "intent-1", stepId: "step-1" }],
    };
    const { client, calls } = fakeClient({ omitIds: ["step-1"] });
    const report = await runLiveFixtureCleanup(client, wrongStepPlan, cleanupOptions(client));
    expect(report.unresolved).toContainEqual({ table: "episodes", id: "intent-1:step-other", reason: "ownership-unverified" });
    expect(deletes(calls)).toHaveLength(0);
    expect(calls.some((call) => call.sql === "ROLLBACK")).toBe(true);
  });

  it("rejects a recorded missing step associated with a different intent", async () => {
    const wrongIntentPlan: LiveFixturePlan = {
      ...plan,
      intentionallyRemovedSteps: [{ intentId: "other-intent", stepId: "step-1" }],
    };
    const { client, calls } = fakeClient({ omitIds: ["step-1"] });
    const report = await runLiveFixtureCleanup(client, wrongIntentPlan, cleanupOptions(client));
    expect(report.unresolved).toContainEqual({ table: "episodes", id: "intent-1:step-1", reason: "ownership-unverified" });
    expect(deletes(calls)).toHaveLength(0);
    expect(calls.some((call) => call.sql === "ROLLBACK")).toBe(true);
  });

  it.each([
    ["unproven intent", { unowned: [{ table: "intents", id: "intent-1" }] }],
    ["namespace narrative mismatch", { episodeNarratives: { "intent-1:step-1": "unrelated narrative" } }],
  ] as const)("rejects intentional missing-step evidence with %s", async (_label, options) => {
    const missingStepPlan: LiveFixturePlan = {
      ...plan,
      intentionallyRemovedSteps: [{ intentId: "intent-1", stepId: "step-1" }],
    };
    const { client, calls } = fakeClient({ ...options, omitIds: ["step-1"] } as FakeOptions);
    const report = await runLiveFixtureCleanup(client, missingStepPlan, cleanupOptions(client));
    expect(report.unresolved.some((entry) => entry.table === "episodes" && entry.id === "intent-1:step-1")).toBe(true);
    expect(deletes(calls)).toHaveLength(0);
    expect(calls.some((call) => call.sql === "ROLLBACK")).toBe(true);
  });

  it.each([0, 2])("does not produce missing-step ownership evidence when the delete count is %i", async (rowCount) => {
    const query = vi.fn(async () => ({ rowCount, rows: [] }));
    await expect(deleteExactMissingStep({ query }, "intent-1", "step-1")).rejects.toThrow(
      "Could not remove the exact test-owned step"
    );
    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(
      "DELETE FROM intent_steps WHERE id = $1 AND intent_id = $2",
      ["step-1", "intent-1"]
    );
  });

  it("returns missing-step ownership evidence only after exactly one row is deleted", async () => {
    const query = vi.fn(async () => ({ rowCount: 1, rows: [] }));
    await expect(deleteExactMissingStep({ query }, "intent-1", "step-1")).resolves.toEqual({
      intentId: "intent-1",
      stepId: "step-1",
    });
    expect(query).toHaveBeenCalledWith(
      "DELETE FROM intent_steps WHERE id = $1 AND intent_id = $2",
      ["step-1", "intent-1"]
    );
  });

  it("refuses to delete a fixture agent with an unowned cascading dependent", async () => {
    const { client, calls } = fakeClient({ cascade: [{ table: "auth_users", id: "user-other" }] });
    const report = await runLiveFixtureCleanup(client, plan, cleanupOptions(client));
    expect(report.unresolved).toContainEqual({ table: "auth_users", id: "user-other", reason: "ownership-unverified" });
    expect(deletes(calls)).toHaveLength(0);
  });

  it.each(["action_evidence", "test_external_effects"] as const)("blocks action cleanup when an untracked %s dependent exists", async (table) => {
    const { client, calls } = fakeClient({ dependents: [{ table, id: "dependent-other", action_key: "action-1" }] });
    const report = await runLiveFixtureCleanup(client, plan, cleanupOptions(client));
    expect(report.unresolved).toContainEqual({ table, id: "dependent-other", reason: "ownership-unverified" });
    expect(deletes(calls)).toHaveLength(0);
    expect(calls.some((call) => call.sql === "ROLLBACK")).toBe(true);
  });

  it("deletes explicitly tracked action dependents before deleting the action", async () => {
    const expectedPlan: LiveFixturePlan = {
      ...plan,
      actionEvidenceIds: ["evidence-1"],
      testExternalEffectIds: ["external-effect-1"],
    };
    const { client, calls } = fakeClient({ dependents: [
      { table: "action_evidence", id: "evidence-1", action_key: "action-1" },
      { table: "test_external_effects", id: "external-effect-1", action_key: "action-1" },
    ] });
    const report = await runLiveFixtureCleanup(client, expectedPlan, cleanupOptions(client));
    expect(report.ok).toBe(true);
    const actionDeleteIndex = calls.findIndex((call) => isDelete(call.sql) && tableFrom(call.sql) === "actions");
    for (const table of ["action_evidence", "test_external_effects"]) {
      const checkIndex = calls.findIndex((call) => call.sql.includes(`FROM ${table}`));
      expect(checkIndex).toBeGreaterThan(-1);
      expect(checkIndex).toBeLessThan(actionDeleteIndex);
    }
    expect(deletes(calls).map((call) => tableFrom(call.sql))).toEqual([
      "action_evidence", "test_external_effects", ...LIVE_FIXTURE_DELETE_ORDER,
    ]);
    expect(deletes(calls).flatMap((call) => call.params?.[0] as string[])).not.toContain("dependent-other");
  });

  it.each(["action_evidence", "test_external_effects"] as const)("rolls back without deleting if the %s dependent query fails", async (table) => {
    const { client, calls } = fakeClient({ dependentQueryError: table });
    const report = await runLiveFixtureCleanup(client, plan, cleanupOptions(client));
    expect(report.ok).toBe(false);
    expect(deletes(calls)).toHaveLength(0);
    expect(calls.some((call) => call.sql === "ROLLBACK")).toBe(true);
  });

  it("treats a dependent ownership mismatch as unowned", async () => {
    const expectedPlan = { ...plan, actionEvidenceIds: ["evidence-1"] };
    const { client, calls } = fakeClient({ dependents: [
      { table: "action_evidence", id: "evidence-1", action_key: "other-action" },
    ] });
    const report = await runLiveFixtureCleanup(client, expectedPlan, cleanupOptions(client));
    expect(report.unresolved).toContainEqual({ table: "action_evidence", id: "evidence-1", reason: "ownership-unverified" });
    expect(deletes(calls)).toHaveLength(0);
    expect(calls.some((call) => call.sql === "ROLLBACK")).toBe(true);
  });

  it.each([
    ["unowned fixture", { unowned: [{ table: "agents", id: "agent-reconciler" }] }],
    ["delete count mismatch", { deleteCount: (table: string, ids: string[]) => table === "actions" ? ids.length - 1 : ids.length }],
    ["delete error", { deleteError: "actions" }],
  ] as const)("rolls back on %s", async (_label, option) => {
    const { client, calls } = fakeClient(option as FakeOptions);
    const report = await runLiveFixtureCleanup(client, plan, cleanupOptions(client));
    expect(report.ok).toBe(false);
    expect(calls.some((call) => call.sql === "ROLLBACK")).toBe(true);
    expect(calls.some((call) => call.sql === "COMMIT")).toBe(false);
    if (option && "deleteError" in option) expect(deletes(calls)).toHaveLength(1);
    if (option && "deleteCount" in option) expect(deletes(calls).map((call) => tableFrom(call.sql))).toEqual(["actions"]);
  });

  it("formats unresolved ownership rows without weakening the no-delete refusal", async () => {
    const { client, calls } = fakeClient({ unowned: [{ table: "agents", id: "agent-reconciler" }] });
    const report = await runLiveFixtureCleanup(client, plan, cleanupOptions(client));
    expect(formatLiveCleanupUnresolved(report.unresolved)).toBe(
      "agents:agent-reconciler (ownership-unverified)"
    );
    expect(report.ok).toBe(false);
    expect(deletes(calls)).toHaveLength(0);
    expect(calls.some((call) => call.sql === "ROLLBACK")).toBe(true);
  });

  it("does not delete an absent row after an ambiguous insert", async () => {
    const { client, calls } = fakeClient({ omitIds: ["action-1"] });
    const report = await runLiveFixtureCleanup(client, plan, cleanupOptions(client));
    expect(report.ok).toBe(true);
    expect(deletes(calls).flatMap((call) => call.params?.[0] as string[])).not.toContain("action-1");
  });

  it("marks a client unusable when rollback fails", async () => {
    const { client } = fakeClient({ identityError: true, rollbackError: true });
    const report = await runLiveFixtureCleanup(client, plan, cleanupOptions(client, { identityError: true }));
    expect(report.connectionReusable).toBe(false);
    expect(report.failures.some((failure) => failure.includes("rollback failed"))).toBe(true);
  });
});

describe("withLiveCleanupClient resource ownership", () => {
  it.each([false, true])("releases its client and ends its pool on failure=%s", async (fails) => {
    const fake = fakeClient();
    const pool: LiveCleanupPool = { connect: async () => fake.client, end: vi.fn(async () => {}) };
    if (fails) await expect(withLiveCleanupClient(pool, async () => { throw new Error("cleanup failed"); })).rejects.toThrow("cleanup failed");
    else await expect(withLiveCleanupClient(pool, async () => "ok")).resolves.toBe("ok");
    expect(fake.released()).toBe(false);
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("discards an unusable client when requested", async () => {
    const fake = fakeClient();
    const pool: LiveCleanupPool = { connect: async () => fake.client, end: vi.fn(async () => {}) };
    await withLiveCleanupClient(pool, async (_client, discard) => { discard(); });
    expect(fake.released()).toBe(true);
    expect(pool.end).toHaveBeenCalledOnce();
  });
});

describe("reportLiveFixtureResidue", () => {
  it("is read-only", async () => {
    const { client, calls } = fakeClient({ residue: () => 1 });
    const result = await reportLiveFixtureResidue(client, plan);
    expect(result.total).toBe(LIVE_FIXTURE_DELETE_ORDER.length);
    expect(calls.every((call) => /^\s*SELECT/i.test(call.sql))).toBe(true);
  });
});
