/**
 * Start, stop and inspect the commit changefeed.
 *
 * The changefeed is the seam between "the write is durable" and "someone has
 * been told about it". Publishing from the application instead would make those
 * two operations able to disagree: a crash between the commit and the publish
 * silently drops an adjudication, and nothing in the system would ever notice.
 *
 * Reading the same durable log the row was written to means an event exists if
 * and only if the row does.
 *
 * It is a script rather than always-on because a running changefeed consumes
 * cluster resources and this project is on a trial budget. Start it before a
 * demo, stop it after.
 *
 *   npm run cdc:start     begin streaming commit_log to the webhook
 *   npm run cdc:status    list jobs and their state
 *   npm run cdc:stop      cancel every INTERLOCK changefeed
 */
import { query, closePool } from "../agents/db.js";
import { requireEnv } from "./env.js";

const ok = (s) => `\x1b[32mOK\x1b[0m    ${s}`;
const bad = (s) => `\x1b[31mFAIL\x1b[0m  ${s}`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const cmd = process.argv[2] ?? "status";
const API = process.env.PUBLIC_API_URL ||
  "https://wpvk3ox2bxo2w3zhxmx54ssjf40rakuz.lambda-url.us-east-1.on.aws/";

async function status() {
  const { rows } = await query(
    `SELECT job_id, status, description FROM [SHOW CHANGEFEED JOBS]`,
  );
  if (rows.length === 0) return console.log(dim("  no changefeed jobs"));
  for (const r of rows) {
    console.log(
      `  ${String(r.job_id)}  ${String(r.status).padEnd(9)} ${String(r.description).slice(0, 74)}`,
    );
  }
}

if (cmd === "start") {
  const secret = requireEnv("CDC_SHARED_SECRET", "Set by the API deploy step.");
  const url = `${API.replace(/\/$/, "")}/v1/cdc?secret=${secret}`;

  // webhook-https:// is CockroachDB's sink scheme. `updated` adds the MVCC
  // timestamp; `resolved` sends periodic heartbeats so a quiet feed still
  // proves it is alive rather than merely silent.
  //
  // initial_scan = 'no' is NOT optional here, and the reason is expensive.
  //
  // Changefeeds perform an initial scan by default: on creation they emit every
  // existing row before streaming new ones. The first time this ran, that meant
  // the worker adjudicated the entire history of commit_log — 22 batches and
  // 25,000 tokens of inference to re-decide conflicts that were settled days
  // ago. Nothing broke, because the UNIQUE index on (commit_id, intent_id) made
  // every replayed ruling a no-op, but it was real money spent on a no-op.
  //
  // We want new commits, not a re-run of history.
  const sql = `CREATE CHANGEFEED FOR TABLE commit_log
               INTO 'webhook-${url}'
               WITH updated, resolved = '30s', initial_scan = 'no'`;

  try {
    const { rows } = await query(sql);
    console.log(ok(`changefeed started, job ${String(rows[0]?.job_id)}`));
    console.log(dim(`      commit_log -> ${API}v1/cdc -> EventBridge -> SQS -> worker`));
  } catch (e) {
    console.log(bad(e.message.split("\n")[0]));
    process.exit(1);
  }
} else if (cmd === "stop") {
  const { rows } = await query(`SELECT job_id FROM [SHOW CHANGEFEED JOBS] WHERE status = 'running'`);
  for (const r of rows) {
    await query(`CANCEL JOB ${r.job_id}`).catch(() => {});
    console.log(ok(`cancelled ${String(r.job_id)}`));
  }
  if (rows.length === 0) console.log(dim("  nothing running"));
} else {
  await status();
}

await closePool();
