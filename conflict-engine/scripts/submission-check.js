/**
 * Is the submission still judgeable?
 *
 * Rules.md requires the project to stay "available free of charge and without
 * any restriction, for testing, evaluation and use by the Sponsor,
 * Administrator and Judges until the Judging Period ends" — 15 September 2026.
 * That is a month after submission, with nobody watching.
 *
 * The failure that costs the prize is not a bug: it is a rotated credential, an
 * expired cluster or an exhausted budget, discovered in October. So this checks
 * every surface a judge can actually touch, from outside, using nothing but the
 * public URLs.
 *
 *   npm run submission:check
 *
 * Run it weekly during judging. Exits non-zero if a judge would see a failure.
 */
import { Interlock } from "../sdk/client.js";

const SITE = "https://d3dgn014prmcy8.cloudfront.net";
const API = "https://wpvk3ox2bxo2w3zhxmx54ssjf40rakuz.lambda-url.us-east-1.on.aws/";
const REPO = "https://github.com/usv240/interlock";
const JUDGING_ENDS = new Date("2026-09-15T17:00:00-04:00");

const g = (s) => `\x1b[32m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;
const y = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const b = (s) => `\x1b[1m${s}\x1b[0m`;

let failures = 0;
const pass = (s) => console.log(`  ${g("PASS")}  ${s}`);
const fail = (s) => {
  console.log(`  ${r("FAIL")}  ${s}`);
  failures += 1;
};
const warn = (s) => console.log(`  ${y("WARN")}  ${s}`);

const days = Math.ceil((JUDGING_ENDS - Date.now()) / 86_400_000);
console.log(
  b(`\nSubmission check — ${days > 0 ? `${days} days of judging left` : "judging has ended"}\n`),
);

/* ---------------------------------------------------------------- the site */

try {
  const res = await fetch(SITE, { redirect: "follow" });
  const html = await res.text();
  if (res.ok && html.includes("INTERLOCK")) {
    pass(`demo site responds (${res.status}, ${(html.length / 1024).toFixed(0)} KB)`);
  } else {
    fail(`demo site returned ${res.status}`);
  }
} catch (e) {
  fail(`demo site unreachable: ${e.message}`);
}

/* ----------------------------------------------------------------- the API */

let health;
try {
  health = await (await fetch(`${API}v1/health`)).json();
  if (health.ok) {
    pass(
      `API healthy — ${health.topology.regions.length} regions, survives ${health.topology.survivalGoal} failure`,
    );
  } else {
    fail("API responded but not ok");
  }
} catch (e) {
  fail(`API unreachable: ${e.message} — a judge would see nothing`);
}

/* -------------------------------------------------------------- the budget */

if (health?.quota) {
  const { globalUsdToday: spent, globalUsdLimit: cap } = health.quota;
  const left = cap - spent;
  if (left <= 0) {
    fail(
      `inference budget exhausted ($${spent.toFixed(2)}/$${cap}) — judges get 429 on /v1/commits until midnight UTC`,
    );
  } else if (left < cap * 0.25) {
    warn(`only $${left.toFixed(2)} of $${cap} inference budget left today`);
  } else {
    pass(`inference budget healthy — $${spent.toFixed(2)} of $${cap} used today`);
  }
}

if (health?.services) {
  const down = health.services.filter((s) => s.status === "unknown");
  if (down.length) {
    warn(`${down.length} service(s) unreadable: ${down.map((s) => s.name).join(", ")}`);
  } else {
    const live = health.services.filter((s) => s.status === "live").length;
    pass(`${live} of ${health.services.length} services reporting live`);
  }
}

/* ------------------------------------------------------- the judge's path */

// Everything above could pass while the thing a judge actually runs is broken.
// This is the same call `npm run quickstart` makes on a clean clone.
try {
  const issued = await Interlock.issueKey({ name: "Submission check" });
  const il = new Interlock({ apiKey: issued.key });
  const agent = await il.registerAgent({ name: "Check", role: "monitor" });
  const queue = await il.registerResource({
    key: `check-${Date.now().toString(36)}`,
    kind: "queue",
    body: { n: 1 },
  });
  const { intent } = await il.declare({
    agentId: agent.id,
    taskId: crypto.randomUUID(),
    statement: "Verify the full declare-commit-adjudicate loop still works end to end.",
    reads: [{ resourceId: queue.id, observedVersion: queue.version }],
  });
  await il.addSteps({
    intentId: intent.id,
    steps: [{ description: "check the loop", dependsOn: [queue.id] }],
  });
  const other = await il.registerAgent({ name: "Check Interferer", role: "monitor" });
  const res = await il.commit({
    agentId: other.id,
    resourceId: queue.id,
    expectedVersion: queue.version,
    body: { n: 2 },
    statement: "Change the value the plan depends on.",
  });
  const ruling = (res.adjudications ?? []).find((a) => a.intentId === intent.id);
  if (ruling) {
    pass(`full loop works — ${ruling.verdict}, ruled by ${ruling.model}`);
  } else {
    fail("the loop ran but no conflict was detected — detection is broken");
  }
} catch (e) {
  fail(`the judge's path is broken: ${e.message}`);
}

/* ------------------------------------------------------------- the repo */

try {
  const res = await fetch(`${REPO}/raw/main/package.json`);
  if (res.ok) {
    const pkg = await res.json();
    const need = ["quickstart", "compare", "verify"];
    const missing = need.filter((s) => !pkg.scripts?.[s]);
    if (missing.length) {
      fail(`public repo is missing: ${missing.join(", ")} — unpushed commits?`);
    } else {
      pass(`public repo is current — quickstart, compare and verify all present`);
    }
  } else {
    fail(`repo not publicly readable (${res.status})`);
  }
} catch (e) {
  fail(`repo unreachable: ${e.message}`);
}

/* -------------------------------------------------------------------------- */

console.log(
  failures
    ? r(b(`\n${failures} thing(s) a judge would hit. Fix before they do.\n`))
    : g(b(`\nEverything a judge can touch is working.\n`)),
);
if (!failures && days > 0) {
  console.log(dim(`Run this weekly until ${JUDGING_ENDS.toDateString()}.\n`));
}
process.exit(failures ? 1 : 0);
