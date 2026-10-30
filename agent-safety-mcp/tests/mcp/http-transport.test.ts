import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentService } from "../../src/core/agent.service";
import { TaskService } from "../../src/core/task.service";
import {
  resetAgentService,
  setAgentServiceForTesting,
} from "../../src/auth/authorization";
import {
  withAuthorization,
  type ToolWithHandler,
} from "../../src/mcp/tools/authorization-wrapper";
import { getTaskServiceTools } from "../../src/mcp/tools/tasks";
import { createHTTPMCPServer } from "../../src/mcp/http-transport";

const authMocks = vi.hoisted(() => ({
  verifyJWT: vi.fn(),
  getAgentId: vi.fn(),
  dispatch: vi.fn(),
}));

vi.mock("../../src/auth/jwt-verifier", () => ({
  verifySupabaseJWT: authMocks.verifyJWT,
  extractBearerToken: (header?: string) =>
    header?.startsWith("Bearer ") ? header.substring(7) : null,
}));

vi.mock("../../src/auth/user-agent-mapping", () => ({
  getAgentIdForUser: authMocks.getAgentId,
}));

interface HttpResult {
  status: number;
  body: any;
}

let httpServer: http.Server | undefined;

function post(body: unknown, token?: string): Promise<HttpResult> {
  if (!httpServer) {
    throw new Error("HTTP server has not been started");
  }
  const address = httpServer.address() as AddressInfo;

  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port: address.port,
        path: "/mcp",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-03-26",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          const parsed = responseBody ? JSON.parse(responseBody) : undefined;
          const toolText = parsed?.result?.content?.find((item: any) => item.type === "text")?.text;
          resolve({
            status: response.statusCode || 0,
            body: toolText ? JSON.parse(toolText) : parsed,
          });
        });
      }
    );

    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}

async function startServer(): Promise<void> {
  const mcpServer = new Server(
    { name: "http-auth-test", version: "1.0.0" },
    { capabilities: { tools: { listChanged: false } } }
  );
  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await authMocks.dispatch(request.params);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });
  httpServer = await createHTTPMCPServer(mcpServer, {} as any, 0);
}

function useToolHandler(handler: (args: any) => Promise<any>): void {
  authMocks.dispatch.mockImplementation(async (params) => {
    try {
      return await handler(params.arguments || {});
    } catch (error) {
      return {
        isError: true,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

describe("HTTP MCP Transport authentication", () => {
  beforeEach(async () => {
    authMocks.verifyJWT.mockReset();
    authMocks.verifyJWT.mockResolvedValue({ user_id: "user-a" });
    authMocks.getAgentId.mockReset();
    authMocks.getAgentId.mockResolvedValue("authenticated-agent");
    authMocks.dispatch.mockReset();
    useToolHandler(async (args) => args);
    await startServer();
  });

  afterEach(async () => {
    if (httpServer) {
      await new Promise<void>((resolve, reject) => {
        httpServer!.close((error) => (error ? reject(error) : resolve()));
      });
      httpServer = undefined;
    }
    resetAgentService();
    vi.restoreAllMocks();
  });

  it("requires an Authorization bearer token", async () => {
    const response = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "example", arguments: {} },
    });

    expect(response.status).toBe(401);
    expect(authMocks.verifyJWT).not.toHaveBeenCalled();
    expect(authMocks.dispatch).not.toHaveBeenCalled();
  });

  it("rejects an invalid JWT before dispatch", async () => {
    authMocks.verifyJWT.mockRejectedValue(
      new Error("JWT verification failed: invalid signature")
    );

    const response = await post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "example", arguments: {} },
      },
      "invalid-token"
    );

    expect(response.status).toBe(403);
    expect(authMocks.getAgentId).not.toHaveBeenCalled();
    expect(authMocks.dispatch).not.toHaveBeenCalled();
  });

  it("rejects a user without an agent mapping before dispatch", async () => {
    authMocks.getAgentId.mockRejectedValue(
      new Error("Agent mapping lookup failed: user not registered")
    );

    const response = await post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "example", arguments: {} },
      },
      "valid-token"
    );

    expect(response.status).toBe(403);
    expect(authMocks.dispatch).not.toHaveBeenCalled();
  });

  it("passes the verified identity to the handler and overwrites forged aliases", async () => {
    const handler = vi.fn(async (args: any) => args);
    useToolHandler(handler);
    const response = await post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "example",
          arguments: {
            agentId: "forged-agent",
            agent_id: "forged-agent",
            callingAgent: "forged-agent",
            value: "preserved",
          },
        },
      },
      "valid-token"
    );

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledWith({
      agentId: "authenticated-agent",
      agent_id: "authenticated-agent",
      callingAgent: "authenticated-agent",
      value: "preserved",
    });
  });

  it("authorizes protected operations as the authenticated agent, not a forged owner", async () => {
    const agentService = new AgentService();
    const owner = agentService.registerAgent("owner", "Owner");
    const attacker = agentService.registerAgent("attacker", "Attacker");
    setAgentServiceForTesting(agentService);
    authMocks.getAgentId.mockResolvedValue(attacker.id);

    const taskService = new TaskService();
    const ownerTask = taskService.createTask(owner.id, "Owner task");
    const operation = vi.fn(async () => ({ updated: true }));
    const protectedTool: ToolWithHandler = {
      name: "update_task_status",
      inputSchema: {},
      _handler: operation,
    };
    const authorizedHandler = withAuthorization(protectedTool, { taskService })
      ._handler;
    useToolHandler(authorizedHandler);

    const response = await post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "update_task_status",
          arguments: {
            taskId: ownerTask.id,
            status: "completed",
            agentId: owner.id,
            agent_id: owner.id,
          },
        },
      },
      "valid-token"
    );

    expect(response.status).toBe(200);
    expect(response.body.isError).toBe(true);
    expect(response.body.message).toMatch(/\[403\] Access denied/);
    expect(operation).not.toHaveBeenCalled();
  });

  it("allows the authenticated owner to proceed through authorization", async () => {
    const agentService = new AgentService();
    const owner = agentService.registerAgent("owner", "Owner");
    setAgentServiceForTesting(agentService);
    authMocks.getAgentId.mockResolvedValue(owner.id);

    const taskService = new TaskService();
    const ownerTask = taskService.createTask(owner.id, "Owner task");
    const operation = vi.fn(async () => ({ updated: true }));
    const protectedTool: ToolWithHandler = {
      name: "update_task_status",
      inputSchema: {},
      _handler: operation,
    };
    useToolHandler(
      withAuthorization(protectedTool, { taskService })._handler
    );

    const response = await post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "update_task_status",
          arguments: { taskId: ownerTask.id, status: "completed" },
        },
      },
      "valid-token"
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ updated: true });
    expect(operation).toHaveBeenCalledOnce();
  });

  it("scopes task lists to the verified HTTP identity despite a forged agentId", async () => {
    const agentService = new AgentService();
    const owner = agentService.registerAgent("owner", "Owner");
    const authenticated = agentService.registerAgent("authenticated", "Authenticated");
    setAgentServiceForTesting(agentService);
    authMocks.getAgentId.mockResolvedValue(authenticated.id);

    const taskService = new TaskService();
    taskService.createTask(owner.id, "Private owner task");
    const authenticatedTask = taskService.createTask(
      authenticated.id,
      "Authenticated task"
    );
    const listTool = getTaskServiceTools(taskService).find(
      (tool) => tool.name === "list_tasks"
    )!;
    const authorizedHandler = withAuthorization(listTool, { taskService })._handler;
    useToolHandler(authorizedHandler);

    const response = await post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "list_tasks",
          arguments: { agentId: owner.id },
        },
      },
      "valid-token"
    );

    expect(response.status).toBe(200);
    expect(response.body.tasks).toHaveLength(1);
    expect(response.body.tasks[0].id).toBe(authenticatedTask.id);
    expect(response.body.tasks[0].agentId).toBe(authenticated.id);
    expect(JSON.stringify(response.body)).not.toContain("Private owner task");
  });

  it("rejects non-object tool arguments without dispatch", async () => {
    const response = await post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "example", arguments: [] },
      },
      "valid-token"
    );

    expect(response.status).toBe(400);
    expect(authMocks.dispatch).not.toHaveBeenCalled();
  });
});
