/**
 * prepare_action deterministic conflict gate.
 *
 * These tests use in-memory services and a fake pool, so no database is
 * contacted. They assert that the gate rejects before any episode or action
 * row is written, that it never consults an adjudication provider, and that
 * unaffected steps keep their existing behaviour.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntentService, setIntentService } from "../../src/conflict-engine/intent.service";
import { IntentStatus } from "../../src/conflict-engine/types";
import { ProvenanceGraph, setProvenanceGraph } from "../../src/conflict-engine/provenance";
import { ResourceService, setResourceService } from "../../src/core/resource.service";
import { getActionProtocolTools } from "../../src/mcp/tools/actions";
import { getVerifierRegistry, resetVerifierRegistry } from "../../src/recovery-engine/verifier_registry";
import { GITHUB_CREATE_ISSUE, GitHubIssueVerifier } from "../../src/recovery-engine/github-issue";

const AGENT_ID = "11111111-1111-1111-1111-111111111111";

function conflictedFixture() {
  const resources = new ResourceService();
  const intents = new IntentService();
  setResourceService(resources);
  setIntentService(intents);
  setProvenanceGraph(new ProvenanceGraph());

  const resource = resources.registerResource("config:retry-policy", "config", { retries: 3 });
  const intent = intents.declareIntent(
    AGENT_ID,
    "task-publish",
    "Publish the retry policy change",
    [{ resourceId: resource.id, observedVersion: resource.version }],
    [
      { description: "Read retry policy", dependsOn: [resource.id] },
      { description: "Notify on-call" },
    ]
  );
  const [dependent, independent] = intents.getIntentSteps(intent.id);

  // The resource moves past the version the intent observed.
  resources.updateResource(resource.id, { retries: 5 }, resource.version);
  return { resources, intents, intent, dependent, independent };
}

function fakeDatabase() {
  // The dependency-snapshot completeness check is the only query whose result
  // the gate inspects; everything else is asserted by statement order.
  const query = vi.fn(async (sql: string, _params?: any[]) =>
    sql.includes("AS difference")
      ? { rows: [{ difference: 0 }], rowCount: 1 }
      : { rows: [], rowCount: 1 }
  );
  return { db: { pool: { query, connect: async () => ({ query, release: () => {} }) } } as any, query };
}

function prepareTool(db: any) {
  return getActionProtocolTools(db).find((tool) => tool.name === "prepare_action")!;
}

function prepareArgs(intentId: string, stepId: string, item = "change") {
  return {
    intent_id: intentId,
    step_id: stepId,
    action_type: "scale_cluster",
    arguments: { item },
  };
}

beforeEach(() => {
  vi.stubEnv("LLM_PROVIDER", "nvidia");
  vi.stubEnv("NVIDIA_API_KEY", "nvidia-test-key-never-log");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetVerifierRegistry();
  setProvenanceGraph(new ProvenanceGraph());
});

describe("deterministic conflict gate", () => {
  it("rejects an affected step before writing an episode or an action", async () => {
    const { intent, dependent } = conflictedFixture();
    const { db, query } = fakeDatabase();

    await expect(
      prepareTool(db)._handler(prepareArgs(intent.id, dependent.id))
    ).rejects.toThrow(/depends on a resource that changed/);

    expect(query).not.toHaveBeenCalled();
  });

  it("names the changed resource and versions in the rejection", async () => {
    const { intent, dependent } = conflictedFixture();
    const { db } = fakeDatabase();

    await expect(
      prepareTool(db)._handler(prepareArgs(intent.id, dependent.id))
    ).rejects.toThrow("config:retry-policy (v1 -> v2)");
  });

  it("cannot be unblocked by a model verdict and never contacts a provider", async () => {
    const { intent, dependent } = conflictedFixture();
    const { db, query } = fakeDatabase();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      prepareTool(db)._handler(prepareArgs(intent.id, dependent.id))
    ).rejects.toThrow(/depends on a resource that changed/);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("allows an unaffected step and preserves the existing write order", async () => {
    const { intent, independent } = conflictedFixture();
    const { db, query } = fakeDatabase();

    const result = await prepareTool(db)._handler(
      prepareArgs(intent.id, independent.id)
    );

    expect(result.disposition).toBe("OWNED");
    expect(result.action_id).toBeTruthy();
    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements[0]).toContain("INSERT INTO episodes");
    expect(statements).toContain("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    expect(statements.some((sql) => sql.includes("SELECT resource_id, observed_version FROM intent_reads"))).toBe(true);
    expect(statements.some((sql) => sql.includes("INSERT INTO actions"))).toBe(true);
    expect(statements.some((sql) => sql.includes("UPDATE actions"))).toBe(true);
    expect(statements.at(-1)).toBe("COMMIT");
  });

  it("allows an unaffected step in an active non-terminal intent state", async () => {
    const { intent, intents, independent } = conflictedFixture();
    intents.updateIntentStatus(intent.id, IntentStatus.REPAIRING);
    const { db } = fakeDatabase();

    const result = await prepareTool(db)._handler(
      prepareArgs(intent.id, independent.id)
    );

    expect(result.disposition).toBe("OWNED");
  });

  it("rejects an unregistered action type in production before writing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { intent, independent } = conflictedFixture();
    const { db, query } = fakeDatabase();

    await expect(prepareTool(db)._handler({
      ...prepareArgs(intent.id, independent.id),
      action_type: "test-action",
    })).rejects.toThrow(/Unsupported action type/);

    expect(query).not.toHaveBeenCalled();
  });

  it("permits fixture-only action types in an isolated test database", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DATABASE_URL", "postgresql://tester:fake@isolated.invalid:5432/agent_safety_test");
    const { intent, independent } = conflictedFixture();
    const { db, query } = fakeDatabase();

    const result = await prepareTool(db)._handler({
      ...prepareArgs(intent.id, independent.id),
      action_type: "test-action",
    });

    expect(result.disposition).toBe("OWNED");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO actions"))).toBe(true);
  });

  it("rejects fixture-only action types when a test process points at production", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DATABASE_URL", "postgresql://postgres.prodref@aws-0-us-east-1.pooler.supabase.com:6543/postgres");
    vi.stubEnv("SUPABASE_URL", "https://prodref.supabase.co");
    const { intent, independent } = conflictedFixture();
    const { db, query } = fakeDatabase();

    await expect(prepareTool(db)._handler({
      ...prepareArgs(intent.id, independent.id),
      action_type: "test-action",
    })).rejects.toThrow(/Unsupported action type/);

    expect(query).not.toHaveBeenCalled();
  });

  it("accepts a currently supported production action when its production verifier is registered", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GITHUB_TOKEN", "test-token-not-used-by-this-test");
    vi.stubEnv("GITHUB_REPOSITORY", "acme/widgets");
    getVerifierRegistry().registerProduction(
      GITHUB_CREATE_ISSUE,
      new GitHubIssueVerifier("test-token-not-used-by-this-test")
    );
    const { intent, independent } = conflictedFixture();
    const { db, query } = fakeDatabase();

    const result = await prepareTool(db)._handler({
      intent_id: intent.id,
      step_id: independent.id,
      action_type: GITHUB_CREATE_ISSUE,
      arguments: { owner: "acme", repository: "widgets", title: "Test", body: "" },
    });

    expect(result.disposition).toBe("OWNED");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO actions"))).toBe(true);
  });
});

describe("intent state gate", () => {
  it.each([IntentStatus.COMMITTED, IntentStatus.ABORTED])(
    "rejects preparation for a %s intent before any write",
    async (status) => {
      const { intent, intents, independent } = conflictedFixture();
      intents.updateIntentStatus(intent.id, status);
      const { db, query } = fakeDatabase();

      await expect(
        prepareTool(db)._handler(prepareArgs(intent.id, independent.id))
      ).rejects.toThrow(`is ${status} and cannot accept new actions`);

      expect(query).not.toHaveBeenCalled();
    }
  );

  it("rejects a terminal intent even when the step itself is unaffected", async () => {
    const { intent, intents, independent } = conflictedFixture();
    intents.updateIntentStatus(intent.id, IntentStatus.COMMITTED);
    const { db, query } = fakeDatabase();

    await expect(
      prepareTool(db)._handler(prepareArgs(intent.id, independent.id))
    ).rejects.toThrow(/cannot accept new actions/);

    expect(query).not.toHaveBeenCalled();
  });
});
