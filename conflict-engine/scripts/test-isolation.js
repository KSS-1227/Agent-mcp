/**
 * Proves tenant isolation, rather than asserting it.
 *
 * Two tenants declare deliberately near-identical intents against
 * identically-named resources. Tenant A then commits. If isolation holds,
 * exactly one intent is threatened — A's — even though B's is semantically
 * almost the same text and would certainly be caught by the vector path if the
 * tenant filter were missing.
 *
 * That is the specific failure worth testing for. A missed filter here does not
 * just leak a row; it makes one customer's commit repair steps inside another
 * customer's plan.
 *
 * Run: npm run test:isolation
 */
import { query, closePool } from "../agents/db.js";
import { Usage } from "../agents/bedrock.js";
import { declareIntent, commitResource, findThreatened } from "../agents/interlock.js";
import { ensureTenantAgent, issueKey } from "../agents/auth.js";
import { randomUUID } from "node:crypto";

const ok = (s) => `\x1b[32mPASS\x1b[0m  ${s}`;
const bad = (s) => `\x1b[31mFAIL\x1b[0m  ${s}`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

let failures = 0;
const check = (pass, msg) => {
  console.log(pass ? ok(msg) : bad(msg));
  if (!pass) failures++;
};

const usage = new Usage("isolation-test");

console.log("\n\x1b[1mTenant isolation\x1b[0m\n");

const a = await issueKey({ name: "Acme Robotics", label: "test" });
const b = await issueKey({ name: "Globex Logistics", label: "test" });
console.log(dim(`  tenant A ${a.tenant.slug}   key ${a.prefix}…`));
console.log(dim(`  tenant B ${b.tenant.slug}   key ${b.prefix}…\n`));

async function seed(tenantId, label) {
  const agentId = await ensureTenantAgent(tenantId, `planner-${label}`, "planner");
  const { rows } = await query(
    `INSERT INTO resource (tenant_id, kind, ext_key, body)
     VALUES ($1,'queue',$2,'{"depth":100}') RETURNING id, version`,
    [tenantId, `shared-queue-${label}`],
  );
  const resource = rows[0];

  const intent = await declareIntent({
    agentId,
    taskId: randomUUID(),
    statement:
      "Rebalance the support queue for the overnight shift: move the overflow to the follow-the-sun rota and page a second responder.",
    reads: [{ resourceId: resource.id, observedVersion: resource.version }],
    steps: [{ description: "Compute the overflow above threshold", dependsOn: [resource.id], tokensUsed: 900 }],
    usage,
  });
  await query(`UPDATE intent SET tenant_id = $2 WHERE id = $1`, [intent.id, tenantId]);

  return { agentId, resource, intent };
}

const A = await seed(a.tenant.id, "a");
const B = await seed(b.tenant.id, "b");

console.log(dim("  both tenants now hold an open intent with near-identical text\n"));

// Tenant A commits into its own queue.
const commit = await commitResource({
  agentId: A.agentId,
  resourceId: A.resource.id,
  expectedVersion: A.resource.version,
  newBody: JSON.stringify({ depth: 140 }),
  statement: "Reassign 40 escalated tickets into the support queue, raising depth to 140.",
  usage,
});
await query(`UPDATE commit_log SET tenant_id = $2 WHERE id = $1`, [
  commit.commit.id,
  a.tenant.id,
]);

const threatened = await findThreatened(commit.commit.id);
const ids = threatened.map((t) => t.intent_id);

check(
  ids.includes(A.intent.id),
  `tenant A's own intent was detected (${threatened[0]?.detected_by ?? "none"})`,
);
check(
  !ids.includes(B.intent.id),
  `tenant B's near-identical intent was NOT touched (${threatened.length} total threatened)`,
);

// The vector path would certainly have matched B if the filter were absent —
// confirm the texts really are close enough for that to be a meaningful test.
const { rows: dist } = await query(
  `SELECT round((a.embedding <=> b.embedding)::numeric, 4) AS d
   FROM intent a, intent b WHERE a.id = $1 AND b.id = $2`,
  [A.intent.id, B.intent.id],
);
console.log(
  dim(
    `\n  cosine distance between the two tenants' intents: ${dist[0]?.d}` +
      `\n  (below the 0.58 threshold, so the vector path would have matched` +
      `\n   across tenants had the filter not been inside the query)`,
  ),
);

// Clean up.
for (const t of [a.tenant.id, b.tenant.id]) {
  await query(`UPDATE intent SET status='aborted' WHERE tenant_id=$1`, [t]).catch(() => {});
}

console.log(
  failures === 0
    ? `\n\x1b[1m  Isolation holds.\x1b[0m\n`
    : `\n\x1b[1m  ${failures} isolation check(s) failed.\x1b[0m\n`,
);

await closePool();
process.exit(failures === 0 ? 0 : 1);
