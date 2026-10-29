/**
 * The contended workload, shared by all four modes.
 *
 * Every mode runs the SAME agents against the SAME resources doing the SAME
 * work. Only the concurrency-control strategy differs. Anything else would make
 * the comparison meaningless.
 *
 * THE ANOMALY TEST
 * Each resource carries a counter. An agent reads it, thinks, then writes
 * counter + 1. After the run, a correct execution must satisfy:
 *
 *     final_counter == number_of_successful_commits
 *
 * If it is lower, a write was lost: two agents read the same value and one
 * overwrote the other. This is the classic lost-update anomaly, and it is
 * checkable arithmetic rather than a judgement call — which matters, because
 * "did this system stay correct" should not be something we get to interpret.
 */
import { query } from "../agents/db.js";
import { complete } from "../agents/bedrock.js";

export const RESOURCE_KIND = "bench_queue";

/**
 * Real inference, not a sleep.
 *
 * The claim under test is about tokens, so the tokens have to be real. Each
 * agent genuinely asks a model to plan against the state it read; the returned
 * token counts are what the ledger records.
 */
/**
 * STEP DEPENDENCY IS THE WHOLE EXPERIMENT.
 *
 * The first version of this workload gave every agent three steps, all of which
 * depended on the contended counter. That is the worst possible case for
 * INTERLOCK — if everything depends on what changed, "repair only the dependent
 * steps" degenerates into "repair everything", and you have paid for
 * adjudication to arrive at what optimistic concurrency does for free.
 *
 * It is also unrepresentative. A real agent task interleaves work that depends
 * on the contended fact with work that does not: drafting a handover note
 * depends on the queue depth; paging a responder, writing the audit entry and
 * notifying the channel do not.
 *
 * So dependency is now a parameter rather than an accident. DEPENDENT_FRACTION
 * is stated openly and swept in `npm run bench:sweep`, because the honest claim
 * is not "INTERLOCK always wins" — it is "INTERLOCK wins above a crossover, and
 * here is where the crossover is."
 */
const DEPENDENT_FRACTION = Number(process.env.DEPENDENT_FRACTION ?? 0.34);

export async function think({
  resourceKey,
  counter,
  agentName,
  usage,
  stepCount = 3,
  /**
   * How much reasoning a task performs — the axis the crossover actually lives on.
   *
   * The first benchmark used ~300-token plans, which made INTERLOCK strictly
   * worse than optimistic concurrency: adjudicating a conflict cost several
   * times more than simply re-running the task. That is a true result for
   * cheap tasks, and it is not the regime this system is for.
   *
   * Real agent work is not a 300-token plan. It reads documents, calls tools,
   * writes code. When re-running a task is expensive, protecting the parts that
   * are still valid starts to pay. Sweeping this parameter is how we find the
   * point where it does, rather than asserting one.
   */
  thinkTokens = 200,
  /**
   * How many reasoning passes the task performs.
   *
   * Sweeping `thinkTokens` alone saturates: one call will only ever emit so
   * much, so past ~3,300 tokens the axis stops moving and the curve flattens
   * for an uninteresting reason.
   *
   * Real agent tasks are not one call. They plan, then refine against what they
   * found, then verify — each pass building on the last. Chaining passes is both
   * more faithful and the only way to reach the task sizes where discarding work
   * genuinely hurts.
   */
  passes = 1,
}) {
  const nDependent = Math.max(1, Math.round(stepCount * DEPENDENT_FRACTION));
  const detail =
    thinkTokens > 400
      ? " For each step give concrete detail: which tickets, which thresholds, what the responder is told, and why."
      : "";

  const system = `You are a queue-balancing agent. Reply with exactly ${stepCount} numbered steps and no preamble.
The FIRST ${nDependent} step(s) must depend on the queue's current depth.
The REMAINING step(s) must be independent of the depth: notifications, logging, handover, scheduling.${detail}`;

  let res;
  let carried = "";
  for (let pass = 0; pass < Math.max(1, passes); pass++) {
    res = await complete({
      tier: "bulk",
      system,
      prompt:
        pass === 0
          ? `Queue "${resourceKey}" currently shows depth ${counter}. You are ${agentName}. Plan how to admit one more work item and rebalance.`
          : `Queue "${resourceKey}" at depth ${counter}. Your previous plan was:\n\n${carried}\n\nRevise it: tighten the depth-sensitive steps and make the independent steps more specific. Return the full revised plan in the same format.`,
      maxTokens: thinkTokens,
      usage,
    });
    carried = res.text;
  }

  let steps = res.text
    .split("\n")
    .map((l) => l.replace(/^\s*\d+[.)]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, stepCount);

  // Keep the shape stable even if the model under-delivers, so a short reply
  // cannot quietly change the experiment's parameters.
  while (steps.length < stepCount) {
    steps.push(`Record audit entry ${steps.length + 1} for ${resourceKey}`);
  }

  return {
    steps: steps.map((description, i) => ({
      description,
      dependsOnCounter: i < nDependent,
    })),
    nDependent,
    tokens: res.tokensIn + res.tokensOut,
    text: res.text,
  };
}

/**
 * Clear everything a previous run left behind, in foreign-key order.
 *
 * Resources cannot simply be deleted: intent_read, commit_log and adjudication
 * all point at them. Deleting bottom-up is the difference between a clean run
 * and a constraint violation halfway through seeding.
 */
export async function resetBenchState() {
  // repair cascades from adjudication; intent_read and plan_step cascade
  // from intent. Everything else has to go explicitly.
  await query(`DELETE FROM adjudication WHERE commit_id IN (
                 SELECT c.id FROM commit_log c
                 JOIN resource r ON r.id = c.resource_id
                 WHERE r.kind = $1)`, [RESOURCE_KIND]);
  await query(`DELETE FROM commit_log WHERE resource_id IN (
                 SELECT id FROM resource WHERE kind = $1)`, [RESOURCE_KIND]);
  await query(`DELETE FROM provenance_edge WHERE from_id IN (
                 SELECT id FROM resource WHERE kind = $1)`, [RESOURCE_KIND]);
  await query(`DELETE FROM intent WHERE id IN (
                 SELECT ir.intent_id FROM intent_read ir
                 JOIN resource r ON r.id = ir.resource_id
                 WHERE r.kind = $1)`, [RESOURCE_KIND]);
  await query(`DELETE FROM resource WHERE kind = $1`, [RESOURCE_KIND]);
}

/** Reset the benchmark resources to a known state. */
export async function seedResources(count) {
  await resetBenchState();
  const ids = [];
  for (let i = 0; i < count; i++) {
    const { rows } = await query(
      `INSERT INTO resource (kind, ext_key, body, version)
       VALUES ($1, $2, '{"counter":0}'::JSONB, 1)
       RETURNING id, ext_key, version`,
      [RESOURCE_KIND, `q-${i}`],
    );
    ids.push(rows[0]);
  }
  return ids;
}

/** Retire any intents left over from a previous mode. */
export async function clearIntents() {
  await query(
    `UPDATE intent SET status = 'aborted', resolved_at = now()
     WHERE status IN ('open','threatened','repairing')`,
  );
}

/**
 * Final counters vs successful commits.
 * Returns { expected, actual, lost } — `lost` is the anomaly count.
 */
export async function checkAnomalies(expectedCommits) {
  const { rows } = await query(
    `SELECT coalesce(sum((body->>'counter')::INT8), 0) AS total
     FROM resource WHERE kind = $1`,
    [RESOURCE_KIND],
  );
  const actual = Number(rows[0].total);
  return {
    expected: expectedCommits,
    actual,
    lost: Math.max(0, expectedCommits - actual),
  };
}

/** Assign agents to resources so contention is guaranteed, not hoped for. */
export function assignments(agentCount, resources) {
  const out = [];
  for (let i = 0; i < agentCount; i++) {
    out.push({
      agentIndex: i,
      name: `bench-agent-${i}`,
      resource: resources[i % resources.length],
    });
  }
  return out;
}
