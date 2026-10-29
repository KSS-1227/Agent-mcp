/**
 * Push .env.local's database credentials to every deployed Lambda.
 *
 * WHY THIS EXISTS
 * Rotating the SQL password broke production silently. The password was
 * regenerated in the CockroachDB console and written to .env.local, so every
 * local script kept working — while the two deployed Lambdas carried the old
 * value and returned 500 on every request that touched the database.
 *
 * Nothing was obviously wrong: the site loaded, the health endpoint existed,
 * local tests passed. The failure was only visible to someone calling the
 * public API, which is to say a judge.
 *
 * Rotation is not a single-place edit; it fans out to every deployed consumer.
 * Making that fan-out a command means it cannot be half-applied by forgetting.
 *
 * Uses a JSON file rather than the CLI's Variables={...} shorthand, which
 * parses commas and equals signs inside values and quietly mangles a
 * connection string.
 *
 * Run: npm run sync:env
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { requireEnv } from "./env.js";

const ok = (s) => `\x1b[32mOK\x1b[0m    ${s}`;
const bad = (s) => `\x1b[31mFAIL\x1b[0m  ${s}`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const DATABASE_URL = requireEnv("DATABASE_URL");

/** Extra variables each function needs beyond the shared database URL. */
const FUNCTIONS = {
  "interlock-api": {
    DAILY_CALL_LIMIT: process.env.DAILY_CALL_LIMIT ?? "400",
    DAILY_USD_LIMIT: process.env.DAILY_USD_LIMIT ?? "3",
    PG_POOL_MAX: "3",
    EVENT_BUS_NAME: "interlock",
    CDC_SHARED_SECRET: process.env.CDC_SHARED_SECRET ?? "",
  },
  "interlock-worker": {
    PG_POOL_MAX: "3",
  },
};

const sh = (args) =>
  execFileSync("aws", args, { encoding: "utf8", shell: true }).trim();

const work = mkdtempSync(join(tmpdir(), "interlock-env-"));
let failures = 0;

for (const [fn, extra] of Object.entries(FUNCTIONS)) {
  const vars = { DATABASE_URL, ...extra };
  const path = join(work, `${fn}.json`);
  writeFileSync(path, JSON.stringify({ Variables: vars }), "utf8");

  try {
    sh([
      "lambda", "update-function-configuration",
      "--function-name", fn,
      "--environment", `file://${path}`,
      "--query", '"LastUpdateStatus"', "--output", "text",
    ]);
    sh(["lambda", "wait", "function-updated", "--function-name", fn]);
    console.log(ok(`${fn} updated (${Object.keys(vars).length} variables)`));
  } catch (e) {
    console.log(bad(`${fn}: ${e.message.split("\n")[0]}`));
    failures++;
  }
}

/* Prove it, rather than assume it. A config update that leaves the function
   unable to reach the database is the exact failure this script exists for. */
if (failures === 0) {
  const url = sh([
    "lambda", "get-function-url-config",
    "--function-name", "interlock-api",
    "--query", '"FunctionUrl"', "--output", "text",
  ]);

  const res = await fetch(`${url}v1/health`);
  const body = await res.json().catch(() => null);

  if (res.ok && body?.ok) {
    console.log(
      ok(`verified: /v1/health responds, ${body.topology.regions.length} regions`),
    );
  } else {
    console.log(bad(`health check failed after sync (HTTP ${res.status})`));
    console.log(dim(`      ${JSON.stringify(body)?.slice(0, 200)}`));
    failures++;
  }
}

process.exit(failures === 0 ? 0 : 1);
