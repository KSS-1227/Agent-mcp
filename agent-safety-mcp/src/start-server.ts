/**
 * MCP Server Entry Point
 * 
 * Starts the Agent Safety MCP server with configurable transport:
 * - stdio: Local development (no auth)
 * - http: Remote authenticated (JWT required)
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function resolveMCPTransport(value = process.env.MCP_TRANSPORT): string {
  return value || "stdio";
}

async function main() {
  console.error("[Agent Safety MCP] Starting server...");

  const appDirectory = dirname(fileURLToPath(import.meta.url));
  const { loadApplicationEnvironment } = await import("./config/load-environment");
  loadApplicationEnvironment(resolve(appDirectory, "../.env"));
  const { validateEnvironment } = await import("./config/index");
  const { startMCPServer, startHTTPMCPServer } = await import("./mcp/server");
  const { startHealthServer } = await import("./health/server");
  const { getConflictAdjudicationProviderLabel, getConflictAdjudicationProviderStartupWarning } = await import("./providers");

  let stopMcpServer: (() => Promise<void>) | undefined;
  let stopHealthServer: (() => Promise<void>) | undefined;
  try {
    validateEnvironment();
    console.error(`[Config] Environment validated`);
    const providerWarning = getConflictAdjudicationProviderStartupWarning();
    if (providerWarning) console.error(`[Warning] ${providerWarning}`);
    console.error(`[Config] Conflict adjudicator: ${getConflictAdjudicationProviderLabel()}`);
    
    const transport = resolveMCPTransport();
    console.error(`[Config] MCP Transport: ${transport}`);

    // HTTP mode serves health routes on the public MCP listener. Stdio mode
    // keeps the standalone local health listener used by existing deployments.
    const healthServerPromise = transport === "http"
      ? Promise.resolve(undefined)
      : startHealthServer().then((stop) => {
        stopHealthServer = stop;
        return stop;
      });

    // Start MCP server with chosen transport
    const mcpServerPromise = (transport === "http"
      ? startHTTPMCPServer()
      : startMCPServer()).then((stop) => {
      stopMcpServer = stop;
      return stop;
    });
    const startupResults = await Promise.allSettled([
      healthServerPromise,
      mcpServerPromise,
    ]);
    const startupFailure = startupResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    if (startupFailure) {
      await Promise.allSettled([stopMcpServer?.(), stopHealthServer?.()]);
      throw startupFailure.reason;
    }

    const shutdown = async () => {
      process.off("SIGINT", handleSignal);
      process.off("SIGTERM", handleSignal);
      await Promise.allSettled([
        stopMcpServer?.(),
        stopHealthServer?.(),
      ]);
    };
    const handleSignal = () => {
      void shutdown().catch((error) => {
        console.error("[Shutdown] Cleanup failed:", error);
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);
  } catch (error) {
    await Promise.allSettled([stopMcpServer?.(), stopHealthServer?.()]);
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Fatal] ${message}`);
    process.exit(1);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  void main();
}
