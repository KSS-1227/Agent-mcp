import * as http from "http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { verifySupabaseJWT, extractBearerToken } from "../auth/jwt-verifier";
import { getAgentIdForUser } from "../auth/user-agent-mapping";
import { DatabaseClient } from "../database/client";

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
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // Stateless mode
  });

  const httpServer = http.createServer(async (req, res) => {
    // Handle CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
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

          await transport.handleRequest(req, res, jsonBody);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          res.writeHead(400);
          res.end(JSON.stringify({ error: message }));
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

  return new Promise((resolve, reject) => {
    httpServer.listen(port, "127.0.0.1", () => {
      console.error(`[MCP HTTP] Authenticated HTTP server listening on port ${port}`);
      resolve(httpServer);
    });

    httpServer.on("error", (err) => {
      console.error(`[MCP HTTP] Server error: ${err.message}`);
      reject(err);
    });
  });
}

export { StreamableHTTPServerTransport };
