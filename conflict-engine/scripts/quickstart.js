/**
 * The whole mechanism, against the live service, with your own key.
 *
 * This is the "I have a key, now what" script. It needs nothing but Node and a
 * key — no database URL, no AWS credentials, no clone-and-configure. Everything
 * goes over the public API, so it is the same path any stranger's agent fleet
 * takes.
 *
 *   npm run quickstart -- ilk_your_key_here
 *   INTERLOCK_KEY=ilk_... npm run quickstart
 *
 * With no key it issues a throwaway one, so it still runs.
 */
import { Interlock, InterlockError } from "../sdk/client.js";

const b = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const warn = (s) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;

const step = (n, title) => console.log(`\n${b(`${n}. ${title}`)}`);

/* ------------------------------------------------------------------ key */

let key = process.argv[2] ?? process.env.INTERLOCK_KEY;

if (key && !key.startsWith("ilk_")) {
  console.error(
    `\n${warn("That does not look like an INTERLOCK key.")} They start with "ilk_".\n` +
      `Get one at https://d3dgn014prmcy8.cloudfront.net/#use-it\n`,
  );
  process.exit(1);
}

console.log(b("\nINTERLOCK quickstart\n"));

if (!key) {
  console.log(dim("  No key given, issuing a throwaway one…"));
  const issued = await Interlock.issueKey({ name: "Quickstart", label: "quickstart" });
  key = issued.key;
  console.log(dim(`  tenant ${issued.tenant.slug}\n`));
} else {
  console.log(dim(`  using ${key.slice(0, 12)}…\n`));
}

const il = new Interlock({ apiKey: key });

/* -------------------------------------------------------------- 1. health */

step(1, "Is the service up?");
try {
  const h = await il.health();
  console.log(
    `   ${ok("healthy")} — ${h.topology.regions.length} regions, survives ${b(
      h.topology.survivalGoal,
    )} failure`,
  );
  console.log(
    dim(
      `   time travel reaches back ${h.topology.timeTravelReach}` +
        ` · quota today ${h.quota.callsToday}/${h.quota.callLimit} calls,` +
        ` $${h.quota.usdToday.toFixed(2)}/$${h.quota.usdLimit}`,
    ),
  );
} catch (e) {
  if (e instanceof InterlockError && e.status === 401) {
    console.error(`   ${warn("That key was rejected.")} Issue a new one and try again.`);
    process.exit(1);
  }
  throw e;
}

/* ------------------------------------------------------ 2. register things */

step(2, "Register two agents and one thing for them to fight over");

const scheduler = await il.registerAgent({ name: "Scheduler", role: "capacity-planner" });
const triage = await il.registerAgent({ name: "Triage", role: "ticket-router" });
const queue = await il.registerResource({
  key: `support-eu-${Date.now().toString(36)}`,
  kind: "queue",
  body: { open_tickets: 118, staffed: 6 },
});

console.log(`   ${ok("done")} — queue at v${queue.version}, 118 tickets, 6 staff`);
console.log(dim(`   these are idempotent; calling them again returns the same ids`));

/* ------------------------------------------------------------- 3. declare */

step(3, "The Scheduler says what it is about to do — before it does it");

const { intent } = await il.declare({
  agentId: scheduler.id,
  taskId: crypto.randomUUID(),
  statement:
    "Rebalance the EU support queue for the overnight shift: compute the overflow " +
    "above 6 staffed responders, hand it to the APAC rota, and page a second responder.",
  reads: [{ resourceId: queue.id, observedVersion: queue.version }],
});

await il.addSteps({
  intentId: intent.id,
  steps: [
    { description: "read queue depth", dependsOn: [queue.id] },
    { description: "compute overflow above 6 responders", dependsOn: [queue.id] },
    { description: "draft the APAC handover", dependsOn: [queue.id] },
    { description: "page a second responder", dependsOn: [queue.id] },
  ],
});

console.log(`   ${ok("intent declared")} with 4 plan steps`);
console.log(
  dim("   this is the whole trick: the plan is visible to others while it thinks"),
);

/* -------------------------------------------------------------- 4. commit */

step(4, "Meanwhile, Triage commits into the same queue");
console.log(dim("   (in a real fleet the Scheduler is still mid-inference here)"));

const res = await il.commit({
  agentId: triage.id,
  resourceId: queue.id,
  expectedVersion: queue.version,
  body: { open_tickets: 131, staffed: 6, surge: "billing-incident" },
  statement: "Queue depth rose to 131 after a billing incident; staffing unchanged.",
});

/* -------------------------------------------------------------- 5. ruling */

step(5, "The ruling");

const mine = (res.adjudications ?? []).find((a) => a.intentId === intent.id);

if (!mine) {
  console.log(`   ${warn("no intent was threatened")} — nothing to adjudicate`);
} else {
  console.log(`   verdict   ${cyan(mine.verdict.toUpperCase())}`);
  console.log(`   detected  ${mine.detectedBy}`);
  console.log(`   rationale ${dim(wrap(mine.rationale, 62, "             "))}`);
  console.log(
    `\n   ${ok(`${mine.stepsPreserved} of ${mine.stepsTotal} steps preserved`)}` +
      dim(` — optimistic concurrency would discard all ${mine.stepsTotal}`),
  );
  if (mine.affectedSteps?.length) {
    console.log(dim(`   redo only: steps ${mine.affectedSteps.join(", ")}`));
  }
  console.log(dim(`\n   cost of this ruling: $${res.cost?.usd?.toFixed(6) ?? "?"}`));
}

/* ---------------------------------------------------------------- 6. audit */

step(6, "It is on the audit feed");
const feed = await il.adjudications();
console.log(
  dim(
    `   ${feed.adjudications.length} recent rulings, served as a follower read\n` +
      `   (a few seconds stale by design — it never blocks a writer)`,
  ),
);

console.log(
  b("\nThat is the whole loop.\n") +
    "   declare  →  commit through us  →  act on the ruling\n" +
    dim("\n   Your agents keep their own models, prompts and tools.\n") +
    dim("   See sdk/example-langchain.js to do this from a LangChain agent.\n"),
);

function wrap(text, width, indent) {
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
