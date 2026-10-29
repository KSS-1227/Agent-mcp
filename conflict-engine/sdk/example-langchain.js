/**
 * Two LangChain agents, one queue, no corruption.
 *
 * This is the whole adoption story in one file: an existing agent gains
 * concurrency safety by adding a callback, not by being rewritten.
 *
 * The chain is a stub rather than a real LLM agent, deliberately. What is being
 * demonstrated is the *integration surface* — what a LangChain user has to
 * change — and a live model call would add cost and latency without making that
 * surface any clearer. Everything below the callback is real: real tenant, real
 * embeddings, real serializable commit, real adjudication.
 *
 * Run: npm run example:langchain
 */
import { InterlockCallback } from "./langchain.js";
import { Interlock } from "./client.js";

const b = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const warn = (s) => `\x1b[33m${s}\x1b[0m`;

console.log(b("\n  Two LangChain agents, one shared queue\n"));

/* ---------------------------------------------------------- 1. onboarding */
/* Exactly what a new user does: get a key, register the pieces. */

const issued = await Interlock.issueKey({ name: "LangChain Example", label: "example" });
const client = new Interlock({ apiKey: issued.key });

const scheduler = await client.registerAgent({ name: "Scheduler", role: "capacity-planner" });
const triage = await client.registerAgent({ name: "Triage", role: "ticket-router" });
const queue = await client.registerResource({
  key: `support-eu-${Date.now().toString(36)}`,
  kind: "queue",
  body: { open_tickets: 118, staffed: 6 },
});

console.log(dim(`  tenant ${issued.tenant.slug} · 2 agents · queue at v${queue.version}\n`));

/* -------------------------------------------------------------- 2. agent A */

class PlanningChain {
  constructor(name) {
    this.id = ["langchain", "chains", name];
  }
  async invoke(inputs, { callbacks = [] } = {}) {
    for (const cb of callbacks) {
      await cb.handleChainStart?.(this, inputs, crypto.randomUUID(), undefined);
    }
    for (const step of ["read_queue_depth", "compute_overflow", "draft_handover", "page_responder"]) {
      for (const cb of callbacks) cb.handleToolStart?.({ name: step }, inputs);
      await new Promise((r) => setTimeout(r, 40)); // "thinking"
    }
    return { plan: "rebalance" };
  }
}

console.log(b("  Agent A — Scheduler"));
console.log(dim("    const guard = new InterlockCallback({ apiKey, agentId, resources });"));
console.log(dim("    await chain.invoke(input, { callbacks: [guard] });\n"));

const guard = new InterlockCallback({
  apiKey: issued.key,
  agentId: scheduler.id,
  resources: [{ resourceId: queue.id, version: queue.version }],
  statement:
    "Rebalance the EU support queue for the overnight shift: compute the overflow above " +
    "6 staffed responders, hand it to the APAC rota, and page a second responder.",
});

await new PlanningChain("scheduler").invoke({ queue: "support-eu", depth: 118 }, { callbacks: [guard] });

if (!guard.intentId) {
  console.error(warn("    intent was not declared — see the warning above"));
  process.exit(1);
}

// LangChain callbacks are fire-and-forget, so the last step appends are still
// in flight when invoke() returns. Waiting here is what makes the ruling below
// see the whole plan rather than however much of it happened to land in time.
// guard.commit() does this for you; agent B commits directly, so we do it.
await guard.flush();

console.log(ok(`    intent declared, ${guard.steps.length} tool calls recorded as plan steps\n`));

/* -------------------------------------------------------------- 3. agent B */

console.log(b("  Agent B — Triage commits into the same queue"));
console.log(dim("    …while A is still thinking\n"));

const written = await client.commit({
  agentId: triage.id,
  resourceId: queue.id,
  expectedVersion: queue.version,
  body: { open_tickets: 131, staffed: 6, surge: "billing-incident" },
  statement: "Queue depth rose to 131 after a billing incident; staffing unchanged.",
});

/* --------------------------------------------------------------- 4. ruling */

const mine = (written.adjudications ?? []).find((a) => a.intentId === guard.intentId);

if (!mine) {
  console.error(warn("    no ruling reached agent A — the conflict went undetected"));
  process.exit(1);
}

console.log(`  ${b("Ruling:")} ${warn(mine.verdict.toUpperCase())}`);
console.log(dim(`  ${wrap(mine.rationale, 72, "  ")}\n`));

const redo = mine.affectedSteps ?? [];
console.log(
  `  ${ok(`${mine.stepsPreserved} of ${mine.stepsTotal} steps preserved`)}` +
    dim(` — optimistic concurrency would have discarded all ${mine.stepsTotal}\n`),
);
for (const s of redo) console.log(`    ${warn("redo")}  step ${s}`);
if (redo.length) console.log(dim(`\n  guard.stepsToRedo === [${redo.join(", ")}]`));

console.log(
  b("\n  What a LangChain user changes\n") +
    "    1. add a callback\n" +
    "    2. call guard.commit() where you already write\n" +
    "    3. if guard.wasInvalidated, redo only guard.stepsToRedo\n" +
    dim("\n    Their prompts, model and tools are untouched.\n"),
);

function wrap(text, width, indent = "") {
  const words = String(text ?? "").split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    if ((line + w).length > width) {
      lines.push(line.trimEnd());
      line = "";
    }
    line += `${w} `;
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines.join(`\n${indent}`);
}
