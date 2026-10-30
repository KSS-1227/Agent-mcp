import * as http from "http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { verifySupabaseJWT, extractBearerToken } from "../auth/jwt-verifier";
import { getAgentIdForUser } from "../auth/user-agent-mapping";
import { DatabaseClient } from "../database/client";
import { handleHealthRequest } from "../health/server";

export function resolveHTTPPort(env: NodeJS.ProcessEnv = process.env): number {
  const configured = env.PORT?.trim() || env.MCP_HTTP_PORT?.trim() || "8080";
  const port = Number(configured);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT or MCP_HTTP_PORT must be an integer between 1 and 65535");
  }
  return port;
}

/**
 * HTTP MCP Transport with JWT Authentication
 * 
 * Stateless HTTP server that requires JWT tokens on every request.
 * Maps JWT user_id to agent_id via auth_users table before tool dispatch.
 */

interface AuthenticatedRequest {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  userId: string;
  agentId: string;
}

interface MCPServerInternals {
  _serverInfo: { name: string; version: string };
  _capabilities: Record<string, unknown>;
  _instructions?: string;
  _requestHandlers: Map<string, (...args: any[]) => any>;
  _notificationHandlers: Map<string, (...args: any[]) => any>;
  fallbackRequestHandler?: (...args: any[]) => any;
  fallbackNotificationHandler?: (...args: any[]) => any;
}

function createStatelessRequestServer(template: Server): Server {
  const source = template as unknown as MCPServerInternals;
  const requestServer = new Server(source._serverInfo, {
    capabilities: source._capabilities,
    instructions: source._instructions,
  });
  const target = requestServer as unknown as MCPServerInternals;

  // The installed SDK's stateless Streamable HTTP transport is single-request
  // by design. Copy the registered handlers to a fresh Protocol instance for
  // each request while retaining the template's service/database closures.
  for (const [method, handler] of source._requestHandlers) {
    if (method !== "initialize") target._requestHandlers.set(method, handler);
  }
  for (const [method, handler] of source._notificationHandlers) {
    if (method !== "notifications/initialized") target._notificationHandlers.set(method, handler);
  }
  target.fallbackRequestHandler = source.fallbackRequestHandler;
  target.fallbackNotificationHandler = source.fallbackNotificationHandler;
  return requestServer;
}

/**
 * Verify JWT and extract authenticated identity
 * Called before tool handler dispatch
 */
async function authenticateRequest(
  req: http.IncomingMessage,
  db: DatabaseClient
): Promise<{ userId: string; agentId: string }> {
  const authHeader = req.headers.authorization as string;
  const token = extractBearerToken(authHeader);

  if (!token) {
    throw new Error("[401] Missing Authorization header");
  }

  // Verify JWT signature, issuer, expiry, audience, subject
  const verified = await verifySupabaseJWT(token);

  // Look up agent_id from auth_users table
  const agentId = await getAgentIdForUser(verified.user_id, db);

  return {
    userId: verified.user_id,
    agentId,
  };
}

/**
 * Create HTTP server with JWT authentication middleware
 */
export async function createHTTPMCPServer(
  mcpServer: Server,
  db: DatabaseClient,
  port: number = 8080
): Promise<http.Server> {
  const httpServer = http.createServer(async (req, res) => {
    // Render exposes one service port. Serve health checks on this same listener
    // while preserving the existing unauthenticated health endpoint semantics.
    if (req.method === "GET" && req.url?.startsWith("/health")) {
      await handleHealthRequest(req, res);
      return;
    }

    // Handle CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    // The MCP endpoint is mounted at /mcp. Reject other paths before method
    // handling so only the declared routes can produce MCP responses.
    if (req.url !== "/mcp") {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // This stateless server uses JSON responses and does not maintain an SSE
    // stream. Make the unsupported GET behavior explicit to Streamable HTTP clients.
    if (req.method === "GET") {
      res.writeHead(405, { Allow: "POST" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    try {
      // Authenticate request and extract identity
      const auth = await authenticateRequest(req, db);

      // Parse request body
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });

      req.on("end", async () => {
        try {
          const jsonBody = JSON.parse(body);

          if (jsonBody.method === "tools/call") {
            if (!jsonBody.params || typeof jsonBody.params !== "object") {
              throw new Error("Invalid tools/call request parameters");
            }

            const suppliedArguments = jsonBody.params.arguments;
            if (
              suppliedArguments !== undefined &&
              (suppliedArguments === null ||
                typeof suppliedArguments !== "object" ||
                Array.isArray(suppliedArguments))
            ) {
              throw new Error("Tool arguments must be an object");
            }

            const toolArguments = suppliedArguments || {};
            // Tool authorization consumes arguments, so bind every supported
            // identity alias here from the verified HTTP authentication context.
            toolArguments.agentId = auth.agentId;
            toolArguments.agent_id = auth.agentId;
            toolArguments.callingAgent = auth.agentId;
            jsonBody.params.arguments = toolArguments;
          }

          const requestServer = createStatelessRequestServer(mcpServer);
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined, // Stateless mode
            enableJsonResponse: true,
          });
          try {
            // Connect each fresh stateless SDK transport exactly once before
            // dispatching its one request; the SDK rejects transport reuse.
            await requestServer.connect(transport);
            await transport.handleRequest(req, res, jsonBody);
          } finally {
            await requestServer.close().catch(() => undefined);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          if (!res.headersSent) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: message }));
          } else {
            res.destroy(error instanceof Error ? error : undefined);
          }
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";

      if (message.includes("[401]")) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: "Unauthorized" }));
      } else if (message.includes("JWT verification failed")) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: "Forbidden" }));
      } else if (message.includes("Agent mapping lookup failed")) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: "Forbidden" }));
      } else {
        res.writeHead(500);
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  });

  return new Promise<http.Server>((resolve, reject) => {
    const onListening = () => {
      httpServer.off("listening", onListening);
      console.error(`[MCP HTTP] Authenticated HTTP server listening on port ${port}`);
      resolve(httpServer);
    };
    const onError = (err: Error) => {
      httpServer.off("listening", onListening);
      console.error(`[MCP HTTP] Server error: ${err.message}`);
      reject(err);
    };
    httpServer.once("listening", onListening);
    httpServer.on("error", onError);
    httpServer.listen(port, "0.0.0.0");
  });
}

export { StreamableHTTPServerTransport };
