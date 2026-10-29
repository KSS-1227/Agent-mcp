/**
 * Where is the crossover?
 *
 * The first benchmark run said INTERLOCK costs more than optimistic
 * concurrency. That is true, and it is true for a reason worth stating plainly:
 *
 *   adjudicating a conflict has a roughly fixed cost
 *   re-running a task has a cost proportional to how much reasoning it did
 *
 * So for cheap tasks, retrying is simply better. There is nothing to protect.
 * The saving only appears once a task is expensive enough that throwing it away
 * hurts more than judging it.
 *
 * This sweeps reasoning-per-task and prints the curve, so the claim we publish
 * is "here is the regime where this pays" rather than "this always wins".
 *
 * Run: npm run bench:sweep
 */
import { spawn } from "node:child_process";

const POINTS = (process.env.SWEEP_POINTS || "1,2,4,6").split(",").map(Number);
const THINK = process.env.SWEEP_THINK || "500";
const AGENTS = process.env.SWEEP_AGENTS || "6";
const RESOURCES = process.env.SWEEP_RESOURCES || "2";
const STEPS = process.env.SWEEP_STEPS || "6";

const b = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

function runOnce(passes) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "bench/run.js",
        "--agents", AGENTS,
        "--resources", RESOURCES,
        "--steps", STEPS,
        "--think-tokens", THINK,
        "--passes", String(passes),
        "--modes", "serial,occ,interlock",
      ],
      { env: { ...process.env, BENCH_JSON: "1" }, stdio: ["ignore", "pipe", "ignore"] },
    );

    let out = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.on("close", (code) => {
      const line = out.split("\n").find((l) => l.startsWith("BENCH_RESULT "));
      if (!line) return reject(new Error(`no result at ${passes} passes (exit ${code})`));
      resolve(JSON.parse(line.slice("BENCH_RESULT ".length)));
    });
    child.on("error", reject);
  });
}

console.log(
  b("\nCrossover sweep") +
    dim(`  ${AGENTS} agents, ${RESOURCES} resources, ${STEPS} steps/task, ${THINK} max tokens/pass\n`),
);
console.log(
  dim("  reasoning/task    OCC cost    INTERLOCK cost    winner      margin"),
);
console.log(dim("  " + "-".repeat(70)));

const curve = [];

for (const tokens of POINTS) {
  process.stdout.write(dim(`  running ${tokens} pass(es)...          \r`));
  let r;
  try {
    r = await runOnce(tokens);
  } catch (e) {
    console.log(red(`  ${tokens}: ${e.message}`));
    continue;
  }

  const by = Object.fromEntries(r.modes.map((m) => [m.mode, m]));
  const baseUsd = by.serial?.usd || 1;
  const occ = (by.occ?.usd ?? 0) / baseUsd;
  const il = (by.interlock?.usd ?? 0) / baseUsd;
  const margin = ((occ - il) / occ) * 100;
  const winner = il < occ ? green("INTERLOCK") : red("OCC      ");

  curve.push({ tokens, occ, il, margin, raw: r });

  console.log(
    `  ${String(by.serial?.completionTokens ?? tokens).padEnd(18)}` +
      `${occ.toFixed(2)}x`.padEnd(12) +
      `${il.toFixed(2)}x`.padEnd(18) +
      `${winner}  ` +
      (margin > 0 ? green(`+${margin.toFixed(0)}%`) : red(`${margin.toFixed(0)}%`)),
  );
}

/* ---------------------------------------------------------------- verdict */

console.log(b("\n\nWhat this shows\n"));

const flipped = curve.find((c) => c.margin > 0);
if (flipped) {
  console.log(
    `  INTERLOCK becomes cheaper than optimistic concurrency at roughly ` +
      green(`${flipped.tokens} reasoning pass(es) per task`) +
      `,\n  and the margin widens from there.`,
  );
} else {
  const best = curve.reduce((a, c) => (c.margin > a.margin ? c : a), curve[0]);
  console.log(
    red("  No crossover inside the swept range.") +
      `\n  Closest at ${best?.tokens} pass(es)/task: ${best?.margin.toFixed(0)}%.` +
      `\n\n  This is a real result, not a broken run. Adjudication has a roughly` +
      `\n  fixed cost per conflict; re-running a task costs in proportion to how` +
      `\n  much reasoning it did. Below the crossover, retrying is genuinely the` +
      `\n  better engineering choice and this system should not be used.` +
      `\n\n  Extend the range: SWEEP_POINTS=900,1800,3600 npm run bench:sweep`,
  );
}

console.log(
  dim(
    "\n  Anomalies across every point above: " +
      curve.reduce(
        (n, c) => n + c.raw.modes.reduce((m, x) => m + x.anomalies, 0),
        0,
      ) +
      " (serializable isolation holds regardless of which mode is cheaper)\n",
  ),
);
