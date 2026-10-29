/**
 * End-to-end walk through the mechanism, against the live cluster.
 *
 * Scenario: an incident-response fleet sharing a support-queue state.
 *
 *   Agent "Scheduler"  is 40 seconds into planning an overnight rebalance of
 *                      the EU queue. It has already done four steps of work.
 *   Agent "Triage"     commits a reassignment into that same queue.
 *   Agent "Billing"    separately commits an unrelated invoice change.
 *
 * The interesting result is not that the first conflict is caught. It is that
 * the second one should be ruled IRRELEVANT — because most conflicts are, and a
 * system that flags everything is just optimistic concurrency with extra steps.
 *
 * Run: npm run demo
 */
import { query, serializableTx, closePool } from "../agents/db.js";
import { Usage } from "../agents/bedrock.js";
import {
  declareIntent,
  commitResource,
  processCommit,
} from "../agents/interlock.js";

const b = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const warnC = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

const VERDICT_COLOR = { irrelevant: ok, invalidating: warnC, fatal: red };

async function upsertAgent(name, role, region) {
  const { rows } = await query(
    `SELECT id FROM agent WHERE name = $1`,
    [name],
  );
  if (rows[0]) return rows[0].id;
  const { rows: ins } = await query(
    `INSERT INTO agent (name, role, home_region) VALUES ($1,$2,$3) RETURNING id`,
    [name, role, region],
  );
  return ins[0].id;
}

async function upsertResource(kind, key, body) {
  const { rows } = await query(
    `INSERT INTO resource (kind, ext_key, body)
     VALUES ($1,$2,$3)
     ON CONFLICT (tenant_id, kind, ext_key)
     DO UPDATE SET body = EXCLUDED.body, version = resource.version + 1, updated_at = now()
     RETURNING id, version`,
    [kind, key, body],
  );
  return rows[0];
}

async function main() {
  console.log(b("\n── Setup ───────────────────────────────────────────────"));

  const scheduler = await upsertAgent("Scheduler", "capacity-planner", "aws-us-east-1");
  const triage = await upsertAgent("Triage", "ticket-router", "aws-us-east-2");
  const billing = await upsertAgent("Billing", "invoice-clerk", "aws-us-west-2");

  const queueEu = await upsertResource("queue", "support-eu", {
    open_tickets: 118,
    staffed: 6,
    shift: "day",
  });
  const invoice = await upsertResource("invoice", "inv-9931", {
    status: "draft",
    amount: 4200,
  });

  console.log(`  agents:    Scheduler, Triage, Billing`);
  console.log(`  resources: queue/support-eu (v${queueEu.version}), invoice/inv-9931 (v${invoice.version})`);

  const usage = new Usage("demo");

  /* ---------------------------------------------------------------------- */
  console.log(b("\n── Step 1: Scheduler declares an intent ────────────────"));

  const intent = await declareIntent({
    agentId: scheduler,
    taskId: crypto.randomUUID(),
    statement:
      "Rebalance the EU support queue for the overnight shift: the queue currently holds 118 open tickets with 6 staff, so move the overflow to the APAC follow-the-sun rota and page a second responder.",
    reads: [{ resourceId: queueEu.id, observedVersion: queueEu.version }],
    steps: [
      {
        description: "Read current EU queue depth and staffing level",
        dependsOn: [queueEu.id],
        tokensUsed: 1800,
      },
      {
        description: "Compute overflow above the 15-tickets-per-responder threshold",
        dependsOn: [queueEu.id],
        tokensUsed: 3100,
      },
      {
        description: "Draft the APAC handover note listing which tickets move",
        dependsOn: [queueEu.id],
        tokensUsed: 5200,
      },
      {
        description: "Select and page a second overnight responder from the rota",
        tokensUsed: 2400,
      },
    ],
    usage,
  });

  console.log(`  intent ${dim(intent.id)}`);
  console.log(`  snapshot HLC ${dim(intent.read_hlc)}`);
  console.log(`  4 plan steps declared, 12,500 tokens of reasoning already spent`);

  /* ---------------------------------------------------------------------- */
  console.log(b("\n── Step 2: Triage commits into the same queue ──────────"));

  const c1 = await commitResource({
    agentId: triage,
    resourceId: queueEu.id,
    expectedVersion: queueEu.version,
    newBody: { open_tickets: 131, staffed: 6, shift: "day" },
    statement:
      "Reassign 13 escalated tickets from the US queue into the EU support queue, raising its depth to 131.",
    usage,
  });

  if (c1.conflict) {
    console.log(red(`  version conflict: expected ${c1.expected}, found ${c1.actual}`));
  } else {
    console.log(
      `  commit ${dim(c1.commit.id)} — queue v${c1.prevVersion} → v${c1.newVersion}` +
        (c1.attempts > 1 ? warnC(`  (${c1.attempts} attempts, serialization retry)`) : ""),
    );
  }

  console.log(b("\n── Steps 3–5: watch, diff, adjudicate, resolve ─────────"));
  const out1 = await processCommit(c1.commit.id, { usage });
  report(out1);

  /* ---------------------------------------------------------------------- */
  console.log(b("\n── Control: an unrelated commit ────────────────────────"));
  console.log(dim("  Most conflicts are irrelevant. A system that flags everything"));
  console.log(dim("  is optimistic concurrency wearing a costume."));

  const c2 = await commitResource({
    agentId: billing,
    resourceId: invoice.id,
    expectedVersion: invoice.version,
    newBody: { status: "sent", amount: 4200 },
    statement: "Mark invoice inv-9931 as sent to the customer's finance contact.",
    usage,
  });

  const out2 = await processCommit(c2.commit.id, { usage });
  if (out2.length === 0) {
    console.log(ok("  no intent threatened — nothing adjudicated, nothing spent"));
  } else {
    report(out2);
  }

  /* ---------------------------------------------------------------------- */
  console.log(b("\n── Accounting ──────────────────────────────────────────"));
  const j = usage.toJSON();
  const preserved = out1.reduce((n, o) => n + o.stepsPreserved, 0);
  const repaired = out1.reduce((n, o) => n + o.stepsRepaired, 0);
  const total = preserved + repaired;

  console.log(`  model calls        ${j.calls}`);
  console.log(`  tokens in/out      ${j.tokensIn} / ${j.tokensOut}`);
  console.log(`  cost               $${j.usd.toFixed(6)}`);
  console.log(`  energy             ${j.energy.wh.toFixed(4)} Wh · ${j.energy.gCO2e.toFixed(4)} gCO2e`);
  console.log(dim(`                     ${j.energy.assumption}`));

  if (total > 0) {
    const pct = ((preserved / total) * 100).toFixed(0);
    console.log(
      `\n  ${b("reasoning preserved")}  ${ok(`${preserved}/${total} steps (${pct}%)`)}`,
    );
    console.log(
      dim(`  Under optimistic concurrency all ${total} steps would have been discarded.`),
    );
  }

  await closePool();
}

function report(outcomes) {
  for (const o of outcomes) {
    const color = VERDICT_COLOR[o.verdict] ?? dim;
    console.log(
      `\n  ${b(o.agent)} — detected by ${b(o.detectedBy)}` +
        (o.distance != null ? dim(`  (distance ${Number(o.distance).toFixed(3)})`) : ""),
    );
    console.log(`    verdict   ${color(o.verdict.toUpperCase())}`);
    console.log(`    rationale ${o.rationale}`);
    console.log(
      `    steps     ${o.stepsRepaired} repaired, ${ok(`${o.stepsPreserved} preserved`)} of ${o.stepsTotal}`,
    );
  }
}

main().catch(async (e) => {
  console.error(red(`\nfailed: ${e.message}`));
  console.error(dim(e.stack?.split("\n").slice(1, 4).join("\n") ?? ""));
  await closePool();
  process.exit(1);
});
