import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHTTPMCPServer, resolveHTTPPort } from "../../src/mcp/http-transport";
import { resolveMCPTransport } from "../../src/start-server";

const mocks = vi.hoisted(() => ({
  verifyJWT: vi.fn(async () => ({ user_id: "render-test-user" })),
  getAgentId: vi.fn(async () => "render-test-agent"),
  dispatch: vi.fn(),
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
vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => ({
  StreamableHTTPServerTransport: class {
    async handleRequest(_req: unknown, res: http.ServerResponse, body: any) {
      await mocks.dispatch(body, res);
    }
  },
}));

let server: http.Server | undefined;

function request(path: string, method = "GET", body?: unknown): Promise<{ status: number; body: any }> {
  if (!server) throw new Error("HTTP server has not started");
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port: address.port,
      path,
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json", Authorization: "Bearer test-token" }),
      },
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode || 0, body: data ? JSON.parse(data) : undefined }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

describe("Render HTTP deployment wiring", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    server = await createHTTPMCPServer({} as any, {} as any, 0);
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  });

  it("prefers Render PORT and retains the MCP_HTTP_PORT local fallback", () => {
    expect(resolveHTTPPort({ PORT: "4312", MCP_HTTP_PORT: "8088" })).toBe(4312);
    expect(resolveHTTPPort({ MCP_HTTP_PORT: "8088" })).toBe(8088);
    expect(resolveHTTPPort({})).toBe(8080);
  });

  it("binds the listener to 0.0.0.0", () => {
    expect((server!.address() as AddressInfo).address).toBe("0.0.0.0");
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

  it("preserves authenticated MCP HTTP request handling", async () => {
    mocks.dispatch.mockImplementation(async (body: unknown, res: http.ServerResponse) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ accepted: true, body }));
    });
    const result = await request("/", "POST", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(result).toMatchObject({ status: 200, body: { accepted: true } });
    expect(mocks.verifyJWT).toHaveBeenCalledWith("test-token");
    expect(mocks.getAgentId).toHaveBeenCalledWith("render-test-user", expect.anything());
  });

  it("keeps stdio as the default transport and honors explicit transport selection", () => {
    expect(resolveMCPTransport(undefined)).toBe("stdio");
    expect(resolveMCPTransport("stdio")).toBe("stdio");
    expect(resolveMCPTransport("http")).toBe("http");
  });
});
