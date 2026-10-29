/**
 * Calibrates the semantic threshold against real embeddings.
 *
 * SEMANTIC_THRESHOLD decides which conflicts get adjudicated at all, so picking
 * it by intuition would put a made-up number in the critical path. This measures
 * the distance between statement pairs whose relationship we already know, and
 * prints where the boundary actually falls.
 *
 * Also confirms which distance operators the cluster supports, because the
 * threshold is only meaningful with respect to one of them.
 *
 * Run: npm run ai:calibrate
 */
import { query, closePool } from "../agents/db.js";
import { embed } from "../agents/bedrock.js";

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const ok = (s) => `\x1b[32m✓\x1b[0m ${s}`;
const bad = (s) => `\x1b[31m✗\x1b[0m ${s}`;

/* --- which operators exist? ------------------------------------------------ */
console.log("\x1b[1mDistance operators\x1b[0m");
const OPS = [
  ["<->", "L2 / Euclidean"],
  ["<=>", "cosine"],
  ["<#>", "negative inner product"],
];
const available = [];
for (const [op, name] of OPS) {
  try {
    await query(`SELECT '[1,0,0]'::VECTOR ${op} '[0,1,0]'::VECTOR AS d`);
    console.log(ok(`${op}  ${name}`));
    available.push(op);
  } catch (e) {
    console.log(bad(`${op}  ${name} — ${e.message.split("\n")[0]}`));
  }
}

/* --- how far apart are known pairs? ---------------------------------------- */
const BASE =
  "Rebalance the EU support queue for the overnight shift: move overflow tickets to the APAC rota.";

const CASES = [
  ["same meaning, different words", "Shift the excess EU tickets onto the Asia-Pacific overnight team."],
  ["directly conflicting", "Reassign 13 escalated tickets from the US queue into the EU support queue."],
  ["same domain, unrelated", "Update the on-call phone number for the EU support rota."],
  ["different domain", "Mark invoice inv-9931 as sent to the customer's finance contact."],
  ["completely unrelated", "Rotate the TLS certificate on the staging load balancer."],
];

const { literal: baseVec } = await embed(BASE);

console.log(`\n\x1b[1mDistance from a reference intent\x1b[0m`);
console.log(dim(`  "${BASE.slice(0, 66)}…"\n`));
console.log(
  `  ${"relationship".padEnd(32)} ${available.map((o) => o.padEnd(8)).join("")}`,
);

const rows = [];
for (const [label, text] of CASES) {
  const { literal } = await embed(text);
  const sel = available
    .map((op, i) => `round((($1::VECTOR ${op} $2::VECTOR))::numeric, 4) AS d${i}`)
    .join(", ");
  const { rows: r } = await query(`SELECT ${sel}`, [baseVec, literal]);
  const vals = available.map((_, i) => r[0][`d${i}`]);
  rows.push({ label, vals });
  console.log(
    `  ${label.padEnd(32)} ${vals.map((v) => String(v).padEnd(8)).join("")}`,
  );
}

/* --- where should the boundary sit? ---------------------------------------- */
console.log(`\n\x1b[1mRecommended threshold\x1b[0m`);
for (const [i, op] of available.entries()) {
  // Everything at or above "same domain, unrelated" should be ignored;
  // everything at or below "directly conflicting" should be adjudicated.
  const conflicting = Number(rows[1].vals[i]);
  const unrelatedSameDomain = Number(rows[2].vals[i]);
  const midpoint = (conflicting + unrelatedSameDomain) / 2;
  console.log(
    `  ${op}  conflicting=${conflicting}  same-domain-unrelated=${unrelatedSameDomain}` +
      `  →  threshold ≈ ${dim(midpoint.toFixed(3))}`,
  );
}

console.log(
  dim(
    "\nThe detector errs toward adjudicating: a false positive costs one cheap\n" +
      "model call, a false negative lets a corrupted plan commit.",
  ),
);

await closePool();
