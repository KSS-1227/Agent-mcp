/**
 * Two agents, one queue, the same collision — priced with and without INTERLOCK.
 *
 * Built for a live walkthrough: it runs through the public API with your own
 * key, in about fifteen seconds, and every INTERLOCK figure it prints is
 * measured on the spot.
 *
 * WHAT IS MEASURED AND WHAT IS ASSUMED
 * This is the part that has to stay honest, because the whole argument collapses
 * if the comparison is rigged.
 *
 *   MEASURED, live, this run:
 *     - whether the conflict is detected at all, and by which path
 *     - the verdict, and exactly which plan steps it invalidates
 *     - the tokens and dollars the adjudication itself cost
 *
 *   ASSUMED, and stated on screen:
 *     - how many tokens the agent spent reasoning before it was interrupted
 *
 * That last number is a parameter because it is a property of *your* agent, not
 * of this service — we never see your reasoning. It is also the number the whole
 * result hinges on, so `--reasoning` changes it, and the script prints the
 * break-even point rather than hiding it.
 *
 *   npm run compare -- ilk_your_key
 *   npm run compare -- ilk_your_key --reasoning 3000    # below break-even
 *
 * Below break-even INTERLOCK costs MORE and this script says so in as many
 * words. A demo that can only produce good news is not evidence.
 */
import { Interlock } from "../sdk/client.js";

const b = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const g = (s) => `\x1b[32m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;
const y = (s) => `\x1b[33m${s}\x1b[0m`;
const c = (s) => `\x1b[36m${s}\x1b[0m`;

/* ------------------------------------------------------------------ config */

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(argv[i + 1]);
};

let key = argv.find((a) => a.startsWith("ilk_")) ?? process.env.INTERLOCK_KEY;
/** Tokens the interrupted agent had already spent thinking. Yours, not ours. */
const REASONING = flag("reasoning", 12_500);
/** Published Bedrock rate for the tier this demo's agent would use. */
const USD_PER_1K = 0.003;

const usd = (tokens) => (tokens / 1000) * USD_PER_1K;
const money = (n) => `$${n.toFixed(4)}`;
const num = (n) => n.toLocaleString();

/*
 * Issue a throwaway key when none is given, exactly as `quickstart` does.
 *
 * This used to refuse to start without one, while the README, the submission
 * document and the walkthrough script all invite the reader to run a bare
 * `npm run compare`. Three places pointing at a command that exits 1 — and the
 * first person to find out was someone about to record it.
 *
 * A demo that demands setup before it will show you anything is a demo most
 * people never see.
 */
if (!key) {
  console.log(dim("  No key given, issuing a throwaway one…"));
  key = (await Interlock.issueKey({ name: "Compare", label: "compare" })).key;
}

const il = new Interlock({ apiKey: key });

console.log(b("\n  Two agents, one queue — what the collision costs\n"));
console.log(
  dim(
    `  The Scheduler spends ${num(REASONING)} tokens planning an overnight rebalance.\n` +
      `  Triage commits into the same queue while it is still thinking.\n`,
  ),
);

/* ------------------------------------------------------------------ setup */

const scheduler = await il.registerAgent({ name: "Scheduler", role: "capacity-planner" });
const triage = await il.registerAgent({ name: "Triage", role: "ticket-router" });
const stamp = Date.now().toString(36);

const STEPS = [
  "read queue depth",
  "compute the overflow above 6 responders",
  "draft the APAC handover",
  "page a second responder",
];

/**
 * One planning task, freshly declared.
 *
 * A fresh intent per collision because an intent that has already been ruled on
 * is no longer `open`, and a second commit would find nothing to threaten —
 * which would look like "no conflict" rather than "already handled".
 *
 * The plan reads two things and depends on one. That asymmetry is the whole
 * point of the first collision: an agent's read-set is always wider than the
 * set of facts its conclusions actually rest on.
 */
async function declarePlan() {
  const queue = await il.registerResource({
    key: `q-${stamp}-${Math.random().toString(36).slice(2, 7)}`,
    kind: "queue",
    body: { open_tickets: 118, staffed: 6 },
  });
  const roster = await il.registerResource({
    key: `r-${stamp}-${Math.random().toString(36).slice(2, 7)}`,
    kind: "roster",
    body: { on_call: "priya", timezone: "CET" },
  });

  const { intent } = await il.declare({
    agentId: scheduler.id,
    taskId: crypto.randomUUID(),
    statement:
      "Rebalance the EU support queue for the overnight shift: compute the overflow " +
      "above six staffed responders, hand it to the APAC rota, and page a second responder.",
    reads: [
      { resourceId: queue.id, observedVersion: queue.version },
      { resourceId: roster.id, observedVersion: roster.version },
    ],
  });
  // Every step depends on the queue. None depends on the roster — the agent read
  // it, but nothing it concluded rests on it.
  await il.addSteps({
    intentId: intent.id,
    steps: STEPS.map((description) => ({ description, dependsOn: [queue.id] })),
  });
  return { intent, queue, roster };
}

/** Commit, and return the ruling against our own plan. */
async function collide(intentId, resource, body, statement) {
  const t0 = Date.now();
  const res = await il.commit({
    agentId: triage.id,
    resourceId: resource.id,
    expectedVersion: resource.version,
    body,
    statement,
  });
  const ruling = (res.adjudications ?? []).find((a) => a.intentId === intentId);
  return { ruling, cost: res.cost, ms: Date.now() - t0 };
}

console.log(
  dim(
    `  Its plan has ${STEPS.length} steps and reads two things: the queue, which every\n` +
      `  step depends on, and the on-call roster, which none of them do.\n`,
  ),
);

/* ------------------------------------------------------- collision 1 of 2 */

const a = await declarePlan();
console.log(b("  1. Triage edits the on-call roster") + dim("  — a row the plan read"));

const one = await collide(
  a.intent.id,
  a.roster,
  { on_call: "sam", timezone: "CET" },
  "Handover: Sam takes the overnight on-call from Priya.",
);

if (!one.ruling) {
  console.error(r("  Not detected. Nothing to compare."));
  process.exit(1);
}
console.log(
  `     ${c("→")} ${b(one.ruling.verdict.toUpperCase())}, ` +
    `settled by ${b(one.ruling.model)} ` +
    dim(`(${one.ruling.detectedBy}, ${one.ms} ms)`),
);
console.log(
  dim(
    `     Optimistic concurrency sees a version it read has moved and aborts the\n` +
      `     whole task. The graph sees no step descends from the roster — free.\n`,
  ),
);

/* ------------------------------------------------------- collision 2 of 2 */

const d = await declarePlan();
console.log(b("  2. Triage changes the queue depth") + dim("  — a row the plan depends on"));

const two = await collide(
  d.intent.id,
  d.queue,
  { open_tickets: 131, staffed: 6, surge: "billing-incident" },
  "Queue depth rose to 131 after a billing incident; staffing unchanged.",
);

if (!two.ruling) {
  console.error(r("  Not detected. Nothing to compare."));
  process.exit(1);
}
const ruling = two.ruling;
const res = { cost: two.cost };
console.log(
  `     ${c("→")} ${b(ruling.verdict.toUpperCase())}, ruled by ${ruling.model} ` +
    dim(`(${ruling.detectedBy}, ${two.ms} ms)`),
);
console.log(dim(`     ${ruling.rationale}\n`));

/* ----------------------------------------------------------------- pricing */

const total = ruling.stepsTotal || STEPS.length;
const redone = ruling.stepsRepaired ?? 0;
const perStep = REASONING / total;

// Optimistic concurrency aborts on both collisions: a version it read has moved,
// and OCC cannot tell "moved" from "matters". Each abort discards every token of
// reasoning and starts again.
const occ = REASONING * 2 * 2;

// INTERLOCK. Collision 1 was settled by the provenance graph with no model call
// at all — cost() is 0 there and that is not a rounding artefact. Collision 2
// paid for one adjudication and re-ran only the steps it named.
const freeTokens = one.cost?.tokensTotal ?? 0;
const adjudicationTokens = res.cost?.tokensTotal ?? 0;
const interlock = REASONING + freeTokens + (REASONING + adjudicationTokens + perStep * redone);

const saved = occ - interlock;
const pct = (saved / occ) * 100;

const row = (label, tokens, note) =>
  `  ${label.padEnd(30)} ${String(num(Math.round(tokens))).padStart(8)} tok  ` +
  `${money(usd(tokens)).padStart(9)}  ${dim(note)}`;

console.log(b("  Two collisions, two tasks, priced\n"));
console.log(dim(`  ${"".padEnd(30)} ${"tokens".padStart(8)}  ${"cost".padStart(9)}\n`));

console.log(row("Optimistic concurrency", occ, "aborts both, re-runs both"));
console.log(
  dim(
    `  ${"".padEnd(30)} ${"".padStart(8)}      ${"".padStart(9)}  ` +
      `2 tasks discarded and redone in full`,
  ),
);
console.log("");
console.log(row("INTERLOCK", interlock, `keeps ${total - redone} of ${total} steps on the real one`));
console.log(
  dim(
    `  ${"".padEnd(30)} ${"".padStart(8)}      ${"".padStart(9)}  ` +
      `collision 1: ${num(freeTokens)} tokens — the graph settled it\n` +
      `  ${"".padEnd(30)} ${"".padStart(8)}      ${"".padStart(9)}  ` +
      `collision 2: ${num(adjudicationTokens)} to adjudicate + ` +
      `${num(Math.round(perStep * redone))} to redo ${redone}`,
  ),
);

console.log("");
if (saved > 0) {
  console.log(
    `  ${g(b(`saves ${num(Math.round(saved))} tokens — ${money(usd(saved))}, ${pct.toFixed(0)}%`))}` +
      dim("  across the two"),
  );
} else {
  console.log(
    `  ${r(b(`costs ${num(Math.round(-saved))} tokens MORE — ${money(usd(-saved))}`))}` +
      dim("  at this task size"),
  );
}

/* --------------------------------------------------------- the honest part */

// Break-even: adjudication is a fixed cost, and the saving scales with how much
// reasoning was at stake. Below the crossover the fixed cost dominates.
//   saved > 0  ⇔  R > adjudicationTokens / (1 - redone/total)
/*
 * Break-even across the pair, derived rather than guessed at — the first
 * version of this line printed 3,228 for a run that was already saving money at
 * 1,200, because it dropped a term.
 *
 *   occ        = 4R                    two tasks, each discarded and redone
 *   interlock  = 2R + free + adj + R·(redone/total)
 *   saved > 0  ⇔  R·(2 − redone/total) > free + adj
 *
 * so R must exceed (free + adj) / (2 − redone/total). Both fixed costs count:
 * settling collision 1 by graph is nearly free, but "nearly" is not "zero".
 */
const savingPerR = 2 - redone / total;
const fixedCost = freeTokens + adjudicationTokens;
const breakEven = savingPerR > 0 ? fixedCost / savingPerR : Infinity;

console.log(dim(`\n  ${"─".repeat(66)}`));
console.log(
  dim(
    `  The first collision is the common case and it is free: most writes do not\n` +
      `  touch what a plan's conclusions rest on, and a recursive CTE can prove that\n` +
      `  without asking a model. Optimistic concurrency cannot tell "this row moved"\n` +
      `  from "this row matters", so it throws the task away either way.\n` +
      `\n` +
      // The losing branch used to read "The second is the case that costs
      // something. Here it does not:" — where "it" was meant to point at
      // "beats re-running", a phrase that only exists in the winning branch.
      // Read aloud it says the opposite of what is meant. Each branch now
      // carries its own verb.
      `  The second is the case that costs something. ${
        saved > 0
          ? "Here it still beats re-running."
          : `Here it does not beat re-running:\n  at ${num(REASONING)} tokens there is not enough reasoning at stake to protect.`
      }\n`,
  ),
);

/*
 * Two different break-evens, and conflating them would be dishonest.
 *
 * This pair is a favourable construction: one of its two collisions is settled
 * free by the graph, which halves the fixed cost and pulls break-even down to a
 * few hundred tokens. The number the project publishes — around 12,000 — comes
 * from `npm run bench:sweep`, a six-agent contended workload where the mix of
 * relevant and irrelevant conflicts is whatever the workload produces rather
 * than whatever a demo chose.
 *
 * Quoting this figure as "the crossover" would put a flattering number next to
 * the same words the site uses for a harder one. So it is named for what it is.
 */
/*
 * Both crossovers, side by side, in the same eyeline.
 *
 * Two different numbers describe "where this starts paying", and a reader who
 * meets them apart concludes one of them is wrong. Printed together, with what
 * each measures, the difference is obviously deliberate rather than a
 * contradiction — and the favourable one is the one labelled as favourable.
 */
console.log(
  `  ${b("Two crossovers, and they are not the same number:")}\n\n` +
    `    ${y("this pair")}        break-even ~${b(num(Math.round(breakEven)))} tokens/task   ` +
    dim("← favourable: 1 of 2 collisions was free") +
    `\n` +
    `    ${g("full workload")}    crossover  ~${b("12,000")} tokens/task   ` +
    dim("← the published number") +
    `\n`,
);
console.log(
  dim(
    `  A demo gets to pick its collisions and this one picked well, so its\n` +
      `  break-even sits far below the real thing. ${b("~12,000 is the number to believe")}:\n` +
      `  it comes from a six-agent contended workload where the conflict mix is\n` +
      `  whatever the workload produces — ${b("npm run bench:sweep")}. Below it, do not use\n` +
      `  this; just retry. The curve on the site publishes that losing region.\n` +
      `\n` +
      `  ${b("Measured live:")} detection, both verdicts, which steps died, what the\n` +
      `  adjudication cost. ${b("Assumed:")} ${num(REASONING)} tokens of reasoning at $${USD_PER_1K}/1k —\n` +
      `  a property of your agent, not of this service. We never see your reasoning.\n` +
      `  Move it with --reasoning and watch the conclusion change.\n`,
  ),
);

console.log(
  dim(`  0 lost updates either way. Serializable isolation is not the variable here.\n`),
);
