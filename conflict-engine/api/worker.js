/**
 * SQS worker: adjudicates commits off the queue, in parallel.
 *
 * This is the other half of splitting commit from adjudication. Each message is
 * one landed commit; the worker runs the detection query, rules on everyone
 * threatened, and records the outcome.
 *
 * WHY DUPLICATES ARE FINE HERE
 * SQS is at-least-once, and a changefeed retries on any non-2xx, so the same
 * commit will occasionally arrive twice. That would normally demand careful
 * deduplication in the worker — except adjudication is already idempotent by
 * a UNIQUE index on (commit_id, intent_id), added for the chaos drill.
 *
 * So the property that made connection loss survivable also makes at-least-once
 * delivery survivable, without a line of extra code. Worth noticing: it is the
 * same invariant paying for itself twice.
 *
 * PARTIAL BATCH FAILURE
 * Reporting individual failed message IDs means one poisonous commit does not
 * force the whole batch to be redelivered. After three attempts a message goes
 * to the dead-letter queue rather than looping forever.
 *
 * CONCURRENCY CAP — LEARNED THE HARD WAY
 * The event-source mapping is configured with MaximumConcurrency=2.
 *
 * Without it, SQS scales pollers aggressively by default. On this account —
 * capped at 10 concurrent executions across every function — the worker
 * consumed the entire budget retrying, and the public API was throttled out of
 * its own service. Measured over twenty minutes: 15 API throttles and 55 worker
 * throttles, with the API pinned at exactly 10 concurrent executions.
 *
 * The asynchronous path exists so callers do not wait. Letting it starve the
 * synchronous path inverts the whole point of separating them.
 */
import { processCommit } from "../agents/interlock.js";
import { Usage } from "../agents/bedrock.js";
import { query, closePool } from "../agents/db.js";

/**
 * The service-wide monthly ceiling, enforced here too.
 *
 * This worker spends money and has no HTTP caller, so none of the API's quota
 * checks apply to it — and for the whole life of this file its inference was
 * neither counted against the ceiling nor stopped by it. Every commit fans out
 * to a changefeed, so the one path that runs *automatically*, at whatever rate
 * traffic arrives, was the one path with no ceiling at all.
 *
 * Read straight from the ledger rather than passed in. A cap that only holds
 * when someone remembers to plumb it through is not a cap.
 */
const MONTHLY_USD_LIMIT = Number(process.env.MONTHLY_USD_LIMIT ?? 25);

async function budgetExhausted() {
  try {
    const { rows } = await query(
      `SELECT coalesce(sum(usd_micros), 0) AS month
       FROM api_quota
       WHERE bucket = 'global' AND day >= date_trunc('month', current_date())`,
    );
    return Number(rows[0].month) / 1e6 >= MONTHLY_USD_LIMIT;
  } catch {
    // Fail open. A ledger we cannot read is not evidence of overspend, and
    // stalling adjudication on a transient database blip would break the
    // product to protect a budget that is probably fine.
    return false;
  }
}

/** Charge the worker's inference to the same ledger the API's ceiling reads. */
async function recordWorkerSpend(usage) {
  const micros = Math.round(usage.usd * 1e6);
  if (micros <= 0) return;
  for (const bucket of ["worker", "global"]) {
    await query(
      `INSERT INTO api_quota (day, bucket, calls, tokens, usd_micros)
       VALUES (current_date(), $1, 0, $2, $3)
       ON CONFLICT (day, bucket) DO UPDATE
       SET tokens = api_quota.tokens + EXCLUDED.tokens,
           usd_micros = api_quota.usd_micros + EXCLUDED.usd_micros,
           updated_at = now()`,
      [bucket, usage.tokensTotal, micros],
    ).catch(() => {});
  }
}

export const handler = async (event) => {
  const failures = [];
  const usage = new Usage("sqs-worker");
  let adjudicated = 0;

  // Checked once per batch, not per message: the ceiling is a coarse bound and
  // a query per message would cost more than it saves.
  if (await budgetExhausted()) {
    console.warn(
      JSON.stringify({
        skipped: event.Records?.length ?? 0,
        reason: `monthly inference budget of $${MONTHLY_USD_LIMIT} reached`,
      }),
    );
    // Nothing is returned as a failure. These messages are dropped rather than
    // retried: replaying them next month would adjudicate stale commits, and
    // the UNIQUE index already makes a missed ruling recoverable rather than
    // corrupting anything.
    return { batchItemFailures: [] };
  }

  for (const record of event.Records ?? []) {
    let commitId;
    try {
      const envelope = JSON.parse(record.body);
      // EventBridge wraps the payload in `detail`; a direct SQS send would not.
      const detail = envelope.detail ?? envelope;
      commitId = detail.commitId;

      if (!commitId) {
        // Nothing to retry — a malformed message will never become valid.
        console.warn("message without commitId, discarding", record.messageId);
        continue;
      }

      const outcomes = await processCommit(commitId, { usage });
      adjudicated += outcomes.length;

      await query(
        `INSERT INTO api_request (route, client_hash, status, duration_ms, tokens, detail)
         VALUES ('worker:adjudicate', 'sqs', 200, 0, $1, $2)`,
        [
          usage.tokensTotal,
          JSON.stringify({
            commitId,
            outcomes: outcomes.length,
            verdicts: outcomes.map((o) => o.verdict),
          }),
        ],
      ).catch(() => {});

      console.log(
        JSON.stringify({
          commitId,
          threatened: outcomes.length,
          verdicts: outcomes.map((o) => o.verdict),
          preserved: outcomes.reduce((n, o) => n + o.stepsPreserved, 0),
        }),
      );
    } catch (e) {
      console.error("adjudication failed", commitId, e.message);
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  // Charge before returning, so the next batch sees this one's spend.
  await recordWorkerSpend(usage);

  const u = usage.toJSON();
  console.log(
    JSON.stringify({
      batch: event.Records?.length ?? 0,
      adjudicated,
      failed: failures.length,
      usd: u.usd,
      tokens: u.tokensTotal,
    }),
  );

  if (process.env.CLOSE_POOL_PER_INVOKE === "1") await closePool();

  // Only these are redelivered; the rest are acknowledged.
  return { batchItemFailures: failures };
};
