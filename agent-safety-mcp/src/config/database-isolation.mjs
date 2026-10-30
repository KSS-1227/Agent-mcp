const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const TEST_DATABASE_NAME = /(^|[-_])(test|testing|ci)([-_]|$)/i;
const VERIFIED_TEST_DATABASE = Symbol.for("agent-safety-mcp.verified-test-database");

function parsePostgresUrl(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be configured to establish database identity`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid PostgreSQL URL`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`${name} must use postgres:// or postgresql://`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const user = decodeURIComponent(url.username);
  if (!host || !database || !user) {
    throw new Error(`${name} is missing host, database, or username identity`);
  }
  const projectRef = host.match(/^db\.([a-z0-9-]+)\.supabase\.co$/)?.[1]
    ?? user.match(/^postgres\.([a-z0-9-]+)$/)?.[1]
    ?? null;
  return {
    host,
    port: Number(url.port || 5432),
    database,
    user,
    projectRef,
    isLoopback: LOOPBACK_HOSTS.has(host),
    isSynthetic: host.endsWith(".invalid"),
  };
}

function supabaseProjectRef(value, name) {
  if (typeof value !== "string" || !value.trim()) return null;
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} is not a valid URL`); }
  if (url.protocol !== "https:") throw new Error(`${name} must use HTTPS`);
  const match = url.hostname.toLowerCase().match(/^([a-z0-9-]+)\.supabase\.co$/);
  if (!match) throw new Error(`${name} must identify a Supabase project URL`);
  return match[1];
}

function sameDatabaseTarget(left, right) {
  if (left.projectRef || right.projectRef) {
    return Boolean(left.projectRef && right.projectRef && left.projectRef === right.projectRef);
  }
  return left.host === right.host && left.port === right.port && left.database === right.database;
}

/** Proves that a live-test URL names a distinct, positively identified test target. */
export function assertIsolatedTestDatabaseConfig(env) {
  const test = parsePostgresUrl(env.TEST_DATABASE_URL, "TEST_DATABASE_URL");
  const production = env.DATABASE_URL
    ? parsePostgresUrl(env.DATABASE_URL, "DATABASE_URL")
    : null;
  if (production && sameDatabaseTarget(test, production)) {
    throw new Error("TEST_DATABASE_URL targets the production DATABASE_URL database");
  }

  const productionProject = supabaseProjectRef(env.SUPABASE_URL, "SUPABASE_URL")
    ?? production?.projectRef
    ?? null;

  if (test.projectRef) {
    const expectedTestProject = supabaseProjectRef(env.TEST_SUPABASE_URL, "TEST_SUPABASE_URL");
    if (test.projectRef !== expectedTestProject) {
      throw new Error("TEST_DATABASE_URL does not match TEST_SUPABASE_URL project identity");
    }
    if (!productionProject) {
      throw new Error("Production Supabase identity is required to verify the test project is isolated");
    }
    if (test.projectRef === productionProject) {
      throw new Error("TEST_DATABASE_URL points to the production Supabase project");
    }
    return { kind: "supabase", projectRef: test.projectRef, database: test.database };
  }

  if (test.isLoopback && TEST_DATABASE_NAME.test(test.database)) {
    if (production && !production.isLoopback) {
      throw new Error("A local test database cannot be verified as isolated from the configured remote production database");
    }
    return { kind: "local", host: test.host, port: test.port, database: test.database };
  }

  throw new Error("TEST_DATABASE_URL identity is unverifiable; use a distinct Supabase test project or a local test-named database");
}

/** Confirms the connected server reports the database named by the verified URL. */
export async function verifyConnectedTestDatabase(queryable, identity) {
  if (!identity || !identity.database) {
    throw new Error("Test database identity has not been verified");
  }
  const result = await queryable.query("SELECT current_database() AS database_name");
  if (result.rows?.[0]?.database_name !== identity.database) {
    throw new Error("Connected database name does not match the verified test database identity");
  }
  globalThis[VERIFIED_TEST_DATABASE] = identity;
}

/** Unit tests may use in-memory mocks; DB-backed test actions need a proven isolated target. */
export function isIsolatedTestActionEnvironment(env) {
  if (env.NODE_ENV !== "test") return false;
  if (!env.DATABASE_URL) return true;
  let target;
  try { target = parsePostgresUrl(env.DATABASE_URL, "DATABASE_URL"); }
  catch { return false; }
  if (target.isSynthetic && TEST_DATABASE_NAME.test(target.database)) return true;
  const verified = globalThis[VERIFIED_TEST_DATABASE];
  if (!verified) return false;
  if (verified.kind === "supabase") return target.projectRef === verified.projectRef;
  return target.isLoopback && target.host === verified.host
    && target.port === verified.port && target.database === verified.database;
}
