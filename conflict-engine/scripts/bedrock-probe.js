/**
 * Confirms every configured Bedrock tier is reachable and reports what each
 * call actually cost. Run after changing model config: npm run ai:probe
 */
import { probe, Usage, embed, complete } from "../agents/bedrock.js";

const ok = (s) => `\x1b[32m✓\x1b[0m ${s}`;
const bad = (s) => `\x1b[31m✗\x1b[0m ${s}`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const results = await probe();

console.log("\n\x1b[1mBedrock tiers\x1b[0m");
let failed = 0;
for (const [tier, r] of Object.entries(results)) {
  console.log(
    r.ok
      ? ok(`${tier.padEnd(12)} ${r.model.padEnd(46)} ${dim(r.detail)}`)
      : bad(`${tier.padEnd(12)} ${r.model.padEnd(46)} ${r.detail}`),
  );
  if (!r.ok) failed++;
}

// Exercise the ledger the same way the runtime will, so the accounting path is
// tested rather than assumed.
console.log("\n\x1b[1mAccounting\x1b[0m");
const usage = new Usage("probe");
await embed("an agent intends to reassign the EU support queue", usage);
await complete({
  tier: "adjudicator",
  prompt:
    "In one short sentence: why can't classical two-phase locking work for an agent that thinks for 40 seconds?",
  maxTokens: 120,
  usage,
});

const j = usage.toJSON();
console.log(`  calls          ${j.calls}`);
console.log(`  tokens in/out  ${j.tokensIn} / ${j.tokensOut}`);
console.log(`  cost           $${j.usd.toFixed(6)}`);
console.log(
  `  energy         ${j.energy.wh.toFixed(4)} Wh · ${j.energy.gCO2e.toFixed(4)} gCO2e`,
);
console.log(dim(`                 ${j.energy.assumption}`));

console.log(
  failed === 0
    ? `\n${ok("all tiers reachable")}`
    : `\n${bad(`${failed} tier(s) unreachable`)}`,
);
process.exit(failed === 0 ? 0 : 1);
