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
import { GITHUB_CREATE_ISSUE, GitHubIssueExecutor, GitHubIssueVerifier } from "../../src/recovery-engine/github-issue";

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

function prepareArgs(intentId: string, stepId: string) {
  return {
    intent_id: intentId,
    step_id: stepId,
    action_type: GITHUB_CREATE_ISSUE,
    arguments: {
      owner: "acme",
      repository: "widgets",
      title: "Conflict gate regression fixture",
      body: "No external issue is created by prepare_action.",
    },
  };
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("GITHUB_TOKEN", "github-test-token-never-log");
  vi.stubEnv("GITHUB_REPOSITORY", "acme/widgets");
  vi.stubEnv("LLM_PROVIDER", "nvidia");
  vi.stubEnv("NVIDIA_API_KEY", "nvidia-test-key-never-log");
  getVerifierRegistry().registerProduction(
    GITHUB_CREATE_ISSUE,
    new GitHubIssueVerifier("github-test-token-never-log")
  );
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

    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(
      statements.some((sql) => /INSERT INTO (actions|episodes)|UPDATE actions/i.test(sql))
    ).toBe(false);
    expect(
      statements.filter((sql) => /INSERT INTO conflicts/i.test(sql))
    ).toHaveLength(1);
  });

  it("keeps the refusal unchanged when conflict persistence rejects", async () => {
    const { intent, dependent } = conflictedFixture();
    const { db, query } = fakeDatabase();
    query.mockImplementation(async (sql: string) => {
      if (/INSERT INTO conflicts/i.test(sql)) {
        throw new Error("conflict insert failed");
      }
      return sql.includes("AS difference")
        ? { rows: [{ difference: 0 }], rowCount: 1 }
        : { rows: [], rowCount: 1 };
    });

    await expect(
      prepareTool(db)._handler(prepareArgs(intent.id, dependent.id))
    ).rejects.toThrow(
      /Cannot prepare action: step \d+ depends on a resource that changed after the intent was declared: config:retry-policy \(v1 -> v2\)\. Re-read the resource and re-declare the intent before acting\./
    );
  });

  it("keeps the refusal when conflict persistence never resolves", async () => {
    vi.useFakeTimers();
    try {
      const { intent, dependent } = conflictedFixture();
      const { db, query } = fakeDatabase();
      query.mockImplementation((sql: string) => {
        if (/INSERT INTO conflicts/i.test(sql)) return new Promise(() => {});
        return Promise.resolve(
          sql.includes("AS difference")
            ? { rows: [{ difference: 0 }], rowCount: 1 }
            : { rows: [], rowCount: 1 }
        );
      });

      const pending = prepareTool(db)._handler(
        prepareArgs(intent.id, dependent.id)
      );
      const assertion = expect(pending).rejects.toThrow(
        /Cannot prepare action: step \d+ depends on a resource that changed after the intent was declared: config:retry-policy \(v1 -> v2\)\. Re-read the resource and re-declare the intent before acting\./
      );
      await vi.advanceTimersByTimeAsync(1500);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not include resource state or bodies in conflict insert parameters", async () => {
    const { intent, dependent } = conflictedFixture();
    const { db, query } = fakeDatabase();

    await expect(
      prepareTool(db)._handler(prepareArgs(intent.id, dependent.id))
    ).rejects.toThrow(/depends on a resource that changed/);

    const insert = query.mock.calls.find(([sql]) =>
      /INSERT INTO conflicts/i.test(String(sql))
    );
    expect(insert).toBeDefined();
    const params = insert?.[1] ?? [];
    expect(JSON.stringify(params)).not.toContain("retries");
    expect(JSON.stringify(params)).not.toContain("state");
    const changes = JSON.parse(String(params[4]));
    expect(changes).toEqual([
      { key: "config:retry-policy", kind: "config", from: 1, to: 2 },
    ]);
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
    expect(
      query.mock.calls.some(([sql]) =>
        /INSERT INTO (actions|episodes)|UPDATE actions/i.test(String(sql))
      )
    ).toBe(false);
  });

  it("reaches the conflict gate for a valid registered GitHub action before persistence, leasing, or execution", async () => {
    const { intent, dependent } = conflictedFixture();
    const { db, query } = fakeDatabase();
    const execute = vi.spyOn(GitHubIssueExecutor.prototype, "execute");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(getVerifierRegistry().getProduction(GITHUB_CREATE_ISSUE)).toBeInstanceOf(GitHubIssueVerifier);
    await expect(
      prepareTool(db)._handler(prepareArgs(intent.id, dependent.id))
    ).rejects.toThrow("config:retry-policy (v1 -> v2)");

    expect(query.mock.calls.some(([sql]) => /INSERT INTO (episodes|actions)/.test(String(sql)))).toBe(false);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE actions"))).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prepares an unaffected GitHub step without authorizing execution", async () => {
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
    expect(statements.some((sql) => sql.includes("UPDATE actions"))).toBe(false);
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
      action_type: "demo.config_update",
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

  it("accepts a currently supported production action with its exact validated arguments", async () => {
    const { intent, independent } = conflictedFixture();
    const { db, query } = fakeDatabase();

    const result = await prepareTool(db)._handler(prepareArgs(intent.id, independent.id));

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
