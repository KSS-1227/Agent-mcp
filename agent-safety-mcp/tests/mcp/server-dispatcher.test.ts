import * as http from "node:http";
import type { AddressInfo } from "node:net";
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
  verifyJWT: vi.fn(async () => ({ user_id: "dispatcher-test-user" })),
  getAgentId: vi.fn(async () => "11111111-1111-4111-8111-111111111111"),
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
vi.mock("../../src/auth/jwt-verifier", () => ({
  verifySupabaseJWT: mocks.verifyJWT,
  extractBearerToken: (header?: string) => header?.startsWith("Bearer ") ? header.slice(7) : null,
}));
vi.mock("../../src/auth/user-agent-mapping", () => ({
  getAgentIdForUser: mocks.getAgentId,
}));
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
import { createHTTPMCPServer } from "../../src/mcp/http-transport";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const CREATED_AT = new Date("2026-01-01T00:00:00.000Z");

describe("production MCP tools/call dispatcher", () => {
  let server: Awaited<ReturnType<typeof createMCPServer>> | undefined;
  let httpServer: http.Server | undefined;

  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://test@localhost:5432/agent_safety_test");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GITHUB_REPOSITORY", "");
    mocks.verifyJWT.mockImplementation(async () => ({ user_id: "dispatcher-test-user" }));
    mocks.getAgentId.mockImplementation(async () => AGENT_ID);

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
      if (httpServer) {
        await new Promise<void>((resolve, reject) => {
          httpServer!.close((error) => error ? reject(error) : resolve());
        });
        httpServer = undefined;
      }
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

  it("serves initialize, all registered tools, and get_agent through the production dispatcher", async () => {
    server = await createMCPServer();
    httpServer = await createHTTPMCPServer(server, mocks.database as any, 0);

    const initialize = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "dispatcher-test", version: "1.0.0" },
      },
    });
    expect(initialize.status).toBe(200);
    expect(initialize.body.result.protocolVersion).toBe("2025-03-26");

    const tools = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(tools.status).toBe(200);
    expect(tools.body.result.tools).toHaveLength(27);
    expect(tools.body.result.tools.map((tool: any) => tool.name)).toContain("get_agent");

    const call = await post({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_agent", arguments: { agent_id: AGENT_ID } },
    });
    expect(call.status).toBe(200);
    expect(JSON.parse(call.body.result.content[0].text)).toMatchObject({
      id: AGENT_ID,
      key: "dispatcher-test-agent",
      name: "Dispatcher Test Agent",
      metadata: { source: "dispatcher-regression" },
    });
    expect(mocks.verifyJWT).toHaveBeenCalledTimes(3);
    expect(mocks.getAgentId).toHaveBeenCalledTimes(3);
  });

  it("returns the expected error for an unknown registered tool name", async () => {
    const dispatch = await getProductionDispatcher();

    await expect(dispatch({
      method: "tools/call",
      params: { name: "missing_test_tool", arguments: { value: "forwarded" } },
    })).rejects.toThrow("Tool not found: missing_test_tool");
  });

  function post(body: unknown): Promise<{ status: number; body: any }> {
    if (!httpServer) throw new Error("HTTP MCP server has not started");
    const address = httpServer.address() as AddressInfo;
    return new Promise((resolve, reject) => {
      const request = http.request({
        hostname: "127.0.0.1",
        port: address.port,
        path: "/mcp",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-03-26",
          Authorization: "Bearer dispatcher-test-token",
        },
      }, (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { responseBody += chunk; });
        response.on("end", () => resolve({
          status: response.statusCode || 0,
          body: responseBody ? JSON.parse(responseBody) : undefined,
        }));
      });
      request.on("error", reject);
      request.end(JSON.stringify(body));
    });
  }
});
