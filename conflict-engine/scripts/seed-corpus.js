/**
 * Seed a realistic corpus of agent intents, with real embeddings.
 *
 * WHY
 * The landing page claims semantic conflict detection runs on a distributed
 * vector index. At forty rows the planner correctly ignores that index — a full
 * scan of forty rows is cheaper — which left the claim true in design and
 * unproven in practice. A judge could fairly ask why we built an index nothing
 * uses.
 *
 * The honest fix is volume, not a caveat.
 *
 * NOT SYNTHETIC PADDING
 * Every vector here comes from Titan embedding a real sentence. The statements
 * are generated combinatorially rather than hand-written, but they are the kind
 * of thing the agents in this system actually say, and the embeddings are the
 * same ones the detector would compute. Random unit vectors would have proven
 * index selection while making every nearest-neighbour result meaningless.
 *
 * WHY THESE ROWS ARE 'open' AND NOT 'aborted'
 * They were 'aborted' at first, on the reasoning that a resolved intent cannot
 * be adjudicated by accident. Then migration 010 made the vector index PARTIAL —
 * it covers `status IN ('open','threatened')`, because semantic detection only
 * ever asks about plans still in flight — and the entire corpus fell outside the
 * index it exists to exercise. 1,741 seeded rows, 20 rows in the index, and a
 * README caveat saying the planner prefers a scan. Every part of that was true
 * and the conclusion was still wrong.
 *
 * Isolation does not come from the status. It comes from the tenant: every
 * detection query filters `tenant_id IS NOT DISTINCT FROM` the committing
 * tenant, so a commit in anyone else's tenant cannot see these no matter what
 * state they are in. The status was never what made them safe — it only made
 * them invisible.
 *
 *   npm run seed:corpus            add 2000 intents
 *   npm run seed:corpus -- --n 500
 *   npm run seed:corpus -- --clean  remove them
 */
import { query, closePool } from "../agents/db.js";
import { embed, Usage } from "../agents/bedrock.js";
import { randomUUID } from "node:crypto";

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};
const N = Number(arg("n", 2000));
const CLEAN = argv.includes("--clean");
const CONCURRENCY = Number(arg("concurrency", 16));

const SLUG = "corpus-seed";
const ok = (s) => `\x1b[32mOK\x1b[0m    ${s}`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

/* A combinatorial space of plausible agent intents. */
const VERBS = ["Rebalance", "Drain", "Reprioritise", "Consolidate", "Split", "Freeze", "Expand", "Audit"];
const OBJECTS = ["the EU support queue", "the payments retry backlog", "the nightly index build",
  "the fraud review pool", "the onboarding checklist", "the shipment exception queue",
  "the model evaluation batch", "the invoice reconciliation run"];
const REASONS = ["ahead of the overnight shift", "because depth crossed the threshold",
  "after the regional failover", "to clear the weekend backlog", "before the compliance window closes",
  "while the primary team is offline", "in response to a latency alert", "for the quarterly close"];
const ACTIONS = ["and page a second responder", "and hand the overflow to the APAC rota",
  "and notify the duty manager", "and open a change record", "and re-run the affected steps",
  "and hold non-urgent items", "and raise the concurrency cap", "and snapshot before proceeding"];

const statementFor = (i) =>
  `${VERBS[i % VERBS.length]} ${OBJECTS[(i * 3) % OBJECTS.length]} ${REASONS[(i * 5) % REASONS.length]}, ${ACTIONS[(i * 7) % ACTIONS.length]}.`;

async function tenantId() {
  const { rows } = await query(`SELECT id FROM tenant WHERE slug = $1`, [SLUG]);
  if (rows[0]) return rows[0].id;
  const { rows: ins } = await query(
    `INSERT INTO tenant (name, slug) VALUES ('Corpus seed (index-selection proof)', $1) RETURNING id`,
    [SLUG],
  );
  return ins[0].id;
}

if (CLEAN) {
  const t = await tenantId();
  const { rowCount } = await query(`DELETE FROM intent WHERE tenant_id = $1`, [t]);
  console.log(ok(`removed ${rowCount} corpus intents`));
  await closePool();
  process.exit(0);
}

const tid = await tenantId();
const { rows: agentRow } = await query(
  `INSERT INTO agent (tenant_id, name, role) VALUES ($1, 'corpus-agent', 'seed')
   ON CONFLICT DO NOTHING RETURNING id`,
  [tid],
);
const agentId =
  agentRow[0]?.id ??
  (await query(`SELECT id FROM agent WHERE tenant_id = $1 AND name = 'corpus-agent'`, [tid])).rows[0].id;

const usage = new Usage("corpus");
const started = Date.now();
let done = 0;

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Embed with backoff.
 *
 * Bedrock throttles on burst, and at sixteen concurrent workers this run died
 * partway through with a ThrottlingException. Retrying is correct — the request
 * was valid, the service was simply busy — and dying halfway through a seed
 * leaves the corpus in a size nobody chose.
 */
async function embedWithRetry(text, attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await embed(text, usage);
    } catch (e) {
      // The AWS SDK puts the condition in `name` and often leaves `message`
      // empty, so testing only the message silently disabled these retries and
      // let the seed die at 1413 rows.
      const signal = `${e.name ?? ""} ${e.message ?? ""} ${e.$metadata?.httpStatusCode ?? ""}`;
      const throttled = /throttl|too many requests|429|serviceunavailable|503/i.test(signal);
      if (!throttled || i === attempts - 1) throw e;
      await pause(400 * 2 ** i + Math.random() * 300);
    }
  }
}

/** Bounded parallelism, kept low enough that Bedrock does not push back. */
async function worker(slice) {
  for (const i of slice) {
    const statement = statementFor(i);
    const { literal } = await embedWithRetry(statement);
    await query(
      `INSERT INTO intent (tenant_id, agent_id, task_id, status, statement, embedding, read_hlc)
       VALUES ($1, $2, $3, 'open', $4, $5::VECTOR, cluster_logical_timestamp())`,
      [tid, agentId, randomUUID(), statement, literal],
    );
    done++;
    if (done % 200 === 0) {
      process.stdout.write(dim(`  ${done}/${N} embedded…\r`));
    }
  }
}

const indices = Array.from({ length: N }, (_, i) => i);
const slices = Array.from({ length: CONCURRENCY }, (_, w) =>
  indices.filter((i) => i % CONCURRENCY === w),
);
await Promise.all(slices.map(worker));

const u = usage.toJSON();
const { rows: total } = await query(
  `SELECT count(*)::INT8 AS n FROM intent WHERE embedding IS NOT NULL`,
);
// The number that decides whether any of this mattered: rows inside the partial
// index, not rows in the table.
const { rows: indexed } = await query(
  `SELECT count(*)::INT8 AS n FROM intent
   WHERE status IN ('open','threatened') AND embedding IS NOT NULL`,
);

console.log(
  ok(
    `seeded ${done} intents in ${((Date.now() - started) / 1000).toFixed(0)}s — ` +
      `${total[0].n} embedded rows total, ${indexed[0].n} inside the vector index`,
  ),
);
console.log(
  dim(
    `      ${u.embedTokens} embedding tokens, $${u.usd.toFixed(5)}\n` +
      `      Isolated by tenant, not by status: every detection query filters on\n` +
      `      tenant_id, so no other tenant's commit can reach these.\n` +
      `      Check the planner now:  npm run ai:vector\n` +
      `      Remove with:            npm run seed:corpus -- --clean`,
  ),
);

await closePool();
