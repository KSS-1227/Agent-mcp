import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, PoolClient } from "pg";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../supabase/migrations");
const HISTORY_TABLE = "public.agent_safety_schema_migrations";
const MIGRATION_LOCK_ID = "548731902184";
const APP_TABLES = [
  "agents", "tasks", "resources", "intents", "intent_reads", "intent_steps",
  "conflicts", "actions", "action_evidence", "episodes", "managed_clusters",
  "test_external_effects", "auth_users", "action_resource_versions",
];

interface MigrationFile {
  filename: string;
  version: string;
  checksum: string;
  content: string;
}

function diagnosticErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`]+/gi, "[redacted connection string or URL]")
    .replace(/\b(password|passwd|token|api[_-]?key|secret)\s*[:=]\s*(?:'[^']*'|"[^"]*"|[^\s&,;]+)/gi, "$1=[redacted]")
    .replace(/\b(bearer)\s+[^\s,;]+/gi, "$1 [redacted]");
}

function postgresErrorDiagnostics(error: unknown): Record<string, string> {
  if (typeof error !== "object" || error === null) return {};
  const pgError = error as Record<string, unknown>;
  if (typeof pgError.code !== "string" || !/^[0-9A-Z]{5}$/.test(pgError.code)) return {};

  const diagnostics: Record<string, string> = { code: pgError.code };
  for (const field of ["position", "internalPosition"] as const) {
    const value = pgError[field];
    if ((typeof value === "string" && /^\d+$/.test(value)) || (typeof value === "number" && Number.isSafeInteger(value))) {
      diagnostics[field] = String(value);
    }
  }
  for (const field of ["detail", "hint", "where"] as const) {
    const value = pgError[field];
    if (typeof value === "string" && value.length > 0) diagnostics[field] = diagnosticErrorMessage(new Error(value));
  }
  return diagnostics;
}

async function loadMigrations(): Promise<MigrationFile[]> {
  const files = (await readdir(MIGRATIONS_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();

  if (!files.length || files.some((filename) => !/^\d{14}_.+\.sql$/.test(filename))) {
    throw new Error("Migration directory must contain timestamp-prefixed SQL files");
  }

  const migrations = await Promise.all(files.map(async (filename) => {
    const content = await readFile(resolve(MIGRATIONS_DIR, filename), "utf8");
    const version = filename.slice(0, 14);
    return {
      filename,
      version,
      checksum: createHash("sha256").update(content).digest("hex"),
      content,
    };
  }));
  if (new Set(migrations.map(({ version }) => version)).size !== migrations.length) {
    throw new Error("Migration versions must be unique");
  }
  return migrations;
}

async function hasUntrackedApplicationSchema(client: PoolClient): Promise<boolean> {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
     ) AS present`,
    [APP_TABLES]
  );
  return result.rows[0]?.present === true;
}

async function runMigrations(): Promise<void> {
  if (process.env.RUN_DATABASE_MIGRATIONS !== "1") {
    throw new Error("Set RUN_DATABASE_MIGRATIONS=1 to apply database migrations");
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL must be supplied in the process environment");

  const migrations = await loadMigrations();
  const pool = new Pool({ connectionString });
  let client: PoolClient | undefined;
  let lockHeld = false;
  try {
    client = await pool.connect();
    await client.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_ID]);
    lockHeld = true;

    const roles = await client.query(
      "SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])",
      [["anon", "service_role"]]
    );
    const availableRoles = new Set(roles.rows.map((row) => row.rolname));
    if (!availableRoles.has("anon") || !availableRoles.has("service_role")) {
      throw new Error("The SQL migrations require the Supabase anon and service_role roles");
    }

    const historyExists = await client.query(
      `SELECT to_regclass('${HISTORY_TABLE}') IS NOT NULL AS present`
    );
    let applied: Array<{ version: string; filename: string; checksum: string }> = [];
    if (historyExists.rows[0]?.present) {
      const history = await client.query(
        `SELECT version, filename, checksum FROM ${HISTORY_TABLE} ORDER BY version`
      );
      applied = history.rows;
    }
    if (applied.length === 0 && await hasUntrackedApplicationSchema(client)) {
      throw new Error("Existing application tables have no migration history; refusing to replay migrations");
    }
    if (!historyExists.rows[0]?.present) {
      await client.query(
        `CREATE TABLE ${HISTORY_TABLE} (
           version VARCHAR(14) PRIMARY KEY,
           filename VARCHAR(255) NOT NULL UNIQUE,
           checksum CHAR(64) NOT NULL,
           applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
         )`
      );
    }

    const migrationVersions = new Set(migrations.map(({ version }) => version));
    if (applied.some(({ version }) => !migrationVersions.has(version))) {
      throw new Error("Migration history contains versions missing from the repository");
    }
    const appliedByVersion = new Map(applied.map((migration) => [migration.version, migration]));
    for (const migration of migrations) {
      const previous = appliedByVersion.get(migration.version);
      if (previous) {
        if (previous.filename !== migration.filename || previous.checksum !== migration.checksum) {
          throw new Error(`Applied migration ${migration.version} differs from its recorded file`);
        }
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(migration.content);
        await client.query(
          `INSERT INTO ${HISTORY_TABLE} (version, filename, checksum) VALUES ($1, $2, $3)`,
          [migration.version, migration.filename, migration.checksum]
        );
        await client.query("COMMIT");
      } catch (error) {
        const diagnostics = postgresErrorDiagnostics(error);
        console.error(
          `Migration ${migration.filename} failed: ${diagnosticErrorMessage(error)}`,
          diagnostics
        );
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }
  } finally {
    if (lockHeld && client) {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_ID]).catch(() => undefined);
    }
    client?.release();
    await pool.end();
  }
}

runMigrations().catch((error: unknown) => {
  const message = diagnosticErrorMessage(error);
  console.error("Database migrations failed:", message, postgresErrorDiagnostics(error));
  process.exitCode = 1;
});
