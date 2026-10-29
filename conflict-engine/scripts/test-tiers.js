/**
 * Does asking for a different adjudicator actually change who rules?
 *
 * A tier parameter that is accepted, validated and then ignored is worse than
 * no tier parameter: the caller pays attention to a knob that does nothing. So
 * this asserts on the model id that comes back, not on the request succeeding.
 *
 * Each tier gets a fresh intent. Re-committing against an already-adjudicated
 * intent threatens nothing — its status is no longer open — so reusing one
 * silently tests nothing at all.
 *
 * Run: npm run test:tiers
 */
import { Interlock } from "../sdk/client.js";

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const key = process.env.INTERLOCK_KEY ?? (await Interlock.issueKey({ name: "Tier Test" })).key;
const il = new Interlock({ apiKey: key });

const health = await il.health();
const tiers = health.adjudicators.available;
console.log(`\nadjudicators published: ${tiers.join(", ")} (default ${health.adjudicators.default})\n`);

const scheduler = await il.registerAgent({ name: "Scheduler" });
const triage = await il.registerAgent({ name: "Triage" });

let failures = 0;
const seen = new Map();

for (const tier of tiers) {
  // Fresh resource + intent per tier, so each commit has something open to
  // threaten.
  const queue = await il.registerResource({
    key: `tier-${tier}-${Date.now().toString(36)}`,
    kind: "queue",
    body: { open_tickets: 118, staffed: 6 },
  });

  console.log(
    dim(`  ${tier}: resource ${queue.id.slice(0, 8)} at v${queue.version} (${typeof queue.version})`),
  );

  const { intent } = await il.declare({
    agentId: scheduler.id,
    taskId: crypto.randomUUID(),
    statement:
      "Rebalance the EU support queue overnight: compute the overflow above six " +
      "staffed responders and hand it to the APAC rota.",
    reads: [{ resourceId: queue.id, observedVersion: queue.version }],
  });

  await il.addSteps({
    intentId: intent.id,
    steps: [
      { description: "read queue depth", dependsOn: [queue.id] },
      { description: "compute overflow above 6", dependsOn: [queue.id] },
    ],
  });

  const res = await il.commit({
    agentId: triage.id,
    resourceId: queue.id,
    expectedVersion: queue.version,
    body: { open_tickets: 131, staffed: 6 },
    statement: "Depth rose to 131 after a billing incident.",
    adjudicator: tier,
  });

  const mine = (res.adjudications ?? []).find((a) => a.intentId === intent.id);
  if (!mine) {
    console.log(bad(`FAIL  ${tier}: nothing was threatened, so no model ruled`));
    failures += 1;
    continue;
  }

  seen.set(tier, mine.model);
  console.log(
    `${ok("PASS")}  ${tier.padEnd(12)} ruled by ${mine.model}` +
      dim(`  (${mine.verdict}, $${res.cost.usd.toFixed(6)})`),
  );
}

// The point of the knob: different tiers must not all be the same model.
const distinct = new Set(seen.values());
if (distinct.size < seen.size) {
  console.log(
    bad(`\nFAIL  ${seen.size} tiers resolved to only ${distinct.size} distinct model(s)`),
  );
  failures += 1;
} else {
  console.log(ok(`\nPASS  each tier resolved to a distinct model`));
}

/* An unknown tier must be refused, not quietly downgraded. */
try {
  await il.commit({
    agentId: triage.id,
    resourceId: (await il.registerResource({ key: `tier-bogus-${Date.now()}` })).id,
    statement: "probe",
    body: {},
    adjudicator: "definitely-not-a-model",
  });
  console.log(bad("FAIL  an unknown adjudicator was accepted"));
  failures += 1;
} catch (e) {
  if (e.status === 400) {
    console.log(ok(`PASS  unknown adjudicator refused — ${e.message}`));
  } else {
    console.log(bad(`FAIL  unknown adjudicator gave ${e.status}: ${e.message}`));
    failures += 1;
  }
}

console.log(failures ? bad(`\n${failures} failed\n`) : ok("\nall passed\n"));
process.exit(failures ? 1 : 0);
