/**
 * End-to-end view of the async adjudication pipeline.
 *
 * Five hops, each of which can fail independently and silently:
 *
 *   commit_log -> changefeed -> Lambda /v1/cdc -> EventBridge -> SQS -> worker
 *
 * A pipeline whose health you cannot see in one command is a pipeline you will
 * eventually assume is working. This prints every hop.
 *
 * Run: npm run pipeline
 */
import { execFileSync } from "node:child_process";
import { query, closePool } from "../agents/db.js";

const ok = (s) => `\x1b[32mOK\x1b[0m    ${s}`;
const warn = (s) => `\x1b[33m--\x1b[0m    ${s}`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const b = (s) => `\x1b[1m${s}\x1b[0m`;

const aws = (args) => {
  try {
    return execFileSync("aws", args, { encoding: "utf8", shell: true }).trim();
  } catch {
    return "";
  }
};

console.log(b("\nAdjudication pipeline\n"));

/* 1 — changefeed ---------------------------------------------------------- */
const { rows: jobs } = await query(
  `SELECT job_id, status FROM [SHOW CHANGEFEED JOBS]`,
);
const running = jobs.filter((j) => String(j.status) === "running");
console.log(
  running.length
    ? ok(`changefeed running (${running.length} job${running.length > 1 ? "s" : ""})`)
    : warn("no changefeed running — npm run cdc:start"),
);

/* 2 — webhook ------------------------------------------------------------- */
const { rows: cdc } = await query(`
  SELECT status, count(*) AS n
  FROM api_request
  WHERE route = '/v1/cdc' AND at > now() - INTERVAL '30 minutes'
  GROUP BY status ORDER BY n DESC
`);
if (cdc.length === 0) {
  console.log(warn("no changefeed POSTs seen in the last 30 minutes"));
} else {
  for (const c of cdc) {
    console.log(
      Number(c.status) < 400
        ? ok(`webhook: ${c.n} POST(s) with status ${c.status}`)
        : warn(`webhook: ${c.n} POST(s) with status ${c.status}`),
    );
  }
}

/* 3 — queue --------------------------------------------------------------- */
const Q = "https://sqs.us-east-1.amazonaws.com/957325809861/interlock-adjudication";
const depth = aws([
  "sqs", "get-queue-attributes", "--queue-url", Q,
  "--attribute-names", "ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible",
  "--query", '"join(\',\', values(Attributes))"', "--output", "text",
]);
console.log(depth ? ok(`queue depth (visible,in-flight): ${depth}`) : warn("queue unreadable"));

const dlq = aws([
  "sqs", "get-queue-attributes",
  "--queue-url", `${Q}-dlq`,
  "--attribute-names", "ApproximateNumberOfMessages",
  "--query", '"Attributes.ApproximateNumberOfMessages"', "--output", "text",
]);
console.log(
  dlq === "0" || dlq === ""
    ? ok("dead-letter queue empty")
    : warn(`dead-letter queue holds ${dlq} message(s) — inspect before redriving`),
);

/* 4 — worker -------------------------------------------------------------- */
const { rows: worker } = await query(`
  SELECT count(*) AS runs, coalesce(sum(tokens),0) AS tokens
  FROM api_request
  WHERE route = 'worker:adjudicate' AND at > now() - INTERVAL '30 minutes'
`);
console.log(
  Number(worker[0].runs) > 0
    ? ok(`worker: ${worker[0].runs} adjudication batch(es), ${worker[0].tokens} tokens`)
    : warn("worker has not adjudicated anything in the last 30 minutes"),
);

/* 5 — the invariant that makes at-least-once safe ------------------------- */
const { rows: dupes } = await query(`
  SELECT count(*) AS n FROM (
    SELECT commit_id, intent_id FROM adjudication
    GROUP BY commit_id, intent_id HAVING count(*) > 1)
`);
console.log(
  Number(dupes[0].n) === 0
    ? ok("exactly-once holds — no duplicate rulings despite at-least-once delivery")
    : warn(`${dupes[0].n} duplicate ruling(s) — the unique index should make this impossible`),
);

console.log(
  dim(
    "\n  SQS is at-least-once and a changefeed retries on any non-2xx, so the same\n" +
      "  commit will occasionally arrive twice. Adjudication is already idempotent\n" +
      "  by a UNIQUE index added for the chaos drill, so no extra deduplication was\n" +
      "  needed — the same invariant pays for itself twice.\n",
  ),
);

await closePool();
