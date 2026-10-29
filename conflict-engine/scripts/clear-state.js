/**
 * Clears runtime state between demo runs without dropping the schema.
 *
 * Keeps agents and resources (cheap to reuse) but retires every in-flight
 * intent, so a re-run starts from a clean contention picture rather than
 * inheriting threatened intents from the last one.
 *
 * Run: npm run demo:clear
 */
import { query, closePool } from "../agents/db.js";

const { rowCount: retired } = await query(
  `UPDATE intent
   SET status = 'aborted', resolved_at = now(), valid_to = now()
   WHERE status IN ('open', 'threatened', 'repairing')`,
);

const { rows: left } = await query(
  `SELECT status::STRING AS status, count(*) AS n
   FROM intent GROUP BY status ORDER BY n DESC`,
);

console.log(`retired ${retired} in-flight intent(s)`);
for (const r of left) console.log(`  ${String(r.status).padEnd(12)} ${r.n}`);

await closePool();
