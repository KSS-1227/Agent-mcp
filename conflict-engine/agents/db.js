/**
 * Database access for the INTERLOCK runtime.
 *
 * Two things here are deliberate rather than incidental:
 *
 * 1. `serializableTx` retries on 40001. CockroachDB runs SERIALIZABLE by
 *    default, which means the database will refuse an interleaving it cannot
 *    order — and it signals that by aborting one of the transactions. Retrying
 *    is not a workaround; it is how you cash in the guarantee. A system that
 *    claims lost updates are impossible has to actually handle the abort that
 *    makes them impossible.
 *
 * 2. Every connection sets `application_name`, so a slow query in the
 *    CockroachDB console can be traced back to the component that issued it.
 */
import pg from "pg";
import { requireEnv } from "../scripts/env.js";

const { Pool, types } = pg;

/** 40001 = serialization failure. The retryable one. */
const SERIALIZATION_FAILURE = "40001";

/**
 * Parse INT8 as a JS number instead of a string.
 *
 * node-postgres returns INT8 (OID 20) as a string by default, because INT8 can
 * exceed Number.MAX_SAFE_INTEGER. That default is correct in general and wrong
 * for us: `version + 1` on the string "1" yields "11", not 2 — silently, with
 * no error, producing a version number that looks plausible.
 *
 * We hit exactly that bug on the first end-to-end run. Every INT8 in this
 * schema is a version counter or a token count, all far below 2^53, so parsing
 * to Number is safe here. The guard keeps it honest if that ever stops
 * being true.
 */
types.setTypeParser(20, (value) => {
  const n = Number(value);
  if (Number.isSafeInteger(n)) return n;

  // Beyond 2^53 we return a BigInt rather than throwing.
  //
  // The first version threw, on the reasoning that every INT8 in our schema is
  // a small counter. That was true of our schema and false of CockroachDB's:
  // SHOW CHANGEFEED JOBS returns job IDs around 1.2e18, and the guard turned a
  // working query into a crash.
  //
  // BigInt keeps the loud-failure property that made throwing attractive —
  // mixing a BigInt with a Number in arithmetic is a TypeError — while moving
  // the failure to the point of actual misuse instead of the point of reading.
  return BigInt(value);
});

let pool;

export function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: requireEnv("DATABASE_URL"),
      application_name: "interlock-runtime",
      max: Number(process.env.PG_POOL_MAX ?? 20),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
    });
    pool.on("error", (e) => {
      console.error("[db] idle client error:", e.message);
    });
  }
  return pool;
}

/** Run a query against the interlock database. */
export async function query(text, params = []) {
  const client = await getPool().connect();
  try {
    await client.query("SET database = interlock");
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

/**
 * Run `fn` inside a SERIALIZABLE transaction, retrying on serialization
 * failures with exponential backoff and jitter.
 *
 * Returns { result, attempts, retried } so callers — especially the benchmark —
 * can record how much contention actually occurred rather than guessing.
 */
export async function serializableTx(fn, { maxAttempts = 5, label = "tx" } = {}) {
  const client = await getPool().connect();
  try {
    await client.query("SET database = interlock");

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return { result, attempts: attempt, retried: attempt > 1 };
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});

        if (e.code !== SERIALIZATION_FAILURE || attempt === maxAttempts) {
          throw e;
        }

        // Full jitter: without it, two conflicting agents retry in lockstep and
        // collide again on exactly the same schedule.
        const backoff = Math.random() * Math.min(2 ** attempt * 25, 400);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }

    throw new Error(`${label}: exhausted ${maxAttempts} attempts`);
  } finally {
    client.release();
  }
}

/**
 * The cluster's logical timestamp right now.
 *
 * Stored on every intent as `read_hlc`. This single DECIMAL is what makes the
 * "Diff" step possible later: `AS OF SYSTEM TIME <hlc>` replays the exact
 * snapshot the agent formed its plan against.
 */
export async function clusterHlc(client) {
  const runner = client ?? { query: (t) => query(t) };
  const { rows } = await runner.query("SELECT cluster_logical_timestamp() AS hlc");
  return rows[0].hlc;
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
