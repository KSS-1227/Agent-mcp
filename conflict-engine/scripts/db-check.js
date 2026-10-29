/**
 * Connectivity and capability probe.
 *
 * Answers the questions that decide whether the project is buildable at all:
 *   1. Can we connect over TLS?
 *   2. Is the version >= 25.2? (below that there is no C-SPANN vector index)
 *   3. Are vector columns and vector indexes actually usable on this cluster?
 *   4. Which regions does the cluster have, and what is the survival goal?
 *   5. How far back can AS OF SYSTEM TIME reach right now?
 *
 * Run: npm run db:check
 */
import { requireEnv } from "./env.js";
import pg from "pg";

const { Client } = pg;

const ok = (s) => `\x1b[32m✓\x1b[0m ${s}`;
const bad = (s) => `\x1b[31m✗\x1b[0m ${s}`;
const warn = (s) => `\x1b[33m!\x1b[0m ${s}`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const DATABASE_URL = requireEnv(
  "DATABASE_URL",
  "Get it from CockroachDB Cloud → Connect → General connection string.",
);

const client = new Client({
  connectionString: DATABASE_URL,
  // CockroachDB Cloud uses a public CA; verify-full is set in the URL and the
  // system trust store carries the root, so no custom CA wiring is needed.
  application_name: "interlock-db-check",
});

/** Parse "CockroachDB CCL v25.4.2 (...)" → { major: 25, minor: 4 } */
function parseVersion(v) {
  const m = /v(\d+)\.(\d+)/.exec(v);
  return m ? { major: +m[1], minor: +m[2], raw: v } : null;
}

async function main() {
  console.log(dim("connecting…"));
  await client.connect();

  /* 1 — version -------------------------------------------------------- */
  const { rows: vr } = await client.query("SELECT version() AS v");
  const parsed = parseVersion(vr[0].v);
  console.log(`\n${ok("connected")}`);
  console.log(`  ${vr[0].v}`);

  if (!parsed) {
    console.log(warn("could not parse version string"));
  } else {
    const meets =
      parsed.major > 25 || (parsed.major === 25 && parsed.minor >= 2);
    console.log(
      meets
        ? ok(`version v${parsed.major}.${parsed.minor} meets the v25.2+ requirement`)
        : bad(
            `version v${parsed.major}.${parsed.minor} is BELOW v25.2 — no C-SPANN vector index. This blocks the project.`,
          ),
    );
  }

  /* 2 — vector support ------------------------------------------------- */
  console.log("\n" + dim("probing vector support…"));
  try {
    await client.query("DROP TABLE IF EXISTS _interlock_probe");
    await client.query(
      "CREATE TABLE _interlock_probe (id INT PRIMARY KEY, embedding VECTOR(3))",
    );
    await client.query(
      "INSERT INTO _interlock_probe VALUES (1, '[1,2,3]'), (2, '[4,5,6]')",
    );
    console.log(ok("VECTOR column type works"));

    const { rows: nn } = await client.query(
      "SELECT id, embedding <-> '[1,2,3]' AS dist FROM _interlock_probe ORDER BY dist LIMIT 1",
    );
    console.log(ok(`distance operator works (nearest id=${nn[0].id})`));

    try {
      await client.query(
        "CREATE VECTOR INDEX _interlock_probe_idx ON _interlock_probe (embedding)",
      );
      console.log(ok("CREATE VECTOR INDEX works — C-SPANN available"));
    } catch (e) {
      console.log(bad(`vector index failed: ${e.message}`));
    }
  } catch (e) {
    console.log(bad(`vector support unavailable: ${e.message}`));
  } finally {
    await client.query("DROP TABLE IF EXISTS _interlock_probe");
  }

  /* 3 — regions and survival ------------------------------------------- */
  console.log("\n" + dim("inspecting regions…"));
  try {
    const { rows: regions } = await client.query("SHOW REGIONS FROM DATABASE");
    if (regions.length === 0) {
      console.log(warn("database is not multi-region yet"));
    } else {
      for (const r of regions) {
        console.log(
          `  ${r.region}${r.primary ? " (primary)" : ""} — zones: ${r.zones ?? "n/a"}`,
        );
      }
    }
  } catch (e) {
    console.log(warn(`SHOW REGIONS FROM DATABASE: ${e.message}`));
  }

  try {
    const { rows: cluster } = await client.query("SHOW REGIONS FROM CLUSTER");
    console.log(dim(`  cluster regions: ${cluster.map((r) => r.region).join(", ")}`));
  } catch {
    /* not always permitted on serverless */
  }

  /* 4 — time-travel window --------------------------------------------- */
  console.log("\n" + dim("checking AS OF SYSTEM TIME reach…"));
  for (const interval of ["-10s", "-1h", "-4h", "-24h"]) {
    try {
      await client.query(
        `SELECT 1 FROM (VALUES (1)) v AS OF SYSTEM TIME '${interval}'`,
      );
      console.log(ok(`AS OF SYSTEM TIME '${interval}' works`));
    } catch (e) {
      console.log(
        dim(`  AS OF SYSTEM TIME '${interval}' → ${e.message.split("\n")[0]}`),
      );
      break;
    }
  }

  /* 5 — isolation ------------------------------------------------------- */
  const { rows: iso } = await client.query("SHOW default_transaction_isolation");
  console.log(
    `\n${ok(`default isolation: ${iso[0].default_transaction_isolation}`)}`,
  );

  await client.end();
  console.log("\n" + dim("done."));
}

main().catch(async (e) => {
  console.error(bad(`failed: ${e.message}`));
  try {
    await client.end();
  } catch {
    /* already closed */
  }
  process.exit(1);
});
