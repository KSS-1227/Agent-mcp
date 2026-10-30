import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  database: {
    query: vi.fn(),
    pool: { query: vi.fn() },
    close: vi.fn(async () => undefined),
  },
  agentService: undefined as any,
  resourceService: { setDatabase: vi.fn(), loadFromDatabase: vi.fn(async () => undefined) },
  taskService: { setDatabase: vi.fn(), loadFromDatabase: vi.fn(async () => undefined) },
  intentService: { setDatabase: vi.fn(), loadFromDatabase: vi.fn(async () => undefined) },
}));

vi.mock("../../src/database/client", () => ({
  createDatabaseClient: () => mocks.database,
}));

vi.mock("../../src/core/agent.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/agent.service")>();
  return { ...actual, getAgentService: () => mocks.agentService };
});

vi.mock("../../src/core/resource.service", () => ({
  getResourceService: () => mocks.resourceService,
}));
vi.mock("../../src/core/task.service", () => ({
  getTaskService: () => mocks.taskService,
}));
vi.mock("../../src/conflict-engine/intent.service", () => ({
  getIntentService: () => mocks.intentService,
}));
vi.mock("../../src/mcp/tools/resources", () => ({ getResourceServiceTools: () => [] }));
vi.mock("../../src/mcp/tools/tasks", () => ({ getTaskServiceTools: () => [] }));
vi.mock("../../src/mcp/tools/intents", () => ({ getIntentServiceTools: () => [] }));
vi.mock("../../src/mcp/tools/conflicts", () => ({ getConflictDetectionTools: () => [] }));
vi.mock("../../src/mcp/tools/actions", () => ({
  getActionProtocolTools: () => [],
  resolveReconcilerAgentId: vi.fn(),
}));
vi.mock("../../src/mcp/tools/status", () => ({ getStatusQueryTools: () => [] }));
vi.mock("../../src/recovery-engine/verifier_registry", () => ({
  getVerifierRegistry: () => ({ listProduction: () => [] }),
  ProductionActionVerifierDispatcher: class {},
}));
vi.mock("../../src/recovery-engine/github-issue", () => ({
  githubRepository: () => undefined,
  githubToken: () => undefined,
  GITHUB_CREATE_ISSUE: "github.create_issue",
  GitHubIssueVerifier: class {},
}));
vi.mock("../../src/recovery-engine/embedder", () => ({ getRecoveryEmbedder: vi.fn() }));
vi.mock("../../src/health/recovery-runtime", () => ({ setRecoveryRuntimeHealth: vi.fn() }));

import { AgentService } from "../../src/core/agent.service";
import { createMCPServer } from "../../src/mcp/server";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const CREATED_AT = new Date("2026-01-01T00:00:00.000Z");

describe("production MCP tools/call dispatcher", () => {
  let server: Awaited<ReturnType<typeof createMCPServer>> | undefined;

  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://test@localhost:5432/agent_safety_test");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GITHUB_REPOSITORY", "");

    mocks.agentService = new AgentService();
    mocks.database.close.mockClear();
    mocks.dbQuery.mockReset();
    mocks.dbQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM agents")) {
        return {
          rows: [{
            id: AGENT_ID,
            key: "dispatcher-test-agent",
            name: "Dispatcher Test Agent",
            metadata: { source: "dispatcher-regression" },
            created_at: CREATED_AT,
            updated_at: CREATED_AT,
          }],
        };
      }
      return { rows: [] };
    });
    mocks.database.query = mocks.dbQuery;
    mocks.database.pool.query = mocks.dbQuery;
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      await mocks.database.close();
      server = undefined;
    }
    vi.unstubAllEnvs();
  });

  async function getProductionDispatcher() {
    server = await createMCPServer();
    return (server as any)._requestHandlers.get("tools/call") as (request: any) => Promise<any>;
  }

  it("dispatches get_agent with the nested arguments and returns the matching agent", async () => {
    const dispatch = await getProductionDispatcher();
    const result = await dispatch({
      method: "tools/call",
      params: {
        name: "get_agent",
        arguments: { agent_id: AGENT_ID },
      },
    });

    expect(result).toEqual({
      content: [{
        type: "text",
        text: JSON.stringify({
          id: AGENT_ID,
          key: "dispatcher-test-agent",
          name: "Dispatcher Test Agent",
          metadata: { source: "dispatcher-regression" },
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
        }, null, 2),
      }],
    });
  });

  it("returns the expected error for an unknown registered tool name", async () => {
    const dispatch = await getProductionDispatcher();

    await expect(dispatch({
      method: "tools/call",
      params: { name: "missing_test_tool", arguments: { value: "forwarded" } },
    })).rejects.toThrow("Tool not found: missing_test_tool");
  });
});
