/**
 * Changefeed webhook -> EventBridge.
 *
 * WHY THIS EXISTS AT ALL
 * Until now, a commit and the adjudication of everyone it threatened happened
 * in the same call. That is fine for a demo and wrong for a fleet: a commit
 * threatening fifty in-flight intents would block for fifty model calls before
 * returning, and the agent that made the commit is left waiting on other
 * agents' problems.
 *
 * Splitting them means a commit returns as soon as it is durable, and
 * adjudication happens on its own schedule, in parallel, with retries and a
 * dead-letter queue.
 *
 * WHY A CHANGEFEED RATHER THAN PUBLISHING FROM THE APP
 * The commit path could publish to EventBridge itself, and would be simpler.
 * But then "the write succeeded" and "the event was published" are two
 * operations that can disagree: a crash between them silently drops an
 * adjudication, and nothing in the system would ever notice.
 *
 * A changefeed reads the same durable log the commit was written to, so an
 * event exists if and only if the row does. CockroachDB is the source of truth
 * for both the state and the notification, which is exactly the property that
 * made it worth putting the memory here in the first place.
 */
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";

const BUS = process.env.EVENT_BUS_NAME || "interlock";
const SECRET = process.env.CDC_SHARED_SECRET || "";

const eb = new EventBridgeClient({ region: process.env.AWS_REGION || "us-east-1" });

/**
 * Handle one changefeed POST.
 *
 * CockroachDB webhook sinks send `{"payload":[{...row...}], "length": n}` and
 * expect 2xx. Anything else and it retries — which is the behaviour we want, so
 * failures here must be loud rather than swallowed.
 */
export async function handleChangefeed(event) {
  // The webhook URL is public, so the changefeed carries a shared secret.
  // Without it, anyone could inject fabricated commit events into the
  // adjudication pipeline.
  const provided =
    event?.queryStringParameters?.secret ??
    event?.headers?.["x-interlock-cdc"] ??
    "";
  if (SECRET && provided !== SECRET) {
    return { statusCode: 401, body: "unauthorized" };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: "bad json" };
  }

  const rows = Array.isArray(body.payload) ? body.payload : [];
  if (rows.length === 0) {
    // Resolved-timestamp heartbeats carry no rows. Acknowledge them or the
    // changefeed treats it as a failure and retries forever.
    return { statusCode: 200, body: "ok" };
  }

  const entries = rows
    .map((r) => r.after)
    .filter(Boolean)
    .map((after) => ({
      EventBusName: BUS,
      Source: "interlock.cdc",
      DetailType: "commit.landed",
      Detail: JSON.stringify({
        commitId: after.id,
        tenantId: after.tenant_id,
        resourceId: after.resource_id,
        agentId: after.agent_id,
        newVersion: after.new_version,
        committedAt: after.committed_at,
      }),
    }));

  if (entries.length === 0) return { statusCode: 200, body: "ok" };

  // PutEvents caps at 10 entries per call.
  let failed = 0;
  for (let i = 0; i < entries.length; i += 10) {
    const res = await eb.send(
      new PutEventsCommand({ Entries: entries.slice(i, i + 10) }),
    );
    failed += res.FailedEntryCount ?? 0;
  }

  // A non-2xx makes CockroachDB retry the batch, which is what we want when
  // the bus rejected entries: better a duplicate adjudication (idempotent by
  // unique index) than a lost one.
  if (failed > 0) {
    return { statusCode: 500, body: `${failed} entries failed` };
  }

  return { statusCode: 200, body: `published ${entries.length}` };
}
