/**
 * Migration runner.
 *
 * Applies db/migrations/*.sql in filename order, once each, tracked in a
 * `schema_migrations` table. Statements run individually rather than wrapped in
 * one transaction, because several of the multi-region ALTERs cannot run inside
 * an explicit transaction.
 *
 *   npm run db:migrate          apply pending migrations
 *   npm run db:migrate -- --dry show what would run, touch nothing
 *   npm run db:reset            drop the interlock database, then re-apply
 *
 * Idempotency: a small set of "already done" errors is tolerated so the
 * multi-region file can be re-run safely (ADD REGION on a region that is
 * already present is an error, not a no-op).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { PROJECT_ROOT, requireEnv } from "./env.js";

const { Client } = pg;

const ok = (s) => `\x1b[32m✓\x1b[0m ${s}`;
const bad = (s) => `\x1b[31m✗\x1b[0m ${s}`;
const skip = (s) => `\x1b[2m·\x1b[0m \x1b[2m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const DRY = process.argv.includes("--dry");
const RESET = process.argv.includes("--reset");
const MIGRATIONS_DIR = join(PROJECT_ROOT, "db", "migrations");

/** Errors that mean "this was already true", which is success for us. */
const TOLERATED = [
  /already exists/i,
  /already a region/i,
  /region .* has already been added/i,
  /is already the primary region/i,
  /duplicate .* region/i,
  /no change/i,
];

const isTolerated = (msg) => TOLERATED.some((re) => re.test(msg));

/**
 * Split a SQL file into statements.
 * Line comments are stripped first so a `--` containing a semicolon cannot
 * split a statement in half. Dollar-quoting is not used anywhere in this
 * project's SQL, so a semicolon split is safe here.
 */
function splitStatements(sql) {
  const withoutComments = sql
    .split("\n")
    .map((line) => {
      const i = line.indexOf("--");
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n");

  return withoutComments
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** First ~70 chars of a statement, whitespace collapsed, for logging. */
const preview = (stmt) => {
  const flat = stmt.replace(/\s+/g, " ");
  return flat.length > 70 ? `${flat.slice(0, 70)}…` : flat;
};

async function main() {
  const connectionString = requireEnv("DATABASE_URL");
  const client = new Client({
    connectionString,
    application_name: "interlock-migrate",
  });
  await client.connect();

  if (RESET) {
    if (DRY) {
      console.log(dim("--dry: would DROP DATABASE interlock CASCADE"));
    } else {
      console.log(dim("dropping database interlock…"));
      await client.query("DROP DATABASE IF EXISTS interlock CASCADE");
      console.log(ok("dropped"));
    }
  }

  // The ledger lives outside the interlock database so that `--reset` does not
  // destroy the record of what has run.
  await client.query(`
    CREATE TABLE IF NOT EXISTS defaultdb.public.schema_migrations (
      filename   STRING PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      statements INT4 NOT NULL DEFAULT 0
    )
  `);

  if (RESET && !DRY) {
    await client.query("DELETE FROM defaultdb.public.schema_migrations");
  }

  const { rows: applied } = await client.query(
    "SELECT filename FROM defaultdb.public.schema_migrations",
  );
  const done = new Set(applied.map((r) => r.filename));

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    console.log(bad(`no .sql files in ${MIGRATIONS_DIR}`));
    process.exit(1);
  }

  let appliedCount = 0;

  for (const file of files) {
    if (done.has(file)) {
      console.log(skip(`${file} (already applied)`));
      continue;
    }

    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const statements = splitStatements(sql);

    // Every migration selects the database itself, because on a fresh cluster
    // 001 has to create it first. That convention held until a file was written
    // without the line and ran against `defaultdb` instead — where it failed
    // with "relation does not exist", which reads like a broken migration
    // rather than a misaddressed one.
    //
    // A convention that fails this confusingly should be checked, not trusted.
    if (!/^\s*SET\s+database\s*=/im.test(sql)) {
      console.log(bad(`  ${file} does not select a database`));
      console.log(
        `    Add "SET database = interlock;" near the top. Without it the file\n` +
          `    runs against defaultdb and every table reference fails.`,
      );
      await client.end();
      process.exit(1);
    }
    console.log(`\n${dim("→")} ${file} ${dim(`(${statements.length} statements)`)}`);

    if (DRY) {
      statements.forEach((s) => console.log(skip(`  ${preview(s)}`)));
      continue;
    }

    let executed = 0;
    for (const stmt of statements) {
      try {
        await client.query(stmt);
        executed++;
        console.log(ok(`  ${preview(stmt)}`));
      } catch (e) {
        if (isTolerated(e.message)) {
          console.log(skip(`  ${preview(stmt)} → ${e.message.split("\n")[0]}`));
          executed++;
        } else {
          console.log(bad(`  ${preview(stmt)}`));
          console.log(`    ${e.message.split("\n")[0]}`);
          await client.end();
          process.exit(1);
        }
      }
    }

    await client.query(
      "INSERT INTO defaultdb.public.schema_migrations (filename, statements) VALUES ($1, $2)",
      [file, executed],
    );
    appliedCount++;
  }

  console.log(
    `\n${ok(DRY ? "dry run complete" : `${appliedCount} migration(s) applied`)}`,
  );

  await client.end();
}

main().catch((e) => {
  console.error(bad(e.message));
  process.exit(1);
});
