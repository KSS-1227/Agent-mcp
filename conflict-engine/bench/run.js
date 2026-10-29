/**
 * The benchmark.
 *
 * Four concurrency-control strategies, one workload, one ledger:
 *
 *   serial      one agent at a time. The 1.00x reference.
 *   2pl         hold a row lock for the whole task, inference included.
 *   occ         detect the conflict at commit and discard the entire task.
 *   interlock   adjudicate semantically, repair only the dependent steps.
 *
 * WHAT IS MEASURED
 *   wall clock      relative to serial (>1.00x means parallelism helped)
 *   tokens          relative to serial (1.00x means no overhead)
 *   wasted tokens   reasoning paid for and then thrown away
 *   anomalies       lost updates, by arithmetic (see workload.js)
 *   retries         serialization failures the database made us handle
 *
 * WHY SERIAL IS THE REFERENCE
 * Because the finding that motivates this project is that optimistic
 * concurrency runs *slower than not parallelising at all*. That is only
 * meaningful if "not parallelising at all" is measured on the same hardware,
 * the same day, against the same workload.
 *
 * Usage:
 *   npm run bench                       all modes, defaults
 *   npm run bench -- --agents 12 --resources 3
 *   npm run bench -- --modes serial,interlock
 */
import { query, serializableTx, closePool } from "../agents/db.js";
import { Usage } from "../agents/bedrock.js";
import { declareIntent, processCommit } from "../agents/interlock.js";
import {
  RESOURCE_KIND,
  think,
  seedResources,
  clearIntents,
  checkAnomalies,
  assignments,
} from "./workload.js";

/* ------------------------------------------------------------------ config */

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const AGENTS = Number(arg("agents", 8));
const RESOURCES = Number(arg("resources", 2));
const MODES = String(arg("modes", "serial,2pl,occ,interlock")).split(",");
const STEPS = Number(arg("steps", 6));
const THINK_TOKENS = Number(arg("think-tokens", 200));
const PASSES = Number(arg("passes", 1));

const b = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

/* ------------------------------------------------------------- bench setup */

async function ensureAgents(n) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const name = `bench-agent-${i}`;
    const { rows } = await query(`SELECT id FROM agent WHERE name = $1`, [name]);
    if (rows[0]) {
      ids.push(rows[0].id);
    } else {
      const { rows: ins } = await query(
        `INSERT INTO agent (name, role, home_region)
         VALUES ($1, 'bench', 'aws-us-east-1') RETURNING id`,
        [name],
      );
      ids.push(ins[0].id);
    }
  }
  return ids;
}

async function startRun(mode) {
  const { rows } = await query(
    `INSERT INTO bench_run (mode, workload, agent_count)
     VALUES ($1, $2, $3) RETURNING id`,
    [mode, `contended-${RESOURCES}r`, AGENTS],
  );
  return rows[0].id;
}

async function event(runId, kind, extra = {}) {
  await query(
    `INSERT INTO bench_event (run_id, kind, tokens_in, tokens_out, wasted_tokens, detail)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      runId,
      kind,
      extra.tokensIn ?? 0,
      extra.tokensOut ?? 0,
      extra.wasted ?? 0,
      JSON.stringify(extra.detail ?? {}),
    ],
  );
}

/* --------------------------------------------------------------- the modes */

/**
 * SERIAL — the reference. No concurrency, so no conflicts are possible and no
 * work is ever discarded. Everything else is measured against this.
 */
async function runSerial(ctx) {
  const { plan, usage, runId } = ctx;
  let commits = 0;

  for (const a of plan) {
    const { rows } = await query(
      `SELECT version, (body->>'counter')::INT8 AS counter FROM resource WHERE id = $1`,
      [a.resource.id],
    );
    const { counter, version } = { counter: Number(rows[0].counter), version: rows[0].version };

    await think({
      resourceKey: a.resource.ext_key,
      counter,
      agentName: a.name,
      usage,
      stepCount: STEPS,
        thinkTokens: THINK_TOKENS,
        passes: PASSES,
    });

    await query(
      `UPDATE resource SET body = jsonb_set(body, '{counter}', to_jsonb($2::INT8)),
                           version = $3, updated_at = now()
       WHERE id = $1`,
      [a.resource.id, counter + 1, version + 1],
    );
    commits++;
    await event(runId, "commit");
  }

  return { commits, aborts: 0, deadlocks: 0, retries: 0, repairs: 0 };
}

/**
 * 2PL — hold the row lock across the whole task, inference included.
 *
 * This is the honest version of "just use a lock". SELECT ... FOR UPDATE is
 * taken before thinking and held until commit, so every other agent on that row
 * waits out a full inference. Correct, and almost perfectly serialising.
 */
async function run2PL(ctx) {
  const { plan, usage, runId } = ctx;
  let commits = 0,
    deadlocks = 0;

  const results = await Promise.allSettled(
    plan.map(async (a) => {
      try {
        const { result } = await serializableTx(
          async (client) => {
            const { rows } = await client.query(
              `SELECT version, (body->>'counter')::INT8 AS counter
               FROM resource WHERE id = $1 FOR UPDATE`,
              [a.resource.id],
            );
            const counter = Number(rows[0].counter);
            const version = rows[0].version;

            // The lock is held for the entire duration of this call.
            await think({
              resourceKey: a.resource.ext_key,
              counter,
              agentName: a.name,
              usage,
              stepCount: STEPS,
        thinkTokens: THINK_TOKENS,
        passes: PASSES,
            });

            await client.query(
              `UPDATE resource SET body = jsonb_set(body,'{counter}',to_jsonb($2::INT8)),
                                   version = $3, updated_at = now()
               WHERE id = $1`,
              [a.resource.id, counter + 1, version + 1],
            );
            return true;
          },
          { label: "2pl", maxAttempts: 8 },
        );
        return result;
      } catch (e) {
        if (/deadlock/i.test(e.message)) deadlocks++;
        throw e;
      }
    }),
  );

  for (const r of results) {
    if (r.status === "fulfilled") {
      commits++;
      await event(runId, "commit");
    } else {
      await event(runId, "abort", { detail: { reason: String(r.reason).slice(0, 200) } });
    }
  }

  return { commits, aborts: results.length - commits, deadlocks, retries: 0, repairs: 0 };
}

/**
 * OCC — the approach almost everything ships today.
 *
 * Read, think, then check the version at commit time. If it moved, the entire
 * task is discarded — every token spent reasoning is thrown away — and the
 * agent starts again from scratch. This is where the 1.83x comes from.
 */
async function runOCC(ctx) {
  const { plan, usage, runId } = ctx;
  let commits = 0,
    aborts = 0,
    wastedTotal = 0;

  await Promise.all(
    plan.map(async (a) => {
      for (let attempt = 1; attempt <= 4; attempt++) {
        const { rows } = await query(
          `SELECT version, (body->>'counter')::INT8 AS counter FROM resource WHERE id = $1`,
          [a.resource.id],
        );
        const counter = Number(rows[0].counter);
        const version = rows[0].version;

        const thought = await think({
          resourceKey: a.resource.ext_key,
          counter,
          agentName: a.name,
          usage,
          stepCount: STEPS,
        thinkTokens: THINK_TOKENS,
        passes: PASSES,
        });

        const { result } = await serializableTx(
          async (client) => {
            const { rows: cur } = await client.query(
              `SELECT version FROM resource WHERE id = $1`,
              [a.resource.id],
            );
            if (cur[0].version !== version) return { ok: false };

            await client.query(
              `UPDATE resource SET body = jsonb_set(body,'{counter}',to_jsonb($2::INT8)),
                                   version = $3, updated_at = now()
               WHERE id = $1`,
              [a.resource.id, counter + 1, version + 1],
            );
            return { ok: true };
          },
          { label: "occ" },
        );

        if (result.ok) {
          commits++;
          await event(runId, "commit", { detail: { attempt } });
          return;
        }

        // The defining behaviour of OCC: discard ALL of it.
        aborts++;
        wastedTotal += thought.tokens;
        usage.waste(thought.tokens);
        await event(runId, "abort", { wasted: thought.tokens, detail: { attempt } });
      }
    }),
  );

  return { commits, aborts, deadlocks: 0, retries: 0, repairs: 0, wasted: wastedTotal };
}

/**
 * INTERLOCK — declare the intent, adjudicate the conflict, repair only what
 * actually depended on what changed.
 */
async function runInterlock(ctx) {
  const { plan, usage, runId, agentIds } = ctx;
  let commits = 0,
    repairs = 0,
    preserved = 0,
    wastedTotal = 0;

  await Promise.all(
    plan.map(async (a) => {
      const agentId = agentIds[a.agentIndex];

      const { rows } = await query(
        `SELECT version, (body->>'counter')::INT8 AS counter FROM resource WHERE id = $1`,
        [a.resource.id],
      );
      const counter = Number(rows[0].counter);
      const version = rows[0].version;

      const thought = await think({
        resourceKey: a.resource.ext_key,
        counter,
        agentName: a.name,
        usage,
        stepCount: STEPS,
        thinkTokens: THINK_TOKENS,
        passes: PASSES,
      });
      const perStep = Math.round(thought.tokens / Math.max(thought.steps.length, 1));

      await declareIntent({
        agentId,
        taskId: crypto.randomUUID(),
        statement: `Admit one work item to queue ${a.resource.ext_key}, which showed depth ${counter}, and rebalance it.`,
        reads: [{ resourceId: a.resource.id, observedVersion: version }],
        // Only depth-sensitive steps get a provenance edge to the contended
        // resource. Wiring every step to it would make the blast radius the
        // whole plan by construction, which is precisely the mistake the first
        // version of this benchmark made.
        steps: thought.steps.map((s) => ({
          description: s.description,
          dependsOn: s.dependsOnCounter ? [a.resource.id] : [],
          tokensUsed: perStep,
        })),
        usage,
      });

      // Commit with a retrying read-modify-write. The database enforces
      // correctness; adjudication decides how much reasoning survives.
      const { result } = await serializableTx(
        async (client) => {
          const { rows: cur } = await client.query(
            `SELECT version, (body->>'counter')::INT8 AS counter
             FROM resource WHERE id = $1 FOR UPDATE`,
            [a.resource.id],
          );
          const c = Number(cur[0].counter);
          const v = cur[0].version;

          await client.query(
            `UPDATE resource SET body = jsonb_set(body,'{counter}',to_jsonb($2::INT8)),
                                 version = $3, updated_at = now()
             WHERE id = $1`,
            [a.resource.id, c + 1, v + 1],
          );

          const { rows: hlc } = await client.query(
            `SELECT cluster_logical_timestamp() AS h`,
          );
          const { rows: cl } = await client.query(
            `INSERT INTO commit_log
               (agent_id, resource_id, prev_version, new_version, statement, commit_hlc)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [
              agentId,
              a.resource.id,
              v,
              v + 1,
              `Admitted one work item to ${a.resource.ext_key}; depth ${c} to ${c + 1}.`,
              hlc[0].h,
            ],
          );
          return { commitId: cl[0].id, stale: v !== version };
        },
        { label: "interlock-commit" },
      );

      commits++;
      await event(runId, "commit");

      // Only adjudicate when the world actually moved under someone.
      if (result.stale) {
        const outcomes = await processCommit(result.commitId, { usage });
        for (const o of outcomes) {
          if (o.verdict === "invalidating") {
            repairs += o.stepsRepaired;
            preserved += o.stepsPreserved;
            const reSpent = o.stepsRepaired * perStep;
            wastedTotal += reSpent;
            usage.waste(reSpent);
            await event(runId, "repair", {
              wasted: reSpent,
              detail: {
                repaired: o.stepsRepaired,
                preserved: o.stepsPreserved,
                detectedBy: o.detectedBy,
              },
            });
          }
        }
      }
    }),
  );

  return {
    commits,
    aborts: 0,
    deadlocks: 0,
    retries: 0,
    repairs,
    preserved,
    wasted: wastedTotal,
  };
}

const RUNNERS = {
  serial: runSerial,
  "2pl": run2PL,
  occ: runOCC,
  interlock: runInterlock,
};

/* -------------------------------------------------------------------- main */

async function main() {
  console.log(
    b(`\nINTERLOCK benchmark`) +
      dim(`  ${AGENTS} agents, ${RESOURCES} contended resources\n`),
  );

  const agentIds = await ensureAgents(AGENTS);
  const results = [];

  for (const mode of MODES) {
    const runner = RUNNERS[mode];
    if (!runner) {
      console.log(red(`unknown mode: ${mode}`));
      continue;
    }

    const resources = await seedResources(RESOURCES);
    await clearIntents();

    const plan = assignments(AGENTS, resources);
    const usage = new Usage(mode);
    const runId = await startRun(mode);

    process.stdout.write(`  ${mode.padEnd(10)} runningâ€¦ `);
    const t0 = Date.now();
    let stats;
    try {
      stats = await runner({ plan, usage, runId, agentIds });
    } catch (e) {
      console.log(red(`failed: ${e.message}`));
      continue;
    }
    const wallMs = Date.now() - t0;

    const anomalies = await checkAnomalies(stats.commits);
    await query(`UPDATE bench_run SET finished_at = now() WHERE id = $1`, [runId]);

    const u = usage.toJSON();
    results.push({ mode, wallMs, ...stats, anomalies, usage: u });
    console.log(
      `${(wallMs / 1000).toFixed(1)}s  ${u.tokensTotal} tokens  ` +
        (anomalies.lost > 0 ? red(`${anomalies.lost} lost updates`) : green("0 anomalies")),
    );
  }

  report(results);

  if (process.env.BENCH_JSON === "1") {
    console.log(
      "BENCH_RESULT " +
        JSON.stringify({
          agents: AGENTS,
          resources: RESOURCES,
          steps: STEPS,
          thinkTokens: THINK_TOKENS,
        passes: PASSES,
          modes: results.map((r) => ({
            mode: r.mode,
            wallMs: r.wallMs,
            usd: r.usage.usd,
            completionTokens: r.usage.completionTokens,
            embedTokens: r.usage.embedTokens,
            wasted: r.usage.tokensWasted,
            anomalies: r.anomalies.lost,
            repairs: r.repairs ?? 0,
            preserved: r.preserved ?? 0,
          })),
        }),
    );
  }

  await closePool();
}

function report(results) {
  const base = results.find((r) => r.mode === "serial");

  console.log(b("\n\nResults") + dim("  relative to serial execution\n"));
  console.log(
    dim(
      "  mode        speedup   cost     wasted   anomalies  aborts  repaired/preserved",
    ),
  );
  console.log(dim("  " + "-".repeat(78)));

  for (const r of results) {
    const speedup = base ? base.wallMs / r.wallMs : 1;
    // COST, not raw tokens. Embeddings bill at $0.02/1M and the adjudicator at
    // $3/1M, so a token total makes an embedding-heavy design look ~150x worse
    // than it costs. Dollars are the comparison that survives scrutiny.
    const costRatio = base && base.usage.usd ? r.usage.usd / base.usage.usd : 1;
    const anomalyCell =
      r.anomalies.lost > 0
        ? red(String(r.anomalies.lost).padEnd(10))
        : green("0".padEnd(10));

    console.log(
      `  ${r.mode.padEnd(11)} ` +
        `${speedup.toFixed(2)}x`.padEnd(10) +
        `${costRatio.toFixed(2)}x`.padEnd(9) +
        `${r.usage.tokensWasted}`.padEnd(9) +
        anomalyCell +
        `${r.aborts}`.padEnd(8) +
        (r.repairs != null ? `${r.repairs}/${r.preserved ?? 0}` : "-"),
    );
  }

  console.log(dim("\n  Token split (embedding tokens are ~150x cheaper per token):"));
  for (const r of results) {
    console.log(
      dim(
        `    ${r.mode.padEnd(11)} completion ${String(r.usage.completionTokens).padEnd(7)} ` +
          `embedding ${String(r.usage.embedTokens).padEnd(7)} ` +
          `$${r.usage.usd.toFixed(5)}`,
      ),
    );
  }

  console.log(dim("\n  Energy (estimate, same coefficient applied to every mode):"));
  for (const r of results) {
    console.log(
      dim(
        `    ${r.mode.padEnd(11)} ${r.usage.energy.wh.toFixed(3)} Wh · ` +
          `${r.usage.energy.gCO2e.toFixed(3)} gCO2e · ` +
          `${r.usage.energy.whWasted.toFixed(3)} Wh wasted`,
      ),
    );
  }

  const occ = results.find((r) => r.mode === "occ");
  const il = results.find((r) => r.mode === "interlock");
  if (occ && il && base?.usage.usd) {
    const occCost = occ.usage.usd / base.usage.usd;
    const ilCost = il.usage.usd / base.usage.usd;
    const delta = ((occCost - ilCost) / occCost) * 100;

    console.log(
      b("\n  Headline: ") +
        `optimistic concurrency ${yellow(`${occCost.toFixed(2)}x`)} cost, ` +
        `INTERLOCK ${(delta > 0 ? green : red)(`${ilCost.toFixed(2)}x`)} - ` +
        (delta > 0
          ? green(`${delta.toFixed(0)}% cheaper`)
          : red(`${Math.abs(delta).toFixed(0)}% MORE expensive`)) +
        ` at ${STEPS} steps/task.`,
    );

    if (delta <= 0) {
      console.log(
        dim(
          "\n  INTERLOCK loses at this task size, and that is a real result rather\n" +
            "  than a bug. Adjudication is a fixed cost per conflict; the saving scales\n" +
            "  with how much reasoning a task stands to lose. Short tasks are cheap to\n" +
            "  simply redo, so there is nothing worth protecting. Find the crossover:\n" +
            "    npm run bench:sweep",
        ),
      );
    }
  }

  console.log(
    dim(
      "\n  Every row above was produced by this harness on the live cluster.\n" +
        "  Re-run it yourself: npm run bench\n",
    ),
  );
}

main().catch(async (e) => {
  console.error(red(`\nbenchmark failed: ${e.message}`));
  console.error(dim(e.stack?.split("\n").slice(1, 5).join("\n") ?? ""));
  await closePool();
  process.exit(1);
});

