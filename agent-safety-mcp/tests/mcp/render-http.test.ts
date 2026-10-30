import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHTTPMCPServer, resolveHTTPPort } from "../../src/mcp/http-transport";
import { resolveMCPTransport } from "../../src/start-server";

const mocks = vi.hoisted(() => ({
  verifyJWT: vi.fn(async () => ({ user_id: "render-test-user" })),
  getAgentId: vi.fn(async () => "render-test-agent"),
  toolCall: vi.fn(async (args: unknown) => args),
  checkLiveness: vi.fn(async () => ({ status: "healthy", timestamp: "2026-01-01T00:00:00.000Z" })),
  checkReadiness: vi.fn(async () => ({ status: "healthy", timestamp: "2026-01-01T00:00:00.000Z" })),
}));

vi.mock("../../src/auth/jwt-verifier", () => ({
  verifySupabaseJWT: mocks.verifyJWT,
  extractBearerToken: (header?: string) => header?.startsWith("Bearer ") ? header.slice(7) : null,
}));
vi.mock("../../src/auth/user-agent-mapping", () => ({ getAgentIdForUser: mocks.getAgentId }));
vi.mock("../../src/health/checks", () => ({
  checkLiveness: mocks.checkLiveness,
  checkReadiness: mocks.checkReadiness,
}));
let httpServer: http.Server | undefined;
let mcpServer: Server | undefined;
let connectSpy: ReturnType<typeof vi.spyOn> | undefined;

function request(
  path: string,
  method = "GET",
  body?: unknown,
  authorization: string | null = body === undefined ? null : "Bearer test-token"
): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  if (!httpServer) throw new Error("HTTP server has not started");
  const address = httpServer.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port: address.port,
      path,
      method,
      headers: {
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-03-26",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(authorization ? { Authorization: authorization } : {}),
      },
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({
        status: res.statusCode || 0,
        body: data ? JSON.parse(data) : undefined,
        headers: res.headers,
      }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

describe("Render HTTP deployment wiring", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.verifyJWT.mockImplementation(async () => ({ user_id: "render-test-user" }));
    mocks.getAgentId.mockImplementation(async () => "render-test-agent");
    mcpServer = new Server(
      { name: "http-transport-test", version: "1.0.0" },
      { capabilities: { tools: { listChanged: false } } }
    );
    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "identity.echo", description: "Echo authenticated identity", inputSchema: { type: "object" } }],
    }));
    mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
      const result = await mocks.toolCall(request.params.arguments);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    });
    connectSpy = vi.spyOn(Server.prototype, "connect");
    httpServer = await createHTTPMCPServer(mcpServer, {} as any, 0);
  });

  afterEach(async () => {
    if (httpServer) await new Promise<void>((resolve, reject) => httpServer!.close((error) => error ? reject(error) : resolve()));
    if (mcpServer) await mcpServer.close();
    connectSpy?.mockRestore();
    httpServer = undefined;
    mcpServer = undefined;
    connectSpy = undefined;
  });

  it("prefers Render PORT and retains the MCP_HTTP_PORT local fallback", () => {
    expect(resolveHTTPPort({ PORT: "4312", MCP_HTTP_PORT: "8088" })).toBe(4312);
    expect(resolveHTTPPort({ MCP_HTTP_PORT: "8088" })).toBe(8088);
    expect(resolveHTTPPort({})).toBe(8080);
  });

  it("binds the listener to 0.0.0.0", () => {
    expect((httpServer!.address() as AddressInfo).address).toBe("0.0.0.0");
  });

  it("serves each health endpoint on the MCP service listener", async () => {
    const [live, ready, recovery] = await Promise.all([
      request("/health/live"),
      request("/health/ready"),
      request("/health/recovery"),
    ]);
    expect(live).toMatchObject({ status: 200, body: { status: "healthy" } });
    expect(ready).toMatchObject({ status: 200, body: { status: "healthy" } });
    expect(recovery.status).toBe(200);
    expect(recovery.body).toMatchObject({ state: expect.any(String), enabled: expect.any(Boolean) });
  });

  it("connects each fresh stateless SDK server exactly once before initialize and tools/list dispatch", async () => {
    expect(connectSpy).not.toHaveBeenCalled();
    const initialize = await request("/mcp", "POST", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "transport-regression-test", version: "1.0.0" },
      },
    });
    expect(initialize.status).toBe(200);
    expect(initialize.body).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: expect.any(String),
        serverInfo: { name: "http-transport-test", version: "1.0.0" },
        capabilities: expect.any(Object),
      },
    });

    const tools = await request("/mcp", "POST", { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(tools.status).toBe(200);
    expect(tools.body).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      result: { tools: [{ name: "identity.echo" }] },
    });
    expect(tools.body.result.tools).toHaveLength(1);
    expect(mocks.verifyJWT).toHaveBeenCalledWith("test-token");
    expect(mocks.getAgentId).toHaveBeenCalledWith("render-test-user", expect.anything());
    expect(connectSpy).toHaveBeenCalledTimes(2);
    expect(connectSpy!.mock.calls[0][0]).not.toBe(connectSpy!.mock.calls[1][0]);
  });

  it("returns 401 for an unauthenticated, otherwise valid MCP request", async () => {
    const result = await request("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, null);
    expect(result).toMatchObject({ status: 401, body: { error: "Unauthorized" } });
  });

  it("returns 405 and allows POST for GET /mcp without opening an SSE stream", async () => {
    const result = await request("/mcp", "GET");
    expect(result.status).toBe(405);
    expect(result.headers.allow).toBe("POST");
    expect(mocks.verifyJWT).not.toHaveBeenCalled();
  });

  it("preserves forbidden behavior for invalid JWTs and missing user-agent mappings", async () => {
    mocks.verifyJWT.mockImplementation(async () => { throw new Error("JWT verification failed"); });
    const invalidJwt = await request("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(invalidJwt).toMatchObject({ status: 403, body: { error: "Forbidden" } });

    mocks.verifyJWT.mockImplementation(async () => ({ user_id: "unmapped-user" }));
    mocks.getAgentId.mockImplementation(async () => { throw new Error("Agent mapping lookup failed"); });
    const unmappedUser = await request("/mcp", "POST", { jsonrpc: "2.0", id: 2, method: "initialize", params: {} });
    expect(unmappedUser).toMatchObject({ status: 403, body: { error: "Forbidden" } });
  });

  it("overwrites all client-supplied identity aliases with the authenticated mapping", async () => {
    const identityResult = { agentId: "render-test-agent", agent_id: "render-test-agent", callingAgent: "render-test-agent" };
    mocks.toolCall.mockImplementation(async (args: any) => {
      expect(args).toEqual(identityResult);
      return identityResult;
    });
    const result = await request("/mcp", "POST", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "identity.echo",
        arguments: { agentId: "attacker", agent_id: "attacker", callingAgent: "attacker" },
      },
    });
    expect(result.status).toBe(200);
    expect(mocks.toolCall).toHaveBeenCalledTimes(1);
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects MCP requests addressed to a path other than /mcp before authenticating", async () => {
    const result = await request("/", "POST", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(result).toMatchObject({ status: 404, body: { error: "Not found" } });
    expect(mocks.verifyJWT).not.toHaveBeenCalled();
    expect(mocks.getAgentId).not.toHaveBeenCalled();
    expect(mocks.toolCall).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown paths regardless of method", async () => {
    const result = await request("/not-mcp", "GET");
    expect(result).toMatchObject({ status: 404, body: { error: "Not found" } });
  });

  it("keeps stdio as the default transport and honors explicit transport selection", () => {
    expect(resolveMCPTransport(undefined)).toBe("stdio");
    expect(resolveMCPTransport("stdio")).toBe("stdio");
    expect(resolveMCPTransport("http")).toBe("http");
  });
});
