/**
 * INTERLOCK — the mechanism.
 *
 *   1. declare      an agent states its plan and read-set before acting
 *   2. watch        a commit lands; who is actually threatened?
 *   3. diff         show the threatened agent what changed since its snapshot
 *   4. adjudicate   irrelevant / invalidating / fatal
 *   5. resolve      proceed, repair only the dependent steps, or abort
 *
 * The substitution at the heart of it: classical optimistic concurrency asks
 * "did any version I read change?" and aborts if so. INTERLOCK asks "does what
 * changed actually invalidate my plan?" — and when the answer is yes, repairs
 * precisely the steps that depended on the changed fact.
 *
 * Correctness never rests on the model's judgement. The final write is a real
 * SERIALIZABLE transaction, so a wrong ruling costs wasted work, not a lost
 * update.
 */
import { query, serializableTx, clusterHlc } from "./db.js";
import { embed, complete } from "./bedrock.js";
import { investigate, INVESTIGATION_MENU } from "./investigate.js";

/**
 * COSINE distance above which a vector match is too weak to adjudicate.
 *
 * Measured, not guessed — see `npm run ai:calibrate`. Against a reference
 * intent, real Titan embeddings land at:
 *
 *   same meaning, different words   0.294
 *   directly conflicting            0.524   <- must be caught
 *   same domain, unrelated          0.644   <- must be ignored
 *   different domain                0.934
 *
 * 0.58 is the midpoint of the only gap that matters. The detector deliberately
 * errs toward adjudicating: a false positive costs one cheap model call, a
 * false negative lets a corrupted plan commit.
 *
 * NOTE THE OPERATOR. This threshold is meaningful only for `<=>` (cosine).
 * CockroachDB also offers `<->` (L2) and `<#>` (negative inner product), and on
 * the same pairs L2 puts "conflicting" at 1.023 — so a cosine threshold silently
 * disables the semantic path if applied to L2. That mismatch is exactly the bug
 * this constant used to have.
 */
const SEMANTIC_THRESHOLD = Number(process.env.SEMANTIC_THRESHOLD ?? 0.58);
/** How many nearest intents to consider per commit. */
const SEMANTIC_K = Number(process.env.SEMANTIC_K ?? 10);

/* ========================================================================== */
/* STEP 1 — DECLARE                                                           */
/* ========================================================================== */

/**
 * Write an intent before acting.
 *
 * `read_hlc` is captured inside the same transaction as the reads, so the
 * timestamp genuinely corresponds to the snapshot the agent saw. That is what
 * makes step 3 honest — we replay what it actually looked at, not an
 * approximation of it.
 */
export async function declareIntent({
  agentId,
  taskId,
  statement,
  reads = [], // [{ resourceId, observedVersion }]
  steps = [], // [{ description, dependsOn: [resourceId] }]
  usage,
  /**
   * Embed every plan step as well as the intent.
   *
   * Off by default. The threat detector searches `intent.embedding` only, so
   * step vectors buy nothing on the hot path while costing one embedding call
   * per step — which on the first benchmark run was most of INTERLOCK's
   * measured overhead. Turn it on for step-level semantic matching, and pay
   * for it deliberately.
   */
  embedSteps = process.env.EMBED_PLAN_STEPS === "1",
}) {
  const { literal: intentVec } = await embed(statement, usage);

  const stepVectors = [];
  if (embedSteps) {
    for (const s of steps) {
      const { literal } = await embed(s.description, usage);
      stepVectors.push(literal);
    }
  }

  const { result } = await serializableTx(
    async (client) => {
      const hlc = await clusterHlc(client);

      const { rows } = await client.query(
        `INSERT INTO intent (agent_id, task_id, statement, embedding, read_hlc)
         VALUES ($1, $2, $3, $4::VECTOR, $5)
         RETURNING id, read_hlc, recorded_at`,
        [agentId, taskId, statement, intentVec, hlc],
      );
      const intent = rows[0];

      for (const r of reads) {
        await client.query(
          `INSERT INTO intent_read (intent_id, resource_id, observed_version)
           VALUES ($1, $2, $3)
           ON CONFLICT (intent_id, resource_id) DO NOTHING`,
          [intent.id, r.resourceId, r.observedVersion],
        );
      }

      const stepIds = [];
      for (const [i, s] of steps.entries()) {
        const { rows: sr } = await client.query(
          `INSERT INTO plan_step (intent_id, seq, description, embedding, tokens_used)
           VALUES ($1, $2, $3, $4::VECTOR, $5)
           RETURNING id`,
          [intent.id, i, s.description, stepVectors[i], s.tokensUsed ?? 0],
        );
        stepIds.push(sr[0].id);

        // Provenance: this step derived from these resources, and from the step
        // before it. Those edges are what let the blast radius be computed at
        // step granularity instead of whole-task granularity.
        for (const resourceId of s.dependsOn ?? []) {
          await client.query(
            `INSERT INTO provenance_edge (from_kind, from_id, to_kind, to_id)
             VALUES ('resource', $1, 'step', $2)
             ON CONFLICT DO NOTHING`,
            [resourceId, sr[0].id],
          );
        }
        if (i > 0) {
          await client.query(
            `INSERT INTO provenance_edge (from_kind, from_id, to_kind, to_id)
             VALUES ('step', $1, 'step', $2)
             ON CONFLICT DO NOTHING`,
            [stepIds[i - 1], sr[0].id],
          );
        }
      }

      return { ...intent, stepIds };
    },
    { label: "declareIntent" },
  );

  return result;
}

/**
 * Append steps to an intent that is already open.
 *
 * WHY THIS EXISTS
 * `declareIntent` assumes the plan is known when the task begins. For a
 * hand-written agent that is fair. For a framework agent it is not: LangChain
 * fires its chain-start callback before a single tool has run, so a callback
 * that declared everything up front would declare an empty plan — and an intent
 * with no steps has no provenance edges, so every conflict against it resolves
 * to "irrelevant" by the graph pre-filter. Correct machinery, wrong answer,
 * and silently: the ruling looks confident.
 *
 * So steps accrue as they happen. The intent is still declared before the agent
 * acts, which is the guarantee that matters; only the detail arrives late.
 *
 * `seq` continues from whatever is already stored rather than restarting, and
 * the chain edge is drawn from the real predecessor, so a plan built across
 * several calls has the same provenance shape as one declared in a single shot.
 */
export async function appendSteps({ intentId, steps = [], usage, embedSteps = process.env.EMBED_PLAN_STEPS === "1" }) {
  if (steps.length === 0) return { added: 0, stepIds: [] };

  const stepVectors = [];
  if (embedSteps) {
    for (const s of steps) {
      const { literal } = await embed(s.description, usage);
      stepVectors.push(literal);
    }
  }

  const { result } = await serializableTx(
    async (client) => {
      // The tail of the existing plan, so numbering and the chain edge continue
      // rather than fork. Read inside the transaction: two callbacks racing to
      // append would otherwise both claim the same seq.
      const { rows: tail } = await client.query(
        `SELECT id, seq FROM plan_step WHERE intent_id = $1 ORDER BY seq DESC LIMIT 1`,
        [intentId],
      );

      let prevId = tail[0]?.id ?? null;
      let seq = tail[0] ? Number(tail[0].seq) + 1 : 0;
      const stepIds = [];

      for (const [i, s] of steps.entries()) {
        const { rows: sr } = await client.query(
          `INSERT INTO plan_step (intent_id, seq, description, embedding, tokens_used)
           VALUES ($1, $2, $3, $4::VECTOR, $5)
           RETURNING id`,
          [intentId, seq, s.description, stepVectors[i], s.tokensUsed ?? 0],
        );
        const id = sr[0].id;
        stepIds.push(id);

        for (const resourceId of s.dependsOn ?? []) {
          await client.query(
            `INSERT INTO provenance_edge (from_kind, from_id, to_kind, to_id)
             VALUES ('resource', $1, 'step', $2)
             ON CONFLICT DO NOTHING`,
            [resourceId, id],
          );
        }
        if (prevId) {
          await client.query(
            `INSERT INTO provenance_edge (from_kind, from_id, to_kind, to_id)
             VALUES ('step', $1, 'step', $2)
             ON CONFLICT DO NOTHING`,
            [prevId, id],
          );
        }

        prevId = id;
        seq += 1;
      }

      return { added: steps.length, stepIds };
    },
    { label: "appendSteps" },
  );

  return result;
}

/* ========================================================================== */
/* Committing a change to shared state                                        */
/* ========================================================================== */

/**
 * Apply a write to a resource and log it as a fact that just became true.
 *
 * The version check inside the transaction is what makes a lost update
 * impossible: if someone else moved the row since we read it, the guard fails
 * and the caller is told, rather than silently overwriting.
 */
export async function commitResource({
  agentId,
  intentId = null,
  resourceId,
  expectedVersion,
  newBody,
  statement,
  usage,
}) {
  const { literal: commitVec } = await embed(statement, usage);

  const { result, attempts } = await serializableTx(
    async (client) => {
      const { rows: cur } = await client.query(
        `SELECT version FROM resource WHERE id = $1`,
        [resourceId],
      );
      if (cur.length === 0) throw new Error(`resource ${resourceId} not found`);

      if (expectedVersion != null && cur[0].version !== expectedVersion) {
        return {
          conflict: true,
          expected: expectedVersion,
          actual: cur[0].version,
        };
      }

      const prevVersion = cur[0].version;
      const newVersion = prevVersion + 1;

      await client.query(
        `UPDATE resource SET body = $2, version = $3, updated_at = now()
         WHERE id = $1`,
        [resourceId, newBody, newVersion],
      );

      const hlc = await clusterHlc(client);
      const { rows } = await client.query(
        `INSERT INTO commit_log
           (agent_id, intent_id, resource_id, prev_version, new_version,
            statement, embedding, commit_hlc)
         VALUES ($1, $2, $3, $4, $5, $6, $7::VECTOR, $8)
         RETURNING id, committed_at, commit_hlc`,
        [
          agentId,
          intentId,
          resourceId,
          prevVersion,
          newVersion,
          statement,
          commitVec,
          hlc,
        ],
      );

      if (intentId) {
        await client.query(
          `UPDATE intent SET status = 'committed', resolved_at = now(),
                             valid_to = now()
           WHERE id = $1`,
          [intentId],
        );
      }

      return { conflict: false, commit: rows[0], prevVersion, newVersion };
    },
    { label: "commitResource" },
  );

  return { ...result, attempts };
}

/* ========================================================================== */
/* STEP 2 — WATCH: who does this commit actually threaten?                    */
/* ========================================================================== */

/**
 * Three detection paths, one query, one snapshot.
 *
 *   exact      intents that read this very row at an older version
 *   derived    a recursive walk of the provenance graph — anything downstream
 *              of the changed resource, at step granularity
 *   semantic   approximate-nearest-neighbour over intent embeddings, which
 *              catches the intents that share meaning but no rows
 *
 * The third is why this lives in CockroachDB rather than beside it. The vector
 * search and the graph walk execute against the SAME transactional snapshot. A
 * bolt-on vector store would reintroduce precisely the consistency gap this
 * system exists to close.
 */
const THREATENED_SQL = `
WITH RECURSIVE
  c AS (
    SELECT id, resource_id, new_version, embedding, statement, tenant_id
    FROM commit_log
    WHERE id = $1
  ),

  -- 1. Literal dependents: read this row, saw an older version.
  --
  --    Note the tenant predicate on every arm below. It sits inside the query
  --    rather than in a wrapper because a missed filter here would not merely
  --    leak a row: one customer's commit would adjudicate another customer's
  --    in-flight plans and repair steps in work they cannot see.
  exact AS (
    SELECT ir.intent_id, 'exact' AS how, NULL::FLOAT8 AS distance
    FROM intent_read ir
    JOIN c ON ir.resource_id = c.resource_id
    JOIN intent i ON i.id = ir.intent_id
    WHERE i.status IN ('open', 'threatened')
      AND i.tenant_id IS NOT DISTINCT FROM c.tenant_id
      AND ir.observed_version < c.new_version
  ),

  -- 2. Everything derived from the changed resource, transitively.
  descendants AS (
    SELECT pe.to_kind, pe.to_id
    FROM provenance_edge pe
    JOIN c ON pe.from_id = c.resource_id
    WHERE pe.from_kind = 'resource'
    UNION
    SELECT pe.to_kind, pe.to_id
    FROM provenance_edge pe
    JOIN descendants d
      ON pe.from_kind = d.to_kind AND pe.from_id = d.to_id
  ),
  derived AS (
    SELECT DISTINCT ps.intent_id, 'graph' AS how, NULL::FLOAT8 AS distance
    FROM descendants d
    JOIN plan_step ps ON d.to_kind = 'step' AND ps.id = d.to_id
    JOIN intent i ON i.id = ps.intent_id
    CROSS JOIN c
    WHERE i.status IN ('open', 'threatened')
      AND i.tenant_id IS NOT DISTINCT FROM c.tenant_id
  ),

  -- 3. Semantically close intents. No shared rows required.
  --    The operator below is COSINE. See SEMANTIC_THRESHOLD in this module:
  --    swapping in L2 while keeping a cosine-scaled threshold silently
  --    disables this entire path.
  semantic AS (
    SELECT i.id AS intent_id,
           'vector' AS how,
           (i.embedding <=> (SELECT embedding FROM c)) AS distance
    FROM intent i
    WHERE i.status IN ('open', 'threatened')
      AND i.embedding IS NOT NULL
      AND i.tenant_id IS NOT DISTINCT FROM (SELECT tenant_id FROM c)
    ORDER BY i.embedding <=> (SELECT embedding FROM c)
    LIMIT $2
  ),

  merged AS (
    SELECT * FROM exact
    UNION ALL SELECT * FROM derived
    UNION ALL SELECT * FROM semantic WHERE distance <= $3
  )

SELECT
  m.intent_id,
  -- Name every path that fired, e.g. 'exact+graph+vector'. An earlier version
  -- collapsed this to "both", which made an exact+graph hit indistinguishable
  -- from an exact+vector one, and quietly hid the fact that the vector path was
  -- never firing at all.
  --
  -- Built from bool_or rather than string_agg(DISTINCT ... ORDER BY ...), which
  -- CockroachDB rejects. concat_ws drops the NULLs, so the order is fixed and
  -- the output is stable across runs.
  concat_ws('+',
    CASE WHEN bool_or(m.how = 'exact')  THEN 'exact'  END,
    CASE WHEN bool_or(m.how = 'graph')  THEN 'graph'  END,
    CASE WHEN bool_or(m.how = 'vector') THEN 'vector' END
  ) AS detected_by,
  min(m.distance) AS distance,
  i.statement,
  i.read_hlc,
  i.agent_id,
  a.name AS agent_name
FROM merged m
JOIN intent i ON i.id = m.intent_id
JOIN agent a ON a.id = i.agent_id
WHERE i.id <> COALESCE((SELECT intent_id FROM commit_log WHERE id = $1), '00000000-0000-0000-0000-000000000000'::UUID)
GROUP BY m.intent_id, i.statement, i.read_hlc, i.agent_id, a.name
ORDER BY distance NULLS FIRST
`;

export async function findThreatened(commitId, { k = SEMANTIC_K, threshold = SEMANTIC_THRESHOLD } = {}) {
  const { rows } = await query(THREATENED_SQL, [commitId, k, threshold]);
  return rows;
}

/* ========================================================================== */
/* STEP 3 — DIFF: what changed since this intent's snapshot?                  */
/* ========================================================================== */

/**
 * Replay the exact snapshot the agent read, and diff it against now.
 *
 * This is `AS OF SYSTEM TIME` doing work no other database in this category can
 * do. Note the deliberate fallback: the garbage-collection window bounds how
 * far back the cluster can read, so when the snapshot is out of reach we fall
 * back to the bitemporal columns and say which source we used. Silently
 * degrading here would make the diff a guess wearing a fact's clothing.
 */
export async function diffForIntent(intentId) {
  const { rows: ir } = await query(
    `SELECT i.read_hlc, i.statement,
            ir.resource_id, ir.observed_version,
            r.kind, r.ext_key, r.version AS current_version, r.body AS current_body
     FROM intent i
     JOIN intent_read ir ON ir.intent_id = i.id
     JOIN resource r ON r.id = ir.resource_id
     WHERE i.id = $1`,
    [intentId],
  );

  if (ir.length === 0) return { source: "none", changes: [] };

  const hlc = ir[0].read_hlc;
  const changes = [];
  let source = "as_of_system_time";

  for (const row of ir) {
    let past = null;
    try {
      const { rows: p } = await query(
        `SELECT body, version FROM resource AS OF SYSTEM TIME ${hlc} WHERE id = $1`,
        [row.resource_id],
      );
      past = p[0] ?? null;
    } catch {
      // Snapshot older than the GC window — fall back and be explicit about it.
      source = "bitemporal_fallback";
    }

    const changed = past
      ? past.version !== row.current_version
      : row.observed_version !== row.current_version;

    if (changed) {
      changes.push({
        resourceId: row.resource_id,
        kind: row.kind,
        key: row.ext_key,
        thenVersion: past?.version ?? row.observed_version,
        nowVersion: row.current_version,
        thenBody: past?.body ?? null,
        nowBody: row.current_body,
      });
    }
  }

  return { source, hlc, changes };
}

/* ========================================================================== */
/* STEP 4 — ADJUDICATE                                                        */
/* ========================================================================== */

/**
 * Should the adjudicator be allowed to investigate before ruling?
 *
 * Off by default: it costs a second model call plus an MCP round trip, and most
 * conflicts are decidable from the diff alone. On when the ruling is worth more
 * than the lookup — which is the same economics the whole project is about.
 */
const INVESTIGATION_ENABLED = process.env.ADJUDICATOR_INVESTIGATE === "1";

const ADJUDICATOR_SYSTEM = `You arbitrate conflicts between concurrent AI agents sharing state.

An agent declared a plan against a snapshot. While it was thinking, another agent committed a change. Decide whether that change actually invalidates the plan.

Return ONLY a JSON object:
{
  "verdict": "irrelevant" | "invalidating" | "fatal",
  "rationale": "<one sentence, plain language>",
  "affected_steps": [<0-based step indices that depended on what changed>]
}

Rules:
- "irrelevant": the change does not affect this plan. Most conflicts are irrelevant — overlapping rows are not the same as overlapping meaning. affected_steps must be [].
- "invalidating": some steps assumed something that is no longer true. List ONLY those steps. Steps that would produce the same result regardless are NOT affected.
- "fatal": the plan's premise is gone entirely and no repair can rescue it.

Be conservative about "fatal" and precise about affected_steps. Every step you list is reasoning that has to be paid for again.`;

/**
 * Which of this intent's steps actually descend from the changed resource?
 *
 * Walks the provenance graph rather than asking a model. This is the cheap
 * exact answer, and it is available before any inference happens.
 */
const DEPENDENT_STEPS_SQL = `
WITH RECURSIVE
  c AS (SELECT resource_id FROM commit_log WHERE id = $2),
  descendants AS (
    SELECT pe.to_kind, pe.to_id
    FROM provenance_edge pe
    JOIN c ON pe.from_id = c.resource_id
    WHERE pe.from_kind = 'resource'
    UNION
    SELECT pe.to_kind, pe.to_id
    FROM provenance_edge pe
    JOIN descendants d ON pe.from_kind = d.to_kind AND pe.from_id = d.to_id
  )
SELECT DISTINCT ps.seq
FROM descendants d
JOIN plan_step ps ON d.to_kind = 'step' AND ps.id = d.to_id
WHERE ps.intent_id = $1
ORDER BY ps.seq
`;

export async function dependentSteps(intentId, commitId) {
  const { rows } = await query(DEPENDENT_STEPS_SQL, [intentId, commitId]);
  return rows.map((r) => r.seq);
}

export async function adjudicate({ commitId, intentId, usage, tier = null }) {
  /*
   * PRE-FILTER: settle it with the graph when the graph can settle it.
   *
   * If no step in this plan descends from the changed resource, the answer is
   * "irrelevant" and no amount of model reasoning will improve on that. The
   * first benchmark run spent most of its budget asking an expensive model to
   * confirm conclusions a recursive CTE had already reached.
   *
   * This is the division of labour the whole design is supposed to embody:
   * exact machinery where exactness is available, judgement only where
   * judgement is genuinely required.
   */
  const dependent = await dependentSteps(intentId, commitId);
  if (dependent.length === 0) {
    const { rows: n } = await query(
      `SELECT count(*)::INT8 AS c FROM plan_step WHERE intent_id = $1`,
      [intentId],
    );
    return {
      verdict: "irrelevant",
      rationale:
        "No plan step descends from the changed resource. Settled by the provenance graph, with no inference required.",
      affectedSteps: [],
      stepsTotal: Number(n[0].c),
      model: "provenance-graph",
      tokensIn: 0,
      tokensOut: 0,
      latencyMs: 0,
      diff: { source: "graph_prefilter", changes: [] },
    };
  }

  const { rows: ctx } = await query(
    `SELECT
       i.statement AS intent_statement,
       c.statement AS commit_statement,
       r.kind, r.ext_key, r.id AS resource_id, c.agent_id
     FROM intent i
     CROSS JOIN commit_log c
     JOIN resource r ON r.id = c.resource_id
     WHERE i.id = $1 AND c.id = $2`,
    [intentId, commitId],
  );
  if (ctx.length === 0) throw new Error("intent or commit not found");

  const { rows: allSteps } = await query(
    `SELECT count(*)::INT8 AS c FROM plan_step WHERE intent_id = $1`,
    [intentId],
  );
  const stepsTotal = Number(allSteps[0].c);

  // Only the graph-identified candidates go to the model. Everything else is
  // already known to be independent, so including it would spend prompt tokens
  // re-litigating a settled question.
  const { rows: steps } = await query(
    `SELECT seq, description, tokens_used FROM plan_step
     WHERE intent_id = $1 AND seq = ANY($2::INT4[]) ORDER BY seq`,
    [intentId, dependent],
  );

  const diff = await diffForIntent(intentId);

  const prompt = `AGENT'S PLAN
${ctx[0].intent_statement}

CANDIDATE STEPS
The provenance graph has already established that these ${steps.length} of the
plan's ${stepsTotal} steps read the resource that changed. The other
${stepsTotal - steps.length} are independent and are not in question.
Your job is narrower: of these candidates, which are ACTUALLY invalidated?
A step that would produce the same result regardless is not invalidated.

${steps.map((s) => `[${s.seq}] ${s.description}`).join("\n") || "(none)"}

WHAT ANOTHER AGENT JUST COMMITTED
${ctx[0].commit_statement}
(resource: ${ctx[0].kind}/${ctx[0].ext_key})

WHAT CHANGED SINCE THIS AGENT READ (${diff.source})
${
  diff.changes.length === 0
    ? "No tracked resource changed value."
    : diff.changes
        .map(
          (c) =>
            `- ${c.kind}/${c.key}: v${c.thenVersion} <-’ v${c.nowVersion}\n    then: ${JSON.stringify(c.thenBody)}\n    now:  ${JSON.stringify(c.nowBody)}`,
        )
        .join("\n")
}`;

  /*
   * Optional investigation round.
   *
   * The adjudicator is offered a small menu of read-only lookups over the
   * managed MCP server. If it says it needs one, we run it and put the answer
   * in front of it before asking for a verdict.
   *
   * A model that cannot look anything up has to guess when the diff is
   * ambiguous. One round is the budget — an adjudicator that can investigate
   * indefinitely costs more than the work it is protecting, which is precisely
   * the trap this project exists to avoid.
   */
  let evidence = "";
  if (INVESTIGATION_ENABLED) {
    const ask = await complete({
      tier: "bulk",
      system: `You are about to arbitrate a conflict. You may request ONE read-only lookup first, or none.

Available:
${INVESTIGATION_MENU}

Reply with ONLY JSON: {"investigate": "<name>"} or {"investigate": null}
Ask only if the answer would change your verdict.`,
      prompt,
      maxTokens: 60,
      json: true,
      usage,
    });

    const wanted = ask.data?.investigate;
    if (wanted) {
      const found = await investigate(wanted, {
        resourceId: ctx[0].resource_id,
        agentId: ctx[0].agent_id,
      });
      if (found?.rows?.length) {
        evidence =
          `\n\nEVIDENCE YOU REQUESTED (${found.name}, read-only via MCP)\n` +
          found.rows.map((r) => JSON.stringify(r)).join("\n");
      } else if (found?.error) {
        evidence = `\n\n(Requested ${found.name}; unavailable: ${found.error})`;
      }
    }
  }

  const res = await complete({
    // Precedence: what this caller asked for, then what this deployment is
    // configured for, then cheap. Cheap is the right default because the
    // provenance graph has already narrowed this to a short yes/no over a
    // candidate list — but "these conflicts are subtle and I will pay for a
    // better answer" is a legitimate thing for a caller to say, so the API
    // takes `adjudicator` per request.
    tier: tier || process.env.ADJUDICATOR_TIER || "bulk",
    system: ADJUDICATOR_SYSTEM,
    prompt: prompt + evidence,
    maxTokens: 500,
    json: true,
    usage,
  });

  const data = res.data ?? {
    verdict: "invalidating",
    rationale:
      "Adjudicator returned unparseable output; defaulting to invalidating so the conflict is not silently ignored.",
    affected_steps: steps.map((s) => s.seq),
  };

  const verdict = ["irrelevant", "invalidating", "fatal"].includes(data.verdict)
    ? data.verdict
    : "invalidating";

  const affected = Array.isArray(data.affected_steps)
    ? data.affected_steps.filter((n) => Number.isInteger(n))
    : [];

  return {
    verdict,
    rationale: String(data.rationale ?? "").slice(0, 500),
    affectedSteps: verdict === "irrelevant" ? [] : affected,
    stepsTotal,
    model: res.model,
    tokensIn: res.tokensIn,
    tokensOut: res.tokensOut,
    latencyMs: res.latencyMs,
    diff,
  };
}

/* ========================================================================== */
/* STEP 5 — RESOLVE                                                           */
/* ========================================================================== */

/**
 * Record the ruling and act on it.
 *
 * `steps_total` and `steps_repaired` are stored rather than derived at report
 * time, because the whole argument of the project is the ratio between them:
 * optimistic concurrency repairs everything, INTERLOCK repairs only what
 * actually depended on the change.
 */
export async function resolve({ commitId, intentId, adjudication, detectedBy, distance }) {
  const { result } = await serializableTx(
    async (client) => {
      // ON CONFLICT DO NOTHING makes this idempotent under retry. A connection
      // that dies after the insert but before the commit acknowledgement will
      // be retried; without this, that retry records a second verdict for the
      // same conflict. The unique index (004_exactly_once.sql) is what turns
      // "we try not to double-apply" into "we cannot".
      const { rows } = await client.query(
        `INSERT INTO adjudication
           (commit_id, intent_id, verdict, rationale, detected_by, similarity,
            model_id, tokens_in, tokens_out, latency_ms,
            steps_total, steps_repaired)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (commit_id, intent_id) DO NOTHING
         RETURNING id`,
        [
          commitId,
          intentId,
          adjudication.verdict,
          adjudication.rationale,
          detectedBy ?? "graph",
          distance ?? null,
          adjudication.model,
          adjudication.tokensIn,
          adjudication.tokensOut,
          adjudication.latencyMs,
          adjudication.stepsTotal,
          adjudication.affectedSteps.length,
        ],
      );
      // No row back means this conflict was already ruled on by an earlier
      // attempt that we did not see acknowledged. The prior ruling stands and
      // its side effects have already been applied, so this call becomes a
      // no-op rather than a second application.
      if (rows.length === 0) {
        const { rows: existing } = await client.query(
          `SELECT id, verdict::STRING AS verdict FROM adjudication
           WHERE commit_id = $1 AND intent_id = $2`,
          [commitId, intentId],
        );
        return {
          adjudicationId: existing[0]?.id ?? null,
          duplicate: true,
          verdict: existing[0]?.verdict ?? null,
        };
      }

      const adjudicationId = rows[0].id;

      if (adjudication.verdict === "irrelevant") {
        await client.query(
          `UPDATE intent SET status = 'open' WHERE id = $1 AND status = 'threatened'`,
          [intentId],
        );
      } else if (adjudication.verdict === "fatal") {
        await client.query(
          `UPDATE intent SET status = 'aborted', resolved_at = now(), valid_to = now()
           WHERE id = $1`,
          [intentId],
        );
      } else {
        await client.query(
          `UPDATE intent SET status = 'repairing' WHERE id = $1`,
          [intentId],
        );

        for (const seq of adjudication.affectedSteps) {
          const { rows: st } = await client.query(
            `UPDATE plan_step SET status = 'invalidated'
             WHERE intent_id = $1 AND seq = $2
             RETURNING id`,
            [intentId, seq],
          );
          if (st[0]) {
            await client.query(
              `INSERT INTO repair (adjudication_id, plan_step_id, action)
               VALUES ($1, $2, 'rerun')`,
              [adjudicationId, st[0].id],
            );
          }
        }
      }

      return { adjudicationId, duplicate: false };
    },
    { label: "resolve" },
  );

  return result;
}

/**
 * The whole pipeline for one commit: find who is threatened, rule on each, act.
 * Returns one record per threatened intent so the benchmark can count exactly
 * how much reasoning was preserved rather than discarded.
 */
export async function processCommit(commitId, { usage, tier = null } = {}) {
  const threatened = await findThreatened(commitId);
  const outcomes = [];

  for (const t of threatened) {
    await query(
      `UPDATE intent SET status = 'threatened' WHERE id = $1 AND status = 'open'`,
      [t.intent_id],
    );

    const adjudication = await adjudicate({
      commitId,
      intentId: t.intent_id,
      usage,
      tier,
    });

    const { adjudicationId } = await resolve({
      commitId,
      intentId: t.intent_id,
      adjudication,
      detectedBy: t.detected_by,
      distance: t.distance,
    });

    outcomes.push({
      adjudicationId,
      intentId: t.intent_id,
      agent: t.agent_name,
      detectedBy: t.detected_by,
      distance: t.distance,
      verdict: adjudication.verdict,
      rationale: adjudication.rationale,
      // Which model actually ruled. A caller who paid for a bigger tier should
      // be able to confirm they got it, and a conflict settled by the
      // provenance graph reports "provenance-graph" — no model, no charge.
      model: adjudication.model,
      stepsTotal: adjudication.stepsTotal,
      // Not just how many, but which. A caller that knows only the count has to
      // redo everything anyway, which is the outcome this whole mechanism
      // exists to avoid.
      affectedSteps: adjudication.affectedSteps,
      stepsRepaired: adjudication.affectedSteps.length,
      stepsPreserved: adjudication.stepsTotal - adjudication.affectedSteps.length,
    });
  }

  return outcomes;
}

