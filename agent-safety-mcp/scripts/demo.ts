/**
 * Agent Safety MCP - end-to-end demo
 *
 * Drives the real MCP tool layer (server registration + authorization wrapper +
 * tool handlers + database) through one complete agent workflow:
 *
 *   system agent bootstrap -> worker registration -> resource -> task -> intent
 *   -> exactly-once action (prepare / status / complete / idempotent replay)
 *   -> conflict gate rejection -> reconciliation
 *
 * Prerequisites (this script never reads .env and never prints the connection string):
 *   1. Migrations applied:      $env:RUN_DATABASE_MIGRATIONS = "1"; npm run db:migrate
 *   2. DATABASE_URL exported in the current shell, e.g.
 *        PowerShell:  $env:DATABASE_URL = "postgresql://user:pass@host:5432/db"
 *        bash:        export DATABASE_URL="postgresql://user:pass@host:5432/db"
 *   3. Runtime configuration includes SUPABASE_URL and
 *      SUPABASE_SERVICE_ROLE_KEY. Ollama is optional; it is used for automatic
 *      action recovery only when a production verifier (currently GitHub via
 *      GITHUB_TOKEN) is registered. The demo workflow does not require it.
 *
 * Run the whole demo:
 *   PowerShell:  $env:RUN_DEMO = "1"; npm run demo
 *   bash:        RUN_DEMO=1 npm run demo
 *
 * Bootstrap the system agent only (no workflow):
 *   PowerShell:  $env:RUN_DEMO = "1"; npm run db:seed
 *
 * Seed-only persists the system-agent row (reusing it by key on repeat runs).
 * The full demo additionally persists a worker agent, resource, task, two intents
 * and their reads/steps, plus action/episode records and resource-version snapshots
 * from action preparation. Reconciliation may add evidence depending on its
 * result. Run only against a dedicated disposable database: records are persistent,
 * and this script does not clean them up.
 */

import { getAgentService } from "../src/core/agent.service";
import { createDatabaseClient } from "../src/database/client";

const SYSTEM_AGENT_KEY = "agent-safety-system";
const EXPECTED_TOOL_COUNT = 27;

type ToolList = { name: string };
type ToolResult = { content?: Array<{ text?: string }>; isError?: boolean };

function abort(message: string): never {
  console.error(`\n[DEMO] Aborted: ${message}\n`);
  process.exit(1);
}

function requireExplicitOptIn(): void {
  if (process.env.RUN_DEMO !== "1") {
    console.error(
      "[DEMO] Refusing to touch the database without explicit opt-in.\n" +
        "       PowerShell: $env:RUN_DEMO = \"1\"; npm run demo\n" +
        "       bash:       RUN_DEMO=1 npm run demo"
    );
    process.exit(2);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || !databaseUrl.startsWith("postgresql://")) {
    console.error(
      "[DEMO] DATABASE_URL must be exported as a postgresql:// connection string.\n" +
        "       This script deliberately does not read .env."
    );
    process.exit(2);
  }
}

/**
 * Production authorization reads SYSTEM_AGENT_IDS on every privileged call.
 * register_agent only ever mints a fresh UUID, so the bootstrap system agent is
 * registered here and then added to the override list. This runs inside the
 * operator's own process, exactly like the database credentials it already holds.
 */
async function bootstrapSystemAgent(): Promise<string> {
  const agentService = getAgentService();
  const systemAgent = await agentService.registerAgent(SYSTEM_AGENT_KEY, "Agent Safety System", {
    systemAgent: true,
    purpose: "demo_bootstrap",
  });

  const configured = (process.env.SYSTEM_AGENT_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (!configured.includes(systemAgent.id)) {
    process.env.SYSTEM_AGENT_IDS = [...configured, systemAgent.id].join(",");
  }
  return systemAgent.id;
}

async function seedSystemAgent(): Promise<string> {
  const database = createDatabaseClient({ connectionString: process.env.DATABASE_URL! });
  try {
    const agentService = getAgentService();
    agentService.setDatabase(database);
    await agentService.loadFromDatabase();
    const agent = await agentService.registerAgent(SYSTEM_AGENT_KEY, "Agent Safety System", {
      systemAgent: true,
      purpose: "demo_bootstrap",
    });
    return agent.id;
  } finally {
    await database.close();
  }
}

async function main(): Promise<void> {
  requireExplicitOptIn();
  const seedOnly = process.argv.includes("--seed-only");

  console.log(seedOnly ? "Agent Safety MCP - system-agent seed" : "Agent Safety MCP - end-to-end demo");
  console.log("----------------------------------");

  if (seedOnly) {
    console.log("\nPersisting system agent");
    const systemAgentId = await seedSystemAgent();
    console.log(`   persisted system agent: ${systemAgentId}`);
    console.log("   To authorize it, set SYSTEM_AGENT_IDS in each server process; that override applies only to that process and this command does not configure your shell.");
    return;
  }

  const { createMCPServer } = await import("../src/mcp/server");
  const server = await createMCPServer();
  const handlers = (server as any)._requestHandlers as
    | Map<string, (params?: any) => Promise<any>>
    | undefined;
  const listHandler = handlers?.get("tools/list");
  const callHandler = handlers?.get("tools/call");
  if (!listHandler || !callHandler) abort("MCP request handlers were not registered");

  const callTool = async (name: string, args: Record<string, unknown>): Promise<any> => {
    const result = (await callHandler({ name, arguments: args })) as ToolResult;
    const text = result?.content?.[0]?.text ?? "{}";
    let payload: any;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
    if (result?.isError) throw new Error(payload?.error ?? text);
    return payload;
  };

  const expectDenied = async (
    label: string,
    name: string,
    args: Record<string, unknown>,
    pattern: RegExp
  ): Promise<void> => {
    try {
      await callTool(name, args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!pattern.test(message)) abort(`${label}: expected ${pattern} but got: ${message}`);
      console.log(`   denied as expected: ${message}`);
      return;
    }
    abort(`${label}: expected a denial but the call succeeded`);
  };

  console.log("\n[1/6] Bootstrap system agent");
  const systemAgentId = await bootstrapSystemAgent();
  console.log(`   system agent: ${systemAgentId}`);

  console.log("\n[2/6] MCP tool discovery");
  const { tools } = (await listHandler()) as { tools: ToolList[] };
  const names = tools.map((tool) => tool.name).sort();
  console.log(`   ${names.length} tools registered`);
  if (names.length !== EXPECTED_TOOL_COUNT) {
    console.warn(`   warning: expected ${EXPECTED_TOOL_COUNT} tools, found ${names.length}`);
  }
  console.log(`   ${names.join(", ")}`);

  const suffix = Date.now().toString(36);

  console.log("\n[3/6] Register a worker agent (system-only tool)");
  const worker = await callTool("register_agent", {
    agentId: systemAgentId,
    agent_key: `demo-worker-${suffix}`,
    name: "Demo Worker Agent",
    metadata: { demo: true },
  });
  console.log(`   worker agent: ${worker.id}`);
  await expectDenied(
    "register_agent called by a non-system agent",
    "register_agent",
    { agentId: worker.id, agent_key: `demo-denied-${suffix}`, name: "Denied Agent" },
    /system authorization/
  );

  console.log("\n[4/6] Resource, task, intent");
  const resource = await callTool("register_resource", {
    resource_key: `demo:config:${suffix}`,
    resource_type: "config",
    state: { replicas: 2 },
  });
  console.log(`   resource ${resource.key} at version ${resource.version}`);

  const task = await callTool("create_task", {
    agentId: worker.id,
    taskKey: `demo-task-${suffix}`,
    description: "Scale the demo service",
  });
  console.log(`   task ${task.id}`);

  const intent = await callTool("declare_intent", {
    agent_id: worker.id,
    task_id: task.id,
    statement: "Scale the demo service from 2 to 4 replicas",
    reads: [{ resource_id: resource.id, observed_version: resource.version }],
    plan_steps: [{ description: "Apply the replica change", depends_on: [resource.id] }],
  });
  const stepId = intent.steps?.[0]?.id;
  if (!stepId) abort("declare_intent returned no plan steps");
  console.log(`   intent ${intent.id} with step ${stepId}`);

  const conflictBefore = await callTool("check_conflict", {
    agentId: worker.id,
    intent_id: intent.id,
  });
  console.log(`   check_conflict before acting: has_conflict=${conflictBefore.has_conflict}`);

  console.log("\n[5/6] Exactly-once action lifecycle");
  const prepared = await callTool("prepare_action", {
    agentId: worker.id,
    intent_id: intent.id,
    step_id: stepId,
    action_type: "demo.apply_scaling",
    arguments: { replicas: 4 },
  });
  if (prepared.disposition !== "OWNED") {
    abort(`prepare_action returned ${prepared.disposition}, expected OWNED`);
  }
  console.log(`   prepared: disposition=${prepared.disposition} action_id=${prepared.action_id}`);

  const started = await callTool("get_action_status", {
    agentId: worker.id,
    action_id: prepared.action_id,
  });
  console.log(
    `   status=${started.status} lease_owner=${started.lease_owner ?? "n/a"} attempts=${started.attempts ?? 0}`
  );

  const completed = await callTool("complete_action", {
    agentId: worker.id,
    action_id: prepared.action_id,
    outcome: {
      status: "success",
      external_id: `demo-ext-${suffix}`,
      response: { replicas: 4 },
    },
  });
  console.log(`   committed: status=${completed.status} external_ref record persisted`);

  const replayedComplete = await callTool("complete_action", {
    agentId: worker.id,
    action_id: prepared.action_id,
    outcome: { status: "success" },
  });
  if (replayedComplete.already_committed !== true) {
    abort("replayed complete_action was not reported as already committed");
  }
  console.log("   replayed complete_action -> already_committed=true");

  const replayedPrepare = await callTool("prepare_action", {
    agentId: worker.id,
    intent_id: intent.id,
    step_id: stepId,
    action_type: "demo.apply_scaling",
    arguments: { replicas: 4 },
  });
  if (replayedPrepare.disposition !== "ALREADY_COMMITTED") {
    abort(`replayed prepare_action returned ${replayedPrepare.disposition}`);
  }
  console.log("   replayed prepare_action -> disposition=ALREADY_COMMITTED");

  console.log("\n[6/6] Conflict gate and reconciliation");
  const staleIntent = await callTool("declare_intent", {
    agent_id: worker.id,
    task_id: task.id,
    statement: "Scale the demo service again using the current version",
    reads: [{ resource_id: resource.id, observed_version: resource.version }],
    plan_steps: [{ description: "Apply a second replica change", depends_on: [resource.id] }],
  });
  const staleStepId = staleIntent.steps?.[0]?.id;
  if (!staleStepId) abort("second declare_intent returned no plan steps");

  const updated = await callTool("update_resource", {
    resource_id: resource.id,
    new_state: { replicas: 8 },
    expected_version: resource.version,
  });
  if (updated.error) abort(`update_resource failed: ${updated.error}`);
  console.log(`   resource ${updated.key} moved to version ${updated.version}`);

  await expectDenied(
    "prepare_action on an intent that read the old resource version",
    "prepare_action",
    {
      agentId: worker.id,
      intent_id: staleIntent.id,
      step_id: staleStepId,
      action_type: "demo.apply_scaling",
      arguments: { replicas: 16 },
    },
    /depends on a resource that changed/
  );

  await expectDenied(
    "reconcile_action called by a non-system agent",
    "reconcile_action",
    { agentId: worker.id, action_id: prepared.action_id },
    /system authorization/
  );
  const reconciled = await callTool("reconcile_action", {
    agentId: systemAgentId,
    action_id: prepared.action_id,
  });
  console.log(`   reconciled: verdict=${reconciled.verdict} status=${reconciled.status}`);

  console.log("\nDemo complete.");
  console.log(`   system agent : ${systemAgentId}`);
  console.log(`   worker agent : ${worker.id}`);
  console.log(`   intent       : ${intent.id}`);
  console.log(`   action       : ${prepared.action_id}`);
  console.log("\nThe MCP server itself is started with: npm start (stdio transport).");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n[DEMO] Failed: ${message}\n`);
    process.exit(1);
  });
