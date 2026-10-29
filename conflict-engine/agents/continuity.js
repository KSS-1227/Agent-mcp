/**
 * The continuity agent.
 *
 * Everything else in this project reasons about *data*. This one reasons about
 * the *cluster*, because two of INTERLOCK's guarantees are properties of the
 * deployment rather than of the code, and shipping without checking them would
 * mean claiming resilience we had not verified:
 *
 *   1. TIME-TRAVEL REACH. Step 3 of the mechanism replays the snapshot an agent
 *      read using AS OF SYSTEM TIME. How far back that can reach is bounded by
 *      the garbage-collection window. If the window is shorter than an agent's
 *      thinking time, the diff silently degrades to the bitemporal fallback --
 *      so the agent measures the real reach rather than assuming it.
 *
 *   2. SURVIVABILITY. If the database is not actually configured to survive a
 *      region, the chaos drill is theatre. This refuses to let that pass
 *      quietly.
 *
 * It prefers the ccloud CLI when present and falls back to the CockroachDB
 * Cloud API, which is the same control plane the CLI wraps. Both are optional:
 * the SQL-derived checks work with nothing but DATABASE_URL, and the agent says
 * which source each answer came from rather than blurring them.
 *
 * Run: npm run continuity
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { query, closePool } from "./db.js";
import "../scripts/env.js";

const run = promisify(execFile);

const ok = (s) => `\x1b[32mOK\x1b[0m    ${s}`;
const warn = (s) => `\x1b[33mWARN\x1b[0m  ${s}`;
const bad = (s) => `\x1b[31mFAIL\x1b[0m  ${s}`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const b = (s) => `\x1b[1m${s}\x1b[0m`;

/* ------------------------------------------------------------ control plane */

async function ccloudAvailable() {
  try {
    await run("ccloud", ["version"], { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Cluster facts from the control plane, via CLI or API.
 * Returns { source, data } or { source: "unavailable", reason }.
 */
export async function clusterInfo() {
  const clusterId = process.env.CRDB_CLUSTER_ID;
  const apiKey = process.env.CCLOUD_API_KEY;

  if (await ccloudAvailable()) {
    try {
      const { stdout } = await run(
        "ccloud",
        ["cluster", "get", clusterId, "--output", "json"],
        { timeout: 20000 },
      );
      return { source: "ccloud CLI", data: JSON.parse(stdout) };
    } catch (e) {
      return { source: "unavailable", reason: `ccloud: ${e.message.split("\n")[0]}` };
    }
  }

  if (!apiKey || !clusterId) {
    return { source: "unavailable", reason: "CCLOUD_API_KEY or CRDB_CLUSTER_ID not set" };
  }

  const res = await fetch(
    `https://cockroachlabs.cloud/api/v1/clusters/${clusterId}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );

  if (res.status === 403 || res.status === 401) {
    return {
      source: "unavailable",
      reason:
        "403 from the Cloud API. The service account exists but holds no role on this cluster.\n" +
        "        Fix: Governance -> Service accounts -> interlock-agent -> assign a role\n" +
        "        scoped to the interlock cluster (Cluster Admin), then re-run.",
    };
  }
  if (!res.ok) {
    return { source: "unavailable", reason: `Cloud API ${res.status}` };
  }

  return { source: "CockroachDB Cloud API", data: await res.json() };
}

/* ------------------------------------------------------------- SQL-derived */

/** How far back AS OF SYSTEM TIME can actually read, measured against a real table. */
export async function timeTravelReach() {
  const probes = ["10s", "1m", "10m", "1h", "4h", "12h", "24h"];
  let reach = null;
  for (const p of probes) {
    try {
      await query(`SELECT count(*) FROM resource AS OF SYSTEM TIME '-${p}'`);
      reach = p;
    } catch {
      break;
    }
  }
  return reach;
}

/**
 * The garbage-collection window, per table.
 *
 * This is the number that actually bounds `AS OF SYSTEM TIME`, and reading it
 * turns "how far back can we reach?" from a probe that walks backwards until
 * something breaks into a fact the cluster will simply tell you.
 *
 * Worth knowing: the default here is 4500s — 75 minutes — which is why the
 * reach probe kept reporting about an hour. We had been loosely attributing
 * that to table age.
 */
export async function gcWindows() {
  const tables = ["intent", "commit_log", "adjudication", "resource"];
  const out = [];
  for (const t of tables) {
    try {
      const { rows } = await query(`SHOW ZONE CONFIGURATION FROM TABLE ${t}`);
      const raw = rows[0]?.raw_config_sql ?? Object.values(rows[0] ?? {}).join(" ");
      const m = /gc\.ttlseconds\s*=\s*(\d+)/.exec(raw);
      out.push({ table: t, seconds: m ? Number(m[1]) : null });
    } catch {
      out.push({ table: t, seconds: null });
    }
  }
  return out;
}

const humanise = (s) =>
  s == null ? "unknown" : s >= 86400 ? `${(s / 86400).toFixed(0)}d` : s >= 3600 ? `${(s / 3600).toFixed(1)}h` : `${s}s`;

export async function survivability() {
  const { rows: regions } = await query(`SHOW REGIONS FROM DATABASE interlock`);
  const { rows: db } = await query(
    `SELECT survival_goal FROM [SHOW DATABASES] WHERE database_name = 'interlock'`,
  );
  return {
    regions: regions.map((r) => r.region),
    primary: regions.find((r) => r.primary)?.region ?? null,
    survivalGoal: db[0]?.survival_goal ?? null,
  };
}

/**
 * Preflight, called before any adjudication cascade.
 * Returns { safe, findings } so a caller can refuse to proceed.
 */
export async function preflight() {
  const findings = [];
  const surv = await survivability();

  if (surv.regions.length < 3) {
    findings.push({
      level: "fail",
      msg: `${surv.regions.length} region(s): SURVIVE REGION FAILURE needs at least 3`,
    });
  }
  if (surv.survivalGoal !== "region") {
    findings.push({
      level: "fail",
      msg: `survival goal is "${surv.survivalGoal}", not "region"`,
    });
  }

  const reach = await timeTravelReach();
  if (!reach) {
    findings.push({ level: "warn", msg: "no historical reach — step 3 will use the bitemporal fallback" });
  }

  return {
    safe: !findings.some((f) => f.level === "fail"),
    survivability: surv,
    reach,
    findings,
  };
}

/* -------------------------------------------------------------------- main */

const isMain = process.argv[1]?.endsWith("continuity.js");
if (isMain) {
  console.log(b("\nContinuity agent\n"));

  const info = await clusterInfo();
  if (info.source === "unavailable") {
    console.log(warn(`control plane: ${info.reason}`));
  } else {
    const d = info.data;
    console.log(ok(`control plane via ${info.source}`));
    console.log(
      dim(
        `        ${d.name ?? "?"} | ${d.state ?? "?"} | plan ${d.plan ?? "?"} | ` +
          `regions: ${(d.regions ?? []).map((r) => r.name).join(", ") || "?"}`,
      ),
    );
  }

  const pre = await preflight();

  console.log(
    pre.survivability.regions.length >= 3
      ? ok(`${pre.survivability.regions.length} regions: ${pre.survivability.regions.join(", ")}`)
      : bad(`${pre.survivability.regions.length} region(s)`),
  );
  console.log(
    pre.survivability.survivalGoal === "region"
      ? ok(`survival goal: ${pre.survivability.survivalGoal}`)
      : bad(`survival goal: ${pre.survivability.survivalGoal}`),
  );
  console.log(
    pre.reach
      ? ok(`time-travel reach: ${pre.reach} on a real table`)
      : warn("time-travel reach: none"),
  );

  const gc = await gcWindows();
  console.log(dim("        gc.ttlseconds — the ceiling on how far back a diff can read:"));
  for (const g of gc) {
    console.log(dim(`          ${g.table.padEnd(14)} ${humanise(g.seconds)}`));
  }

  for (const f of pre.findings) {
    console.log(f.level === "fail" ? bad(f.msg) : warn(f.msg));
  }

  console.log(
    pre.safe
      ? b("\n  Preflight passed — adjudication cascades may proceed.\n")
      : b("\n  Preflight FAILED — resilience is not configured as claimed.\n"),
  );

  await closePool();
  process.exit(pre.safe ? 0 : 1);
}
