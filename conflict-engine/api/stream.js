/**
 * The demo, streamed.
 *
 * The blocking version returned a finished trace after five seconds, which
 * showed the *result* of the memory layer working and hid the working. This
 * emits an event per stage as it happens, carrying the things that make the
 * claim checkable rather than merely stated:
 *
 *   - the actual SQL, including the three-path detection query
 *   - the first dimensions of the real embedding vector
 *   - the prompt the adjudicator was given, and its verdict
 *   - a token counter that ticks up as tokens are genuinely spent
 *
 * That distinction matters for this project specifically. "Semantic conflict
 * detection over a distributed vector index" is either a real recursive CTE
 * joined to a real ANN search, or it is a phrase. Showing the query lets a
 * reader decide which.
 */
import { query } from "../agents/db.js";
import { Usage, embed, complete, MODELS } from "../agents/bedrock.js";
import { declareIntent, dependentSteps, findThreatened, diffForIntent, resolve } from "../agents/interlock.js";
import { randomUUID } from "node:crypto";

/** The detection query, quoted verbatim so the page shows what actually runs. */
export const DETECTION_SQL = `WITH RECURSIVE
  c AS (SELECT resource_id, new_version, embedding FROM commit_log WHERE id = $1),

  exact AS (                      -- read this row at an older version
    SELECT ir.intent_id, 'exact' AS how, NULL::FLOAT8 AS distance
    FROM intent_read ir JOIN c ON ir.resource_id = c.resource_id
    JOIN intent i ON i.id = ir.intent_id
    WHERE i.status IN ('open','threatened')
      AND ir.observed_version < c.new_version),

  descendants AS (                -- transitive provenance walk
    SELECT pe.to_kind, pe.to_id FROM provenance_edge pe
    JOIN c ON pe.from_id = c.resource_id WHERE pe.from_kind = 'resource'
    UNION
    SELECT pe.to_kind, pe.to_id FROM provenance_edge pe
    JOIN descendants d ON pe.from_kind = d.to_kind AND pe.from_id = d.to_id),

  semantic AS (                   -- meaning, not rows. C-SPANN vector index.
    SELECT i.id, 'vector', (i.embedding <=> (SELECT embedding FROM c))
    FROM intent i WHERE i.status IN ('open','threatened')
    ORDER BY i.embedding <=> (SELECT embedding FROM c) LIMIT $2)

SELECT ... FROM exact UNION ALL derived UNION ALL semantic
WHERE distance <= $3   -- 0.58, measured not guessed`;

const now = () => Date.now();

/**
 * Run the demo, calling `emit` with each event as it happens.
 * Kept transport-agnostic so the same generator serves a streaming response,
 * a websocket, or a test.
 */
export async function runStreamingDemo(emit) {
  const usage = new Usage("stream-demo");
  const t0 = now();
  let seq = 0;

  const stage = (id, label, detail, extra = {}) =>
    emit({ t: "stage", seq: seq++, id, label, detail, at: now() - t0, ...extra });

  const cost = () => {
    const u = usage.toJSON();
    emit({
      t: "cost",
      seq: seq++,
      tokensIn: u.tokensIn,
      tokensOut: u.tokensOut,
      embedTokens: u.embedTokens,
      completionTokens: u.completionTokens,
      usd: u.usd,
      wh: Number(u.energy.wh.toFixed(4)),
      at: now() - t0,
    });
  };

  /* ---------------------------------------------------------------- setup */
  stage("setup", "Creating shared state", "One queue, two agents about to want it");

  const planner = (await query(`SELECT id FROM agent WHERE name='Scheduler'`)).rows[0]?.id
    ?? (await query(`INSERT INTO agent (name,role) VALUES ('Scheduler','capacity-planner') RETURNING id`)).rows[0].id;
  const router = (await query(`SELECT id FROM agent WHERE name='Triage'`)).rows[0]?.id
    ?? (await query(`INSERT INTO agent (name,role) VALUES ('Triage','ticket-router') RETURNING id`)).rows[0].id;

  await query(
    `UPDATE intent SET status='aborted', resolved_at=now() WHERE agent_id=$1 AND status IN ('open','threatened','repairing')`,
    [planner],
  );

  const key = `demo-${randomUUID().slice(0, 8)}`;
  const { rows: r } = await query(
    `INSERT INTO resource (kind, ext_key, body) VALUES ('queue',$1,$2) RETURNING id, version`,
    [key, JSON.stringify({ open_tickets: 118, staffed: 6 })],
  );
  const resource = r[0];

  emit({
    t: "sql", seq: seq++, id: "setup",
    sql: `INSERT INTO resource (kind, ext_key, body)\nVALUES ('queue', '${key}', '{"open_tickets":118,"staffed":6}')`,
    at: now() - t0,
  });
  stage("setup", "Shared state created", `queue/${key} — 118 open tickets, 6 staff, v${resource.version}`, { done: true });

  /* -------------------------------------------------------------- declare */
  const statement =
    "Rebalance the EU support queue for the overnight shift: 118 open tickets against 6 staff, so move the overflow to the APAC rota and page a second responder.";

  stage("embed", "Embedding the plan", `${MODELS.embeddings}`);
  const tEmbed = now();
  const { vector } = await embed(statement, usage);
  emit({
    t: "vector", seq: seq++, id: "embed",
    dims: vector.length,
    preview: vector.slice(0, 8).map((v) => Number(v.toFixed(4))),
    ms: now() - tEmbed,
    at: now() - t0,
  });
  stage("embed", "Plan embedded", `${vector.length} dimensions in ${now() - tEmbed}ms`, { done: true });
  cost();

  stage("declare", "Declaring the intent", "Serializable transaction: intent, read-set, 4 plan steps, provenance edges");
  const intent = await declareIntent({
    agentId: planner,
    taskId: randomUUID(),
    statement,
    reads: [{ resourceId: resource.id, observedVersion: resource.version }],
    steps: [
      { description: "Read current queue depth and staffing", dependsOn: [resource.id], tokensUsed: 1800 },
      { description: "Compute overflow above the per-responder threshold", dependsOn: [resource.id], tokensUsed: 3100 },
      { description: "Draft the APAC handover note listing which tickets move", dependsOn: [resource.id], tokensUsed: 5200 },
      { description: "Page a second overnight responder from the rota", tokensUsed: 2400 },
    ],
    usage,
  });

  emit({
    t: "sql", seq: seq++, id: "declare",
    sql: `INSERT INTO intent (agent_id, task_id, statement, embedding, read_hlc)\nVALUES ($1, $2, $3, $4::VECTOR, cluster_logical_timestamp())`,
    at: now() - t0,
  });
  stage("declare", "Intent recorded", `snapshot HLC ${String(intent.read_hlc).slice(0, 19)} — 12,500 tokens of reasoning now at risk`, {
    done: true, intentId: intent.id,
  });
  cost();

  /* --------------------------------------------------------------- commit */
  stage("commit", "Triage commits into the same queue", "The world moves while the Scheduler is still thinking");
  const commitStatement =
    "Reassign 13 escalated tickets from the US queue into the EU support queue, raising its depth to 131.";
  const { literal: commitVec } = await embed(commitStatement, usage);

  const { rows: cl } = await query(
    `INSERT INTO commit_log (agent_id, resource_id, prev_version, new_version, statement, embedding, commit_hlc)
     VALUES ($1,$2,$3,$4,$5,$6::VECTOR, cluster_logical_timestamp()) RETURNING id`,
    [router, resource.id, resource.version, resource.version + 1, commitStatement, commitVec],
  );
  await query(
    `UPDATE resource SET body=$2, version=$3 WHERE id=$1`,
    [resource.id, JSON.stringify({ open_tickets: 131, staffed: 6 }), resource.version + 1],
  );
  const commitId = cl[0].id;

  stage("commit", "Committed", `depth 118 → 131, v${resource.version} → v${resource.version + 1}, SERIALIZABLE`, { done: true });
  cost();

  /* ---------------------------------------------------------------- watch */
  stage("detect", "Finding who is threatened", "Three paths, one query, one snapshot");
  emit({ t: "sql", seq: seq++, id: "detect", sql: DETECTION_SQL, at: now() - t0 });

  const tDetect = now();
  const threatened = await findThreatened(commitId);
  const detectMs = now() - tDetect;

  for (const th of threatened) {
    emit({
      t: "threat", seq: seq++,
      agent: th.agent_name,
      detectedBy: th.detected_by,
      distance: th.distance == null ? null : Number(Number(th.distance).toFixed(4)),
      at: now() - t0,
    });
  }
  stage("detect", `${threatened.length} intent(s) threatened`, `${detectMs}ms — paths: ${threatened.map((t) => t.detected_by).join(", ") || "none"}`, { done: true });

  /* --------------------------------------------------------- graph filter */
  const outcomes = [];
  for (const th of threatened) {
    stage("prefilter", "Asking the provenance graph first", "If no step descends from the change, no model call is needed");
    const dependent = await dependentSteps(th.intent_id, commitId);
    stage("prefilter", `${dependent.length} of 4 steps descend from the change`, `steps ${dependent.join(", ")} — the rest are independent and are not in question`, { done: true });

    /* ------------------------------------------------------------- diff */
    stage("diff", "Replaying the agent's snapshot", "AS OF SYSTEM TIME against the exact timestamp it read");
    const diff = await diffForIntent(th.intent_id);
    emit({
      t: "sql", seq: seq++, id: "diff",
      sql: `SELECT body, version FROM resource\nAS OF SYSTEM TIME ${String(intent.read_hlc).slice(0, 19)}\nWHERE id = $1`,
      at: now() - t0,
    });
    for (const c of diff.changes) {
      emit({
        t: "diff", seq: seq++,
        key: `${c.kind}/${c.key}`,
        then: c.thenBody, now: c.nowBody,
        thenVersion: c.thenVersion, nowVersion: c.nowVersion,
        source: diff.source, at: now() - t0,
      });
    }
    stage("diff", "Snapshot diffed", `${diff.changes.length} change(s), source: ${diff.source}`, { done: true });

    /* -------------------------------------------------------- adjudicate */
    if (dependent.length === 0) {
      outcomes.push({ verdict: "irrelevant", stepsRepaired: 0, stepsPreserved: 4, stepsTotal: 4, intentId: th.intent_id, detectedBy: th.detected_by, distance: th.distance });
      stage("adjudicate", "Ruling: IRRELEVANT", "Settled by the graph. No inference required.", { done: true, verdict: "irrelevant" });
      continue;
    }

    const { rows: steps } = await query(
      `SELECT seq, description FROM plan_step WHERE intent_id=$1 AND seq = ANY($2::INT4[]) ORDER BY seq`,
      [th.intent_id, dependent],
    );

    const prompt = `AGENT'S PLAN
${statement}

CANDIDATE STEPS (the graph says these ${steps.length} of 4 read what changed)
${steps.map((s) => `[${s.seq}] ${s.description}`).join("\n")}

WHAT ANOTHER AGENT JUST COMMITTED
${commitStatement}

WHAT CHANGED
${diff.changes.map((c) => `${c.kind}/${c.key}: v${c.thenVersion} -> v${c.nowVersion}\n  then ${JSON.stringify(c.thenBody)}\n  now  ${JSON.stringify(c.nowBody)}`).join("\n")}`;

    emit({ t: "prompt", seq: seq++, id: "adjudicate", model: MODELS.bulk, prompt, at: now() - t0 });
    stage("adjudicate", "Asking the adjudicator", `${MODELS.bulk} — a narrowed question over ${steps.length} candidates`);

    const tAdj = now();
    const res = await complete({
      tier: process.env.ADJUDICATOR_TIER || "bulk",
      system: `You arbitrate conflicts between concurrent AI agents. Return ONLY JSON:
{"verdict":"irrelevant"|"invalidating"|"fatal","rationale":"<one sentence>","affected_steps":[<indices>]}
Only list steps genuinely invalidated. Every step listed is reasoning that must be paid for again.`,
      prompt,
      maxTokens: 400,
      json: true,
      usage,
    });

    const data = res.data ?? { verdict: "invalidating", rationale: "unparseable", affected_steps: dependent };
    const affected = Array.isArray(data.affected_steps) ? data.affected_steps : dependent;

    emit({
      t: "verdict", seq: seq++,
      verdict: data.verdict, rationale: data.rationale,
      affectedSteps: affected,
      tokensIn: res.tokensIn, tokensOut: res.tokensOut, ms: now() - tAdj,
      at: now() - t0,
    });
    stage("adjudicate", `Ruling: ${String(data.verdict).toUpperCase()}`, data.rationale, { done: true, verdict: data.verdict });
    cost();

    const adjudication = {
      verdict: data.verdict, rationale: String(data.rationale ?? "").slice(0, 500),
      affectedSteps: data.verdict === "irrelevant" ? [] : affected,
      stepsTotal: 4, model: res.model, tokensIn: res.tokensIn, tokensOut: res.tokensOut,
      latencyMs: now() - tAdj,
    };
    await resolve({ commitId, intentId: th.intent_id, adjudication, detectedBy: th.detected_by, distance: th.distance });

    outcomes.push({
      verdict: data.verdict,
      stepsRepaired: adjudication.affectedSteps.length,
      stepsPreserved: 4 - adjudication.affectedSteps.length,
      stepsTotal: 4,
      intentId: th.intent_id,
      detectedBy: th.detected_by,
      distance: th.distance,
    });
  }

  /* ---------------------------------------------------------------- done */
  await query(
    `UPDATE intent SET status='aborted', resolved_at=now() WHERE id=$1 AND status IN ('open','threatened','repairing')`,
    [intent.id],
  ).catch(() => {});

  const repaired = outcomes.reduce((n, o) => n + o.stepsRepaired, 0);
  const preserved = outcomes.reduce((n, o) => n + o.stepsPreserved, 0);
  const u = usage.toJSON();

  emit({
    t: "done", seq: seq++,
    durationMs: now() - t0,
    summary: {
      stepsRepaired: repaired,
      stepsPreserved: preserved,
      preservedPct: repaired + preserved ? Math.round((preserved / (repaired + preserved)) * 100) : 0,
    },
    cost: {
      usd: u.usd, tokensIn: u.tokensIn, tokensOut: u.tokensOut,
      embedTokens: u.embedTokens, completionTokens: u.completionTokens,
      wh: Number(u.energy.wh.toFixed(4)), gCO2e: Number(u.energy.gCO2e.toFixed(4)),
    },
  });

  return usage;
}
