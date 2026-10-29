/**
 * Health Check HTTP Server
 * 
 * Minimal HTTP server for health check endpoints.
 * Runs on port 8081 (configurable via HEALTH_PORT env var).
 * Does NOT depend on Express or other frameworks—uses Node.js http module only.
 * 
 * Endpoints:
 *  GET /health/live  → 200 (always, if process is running)
 *  GET /health/ready → 200 (if dependencies ready) or 503 (if not)
 *  GET /health/recovery → 200 (process-local reconciler runtime telemetry)
 * 
 * Non-existent paths return 404.
 */

import * as http from "http";
import { checkLiveness, checkReadiness } from "./checks";
import { getRecoveryRuntimeHealth } from "./recovery-runtime";

const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || "8081", 10);

/**
 * Open the health listener. The application entrypoint owns startup and calls
 * this exactly once; importing this module never opens a listener.
 */
export async function startHealthServer(): Promise<() => Promise<void>> {
  const server = http.createServer(handleHealthRequest);

  return new Promise((resolve, reject) => {
    server.listen(HEALTH_PORT, () => {
      console.error(`[Health] Server listening on port ${HEALTH_PORT}`);
      resolve(() => new Promise<void>((closeResolve, closeReject) => {
        server.close((error) => error ? closeReject(error) : closeResolve());
      }));
    });

    server.on("error", (err) => {
      console.error(`[Health] Server error: ${err.message}`);
      reject(err);
    });
  });
}

export async function handleHealthRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    // Set CORS headers to allow external health checks
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json");

    try {
      if (pathname === "/health/live" && req.method === "GET") {
        const status = await checkLiveness();
        res.writeHead(200);
        res.end(JSON.stringify(status));
      } else if (pathname === "/health/ready" && req.method === "GET") {
        const status = await checkReadiness();
        const statusCode = status.status === "healthy" ? 200 : 503;
        res.writeHead(statusCode);
        res.end(JSON.stringify(status));
      } else if (pathname === "/health/recovery" && req.method === "GET") {
        res.writeHead(200);
        res.end(JSON.stringify(getRecoveryRuntimeHealth()));
      } else {
        // Not found
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Not found" }));
      }
    } catch (error) {
      // Generic error response; never expose internals
      res.writeHead(500);
      res.end(
        JSON.stringify({
          status: "unhealthy",
          reason: "Internal server error",
          timestamp: new Date().toISOString(),
        })
      );
    }
}

