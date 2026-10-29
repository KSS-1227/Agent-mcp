/**
 * MCP Server - Model Context Protocol implementation
 * 
 * Thin interface layer over existing services.
 * Authorization enforced for all tools via wrapper middleware.
 * Supports both stdio (local) and HTTP (authenticated remote) transports.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ActionCoordinator } from "../recovery-engine/coordinator";
import { ActionReconciler, type ActionVerifier, type Embedder } from "../recovery-engine/reconciliation";
import { getVerifierRegistry, ProductionActionVerifierDispatcher } from "../recovery-engine/verifier_registry";
import { githubRepository, githubToken, GITHUB_CREATE_ISSUE, GitHubIssueVerifier } from "../recovery-engine/github-issue";
import { OllamaEmbedder } from "../recovery-engine/ollama-embedder";
import { getAgentService } from "../core/agent.service";
import { getResourceService } from "../core/resource.service";
import { getTaskService } from "../core/task.service";
import { getIntentService } from "../conflict-engine/intent.service";
import { getAgentServiceTools } from "./tools/agents";
import { getResourceServiceTools } from "./tools/resources";
import { getTaskServiceTools } from "./tools/tasks";
import { getIntentServiceTools } from "./tools/intents";
import { getConflictDetectionTools } from "./tools/conflicts";
import { getActionProtocolTools, resolveReconcilerAgentId } from "./tools/actions";
import { getStatusQueryTools } from "./tools/status";
import { applyAuthorizationToTools } from "./tools/authorization-wrapper";
import { createDatabaseClient as createDatabase } from "../database/client";
import type { ToolWithHandler } from "./tools/agents";
import { setRecoveryRuntimeHealth } from "../health/recovery-runtime";

interface RecoveryRuntime {
  database: ReturnType<typeof createDatabase>;
  agentId: string;
  verifier: ActionVerifier;
  references: number;
  stop: () => Promise<void>;
}

interface RecoveryLease {
  release: () => Promise<void>;
  ownsDatabase: boolean;
}

interface ServerLifecycle {
  database: ReturnType<typeof createDatabase>;
  shutdown: () => Promise<void>;
}

let recoveryRuntime: RecoveryRuntime | null = null;
let recoveryStarting: Promise<RecoveryRuntime> | null = null;
let recoveryStopping: Promise<void> | null = null;
const closedDatabases = new WeakSet<object>();
const serverLifecycles = new WeakMap<Server, ServerLifecycle>();

async function closeDatabase(database: ReturnType<typeof createDatabase>): Promise<void> {
  if (closedDatabases.has(database)) return;
  closedDatabases.add(database);
  await database.close();
}

async function acquireRecoveryLoop(
  database: ReturnType<typeof createDatabase>,
  agentId: string,
  verifier: ActionVerifier,
  embedder?: Embedder
): Promise<RecoveryLease> {
  if (!embedder) {
    throw new Error(
      "Crash recovery is unavailable: configure a production episode embedder that returns 1024 dimensions for episodes.embedding"
    );
  }
  if (!recoveryRuntime && recoveryStopping) {
    await recoveryStopping;
    return acquireRecoveryLoop(database, agentId, verifier, embedder);
  }
  let runtime = recoveryRuntime;
  if (!runtime) {
    if (!recoveryStarting) {
      recoveryStarting = (async () => {
        const pool = (database as any).pool;
        const coordinator = new ActionCoordinator(pool, agentId, 120);
        const reconciler = new ActionReconciler(
          pool,
          coordinator,
          verifier,
          embedder,
          agentId,
          120
        );
        const stop = await reconciler.run();
        return { database, agentId, verifier, references: 0, stop };
      })();
    }
    const pending = recoveryStarting;
    try {
      runtime = await pending;
      recoveryRuntime = runtime;
    } catch (error) {
      if (recoveryStarting === pending) recoveryStarting = null;
      throw error;
    }
    if (recoveryStarting === pending) recoveryStarting = null;
  }

  if (!runtime) {
    throw new Error("Recovery loop startup did not produce a runtime");
  }
  if (runtime.agentId !== agentId) {
    throw new Error("A recovery loop is already running with a different reconciler identity");
  }
  const activeRuntime = runtime;
  activeRuntime.references++;

  let released = false;
  return {
    ownsDatabase: activeRuntime.database === database,
    release: async () => {
      if (released) return;
      released = true;
      activeRuntime.references--;
      if (activeRuntime.references === 0 && recoveryRuntime === activeRuntime) {
        recoveryRuntime = null;
        const stopping = (async () => {
          try {
            await activeRuntime.stop();
          } finally {
            await closeDatabase(activeRuntime.database);
          }
        })();
        recoveryStopping = stopping;
        try { await stopping; }
        finally { if (recoveryStopping === stopping) recoveryStopping = null; }
      }
    },
  };
}

function getServerLifecycle(server: Server): ServerLifecycle {
  const lifecycle = serverLifecycles.get(server);
  if (!lifecycle) throw new Error("MCP server lifecycle is unavailable");
  return lifecycle;
}

export async function createMCPServer() {
  const server = new Server({
    name: "agent-safety-mcp",
    version: "1.0.0",
  });

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || !databaseUrl.startsWith("postgresql://")) {
    throw new Error("DATABASE_URL must be set to a PostgreSQL connection string before starting the MCP server");
  }
  const db = createDatabase({ connectionString: databaseUrl });
  let recoveryLease: RecoveryLease | undefined;
  try {
  const verifierRegistry = getVerifierRegistry();
  const token = githubToken();
  const repository = githubRepository();
  if (token && repository) {
    verifierRegistry.registerProduction(GITHUB_CREATE_ISSUE, new GitHubIssueVerifier(token));
  } else if (token) {
    console.warn("[Recovery] GitHub verifier not registered: GITHUB_REPOSITORY must be configured as owner/repository");
  }
  const agentService = getAgentService();
  const resourceService = getResourceService();
  const taskService = getTaskService();
  const intentService = getIntentService();

  resourceService.setDatabase(db);
  intentService.setDatabase(db);
  agentService.setDatabase(db);
  taskService.setDatabase(db);
  await Promise.all([
    agentService.loadFromDatabase(),
    taskService.loadFromDatabase(),
    resourceService.loadFromDatabase(),
    intentService.loadFromDatabase(),
  ]);

  const productionVerifierIds = verifierRegistry.listProduction();
  setRecoveryRuntimeHealth({ productionVerifierCount: productionVerifierIds.length });
  if (productionVerifierIds.length === 0) {
    setRecoveryRuntimeHealth({ state: "disabled", enabled: false });
    console.warn("[Recovery] Automatic recovery disabled: no production action verifiers are registered");
  } else {
    try {
      const embedder = new OllamaEmbedder();
      await embedder.checkAvailability();
      const verifier = new ProductionActionVerifierDispatcher(verifierRegistry);
      const reconcilerAgentId = await resolveReconcilerAgentId(agentService, (db as any).pool);
      recoveryLease = await acquireRecoveryLoop(db, reconcilerAgentId, verifier, embedder);
    } catch {
      setRecoveryRuntimeHealth({ state: "error", enabled: false, failure: true });
      console.warn("[Recovery] Automatic recovery disabled: Ollama or recovery initialization is unavailable");
    }
  }

  let allTools: ToolWithHandler[] = [
    ...getAgentServiceTools(agentService),
    ...getResourceServiceTools(resourceService),
    ...getTaskServiceTools(taskService),
    ...getIntentServiceTools(intentService, agentService, resourceService, taskService),
    ...getConflictDetectionTools(resourceService, intentService),
    ...getActionProtocolTools(db),
    ...getStatusQueryTools(agentService, intentService),
  ];

  // Prepare services for authorization checks
  const authServices = {
    taskService,
    intentService,
    db,
  };

  // AUTHORIZATION: Wrap all tools with authorization enforcement
  allTools = applyAuthorizationToTools(allTools, authServices);

  // Store handlers
  const handlers = new Map<string, (args: any) => Promise<any>>();
  const toolDefs: any[] = [];

  for (const tool of allTools) {
    const { _handler, ...toolDef } = tool;
    handlers.set(tool.name, _handler);
    toolDefs.push(toolDef);
  }

  // Minimal handlers for tools/list and tools/call
  (server as any)._requestHandlers = (server as any)._requestHandlers || new Map();
  
  (server as any)._requestHandlers.set("tools/list", async () => ({
    tools: toolDefs,
  }));

  (server as any)._requestHandlers.set("tools/call", async (params: any) => {
    const handler = handlers.get(params.name);
    if (!handler) throw new Error(`Tool not found: ${params.name}`);

    try {
      const result = await handler(params.arguments || {});
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          { type: "text", text: JSON.stringify({ error: message }, null, 2) },
        ],
        isError: true,
      };
    }
  });

  const lease = recoveryLease;
  let shuttingDown: Promise<void> | undefined;
  serverLifecycles.set(server, {
    database: db,
    shutdown: () => {
      if (!shuttingDown) {
        shuttingDown = (async () => {
          try {
            await server.close();
          } finally {
            if (lease) {
              try {
                await lease.release();
              } finally {
                if (!lease.ownsDatabase) await closeDatabase(db);
              }
            } else {
              await closeDatabase(db);
            }
          }
        })();
      }
      return shuttingDown;
    },
  });
  return server;
  } catch (error) {
    if (recoveryLease) {
      try {
        await recoveryLease.release();
      } finally {
        if (!recoveryLease.ownsDatabase) await closeDatabase(db);
      }
    } else {
      await closeDatabase(db);
    }
    throw error;
  }
}

export async function startMCPServer() {
  const server = await createMCPServer();
  const transport = new StdioServerTransport();
  try {
    await server.connect(transport);
  } catch (error) {
    await getServerLifecycle(server).shutdown();
    throw error;
  }
  console.error("[MCP] Server started with stdio transport (26 tools)");
  return () => getServerLifecycle(server).shutdown();
}

export async function startHTTPMCPServer() {
  const server = await createMCPServer();
  const lifecycle = getServerLifecycle(server);
  let httpServer;
  try {
    const { createHTTPMCPServer } = await import("./http-transport.js");
    const port = parseInt(process.env.MCP_HTTP_PORT || "8080", 10);
    httpServer = await createHTTPMCPServer(server, lifecycle.database, port);
  } catch (error) {
    await lifecycle.shutdown();
    throw error;
  }
  let stopping: Promise<void> | undefined;
  return () => {
    if (!stopping) {
      stopping = new Promise<void>((resolve, reject) => {
        httpServer!.close((error) => error ? reject(error) : resolve());
      }).finally(() => lifecycle.shutdown());
    }
    return stopping;
  };
}
