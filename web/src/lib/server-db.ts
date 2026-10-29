/**
 * Server-only read layer.
 *
 * Every query in this file targets the schema defined by
 * `agent-safety-mcp/supabase/migrations`. Column names are aliased back to the
 * dashboard's DTO vocabulary so the UI components stay unchanged, and no column
 * is invented here.
 *
 * Failures are returned as typed results (`DataResult`) so API routes can answer
 * with an honest status code plus a public-safe error code. Raw driver messages
 * never leave the server.
 */
import { Pool } from "pg";
import {
  Agent,
  Action,
  Episode,
  HealthEndpointProbe,
  Intent,
  OverviewMetrics,
  ProvenanceEdge,
  ProvenanceNode,
  Resource,
  SystemHealth,
} from "../types";

export type DataErrorCode =
  | "DATABASE_NOT_CONFIGURED"
  | "INVALID_CONNECTION_STRING"
  | "CONNECTION_REFUSED"
  | "HOST_NOT_FOUND"
  | "CONNECTION_TIMEOUT"
  | "AUTHENTICATION_FAILED"
  | "DATABASE_NOT_FOUND"
  | "SCHEMA_MISSING"
  | "SCHEMA_MISMATCH"
  | "QUERY_FAILED";

export interface DataError {
  code: DataErrorCode;
  message: string;
}

export type DataResult<T> = { ok: true; data: T } | ({ ok: false } & DataError);

/** Public-safe descriptions. They deliberately contain no host, user or credential detail. */
const DATA_ERROR_MESSAGES: Record<DataErrorCode, string> = {
  DATABASE_NOT_CONFIGURED:
    "DATABASE_URL is not configured for the dashboard server, so no live PostgreSQL reads are possible.",
  INVALID_CONNECTION_STRING:
    "DATABASE_URL is not a valid PostgreSQL connection string.",
  CONNECTION_REFUSED: "The PostgreSQL server refused the connection.",
  HOST_NOT_FOUND: "The configured PostgreSQL host could not be resolved.",
  CONNECTION_TIMEOUT: "The PostgreSQL connection attempt timed out.",
  AUTHENTICATION_FAILED: "PostgreSQL rejected the configured credentials.",
  DATABASE_NOT_FOUND: "The configured PostgreSQL database does not exist.",
  SCHEMA_MISSING:
    "A required table is missing. The agent-safety-mcp migrations may not have been applied to this database.",
  SCHEMA_MISMATCH:
    "A query referenced a column that does not exist. The database schema and this dashboard build are out of sync.",
  QUERY_FAILED: "The PostgreSQL query failed.",
};

function fail(code: DataErrorCode): DataResult<never> {
  return { ok: false, code, message: DATA_ERROR_MESSAGES[code] };
}

/** Maps a driver error onto a public-safe code. The raw message stays in server logs only. */
function classifyDbError(err: unknown): DataErrorCode {
  const code = String((err as { code?: unknown })?.code ?? "");
  const message = String((err as { message?: unknown })?.message ?? "");

  switch (code) {
    case "28P01":
    case "28000":
      return "AUTHENTICATION_FAILED";
    case "3D000":
      return "DATABASE_NOT_FOUND";
    case "42P01":
      return "SCHEMA_MISSING";
    case "42703":
      return "SCHEMA_MISMATCH";
    case "ECONNREFUSED":
      return "CONNECTION_REFUSED";
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "HOST_NOT_FOUND";
    case "ETIMEDOUT":
    case "CONNECT_TIMEOUT":
      return "CONNECTION_TIMEOUT";
    default:
      break;
  }

  if (/invalid url|invalid connection string/i.test(message)) {
    return "INVALID_CONNECTION_STRING";
  }
  return "QUERY_FAILED";
}

let pgPool: Pool | null = null;

export function isDatabaseConfigured(): boolean {
  const connStr = process.env.DATABASE_URL;
  return Boolean(
    connStr && (connStr.startsWith("postgresql://") || connStr.startsWith("postgres://"))
  );
}

/**
 * TLS is intentionally NOT overridden here. Node-postgres derives transport
 * security from the connection string (`sslmode=require` / `sslmode=verify-full`),
 * so certificate verification is never silently disabled by the dashboard.
 */
export function getDatabasePool(): Pool | null {
  if (!isDatabaseConfigured()) {
    return null;
  }

  if (!pgPool) {
    pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 4000,
      idleTimeoutMillis: 10000,
      max: 4,
    });
    pgPool.on("error", (err) => {
      console.error("[PostgreSQL Pool Error]", err.message);
    });
  }

  return pgPool;
}

async function runQuery<T>(
  label: string,
  fn: (pool: Pool) => Promise<T>
): Promise<DataResult<T>> {
  const pool = getDatabasePool();
  if (!pool) {
    return fail("DATABASE_NOT_CONFIGURED");
  }

  try {
    return { ok: true, data: await fn(pool) };
  } catch (err) {
    const code = classifyDbError(err);
    console.error(`[Live ${label} Error] ${(err as Error)?.message ?? "unknown"}`);
    return fail(code);
  }
}

/** Liveness answers from memory in milliseconds, so a short leash is fine. */
const HEALTH_LIVENESS_TIMEOUT_MS = 2500;

/**
 * Readiness is genuinely slow: the daemon opens a fresh connection to PostgreSQL
 * and performs a Supabase REST HEAD on every call, each budgeted at 5s inside the
 * daemon (`agent-safety-mcp/src/health/checks.ts`). Measured here at ~2.4-2.6s, so
 * a 2.5s client abort raced the daemon's own clock and reported a healthy daemon as
 * TIMEOUT. The budget must exceed the daemon's internal bound, not match it.
 */
const HEALTH_READINESS_TIMEOUT_MS = 8000;

/** Health bodies are tiny; the cap keeps a wrong service on the port from streaming forever. */
const HEALTH_MAX_BODY_BYTES = 4096;

function classifyFetchError(err: unknown): string {
  const name = (err as { name?: string })?.name;
  const code = String((err as { cause?: { code?: unknown } })?.cause?.code ?? "");
  const directCode = String((err as { code?: unknown })?.code ?? "");

  if (name === "AbortError" || name === "TimeoutError") return "TIMEOUT";
  if (code === "ECONNREFUSED" || directCode === "ECONNREFUSED") return "CONNECTION_REFUSED";
  if (code === "ENOTFOUND" || directCode === "ENOTFOUND") return "HOST_NOT_FOUND";
  return "UNREACHABLE";
}

/** Public-safe explanation of a probe code. Contains no origin, port or credential. */
function describeProbeFailure(code: string, endpoint: "live" | "ready", timeoutMs: number): string {
  if (code.startsWith("HTTP_")) {
    return `/health/${endpoint} answered HTTP ${code.slice(5)} instead of 200.`;
  }
  switch (code) {
    case "TIMEOUT":
      return `/health/${endpoint} accepted the connection but did not answer within ${timeoutMs} ms.`;
    case "CONNECTION_REFUSED":
      return "Nothing is listening on the configured health origin (connection refused).";
    case "HOST_NOT_FOUND":
      return "The configured health origin could not be resolved.";
    case "INVALID_RESPONSE":
      return `/health/${endpoint} answered, but the body did not report status "healthy".`;
    default:
      return `/health/${endpoint} failed before returning an HTTP response.`;
  }
}

/**
 * The daemon serves `/health/*` at the root of its own origin, so a path, query or
 * trailing slash in BACKEND_HEALTH_URL must never shift the probe onto
 * `/health/health/live`. Only the origin is kept.
 */
function resolveHealthBase(raw: string | undefined): URL | null {
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return new URL(parsed.origin);
}

/**
 * One bounded probe. A 2xx is not accepted as proof of health on its own: the body
 * must be JSON reporting `status: "healthy"`, otherwise the answer is INVALID_RESPONSE
 * (a different service may be squatting on the port).
 */
async function probeHealthEndpoint(
  endpoint: "live" | "ready",
  base: URL,
  timeoutMs: number
): Promise<HealthEndpointProbe> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const failure = (code: string, httpStatus?: number): HealthEndpointProbe => ({
    ok: false,
    httpStatus,
    latencyMs: Date.now() - startedAt,
    timeoutMs,
    errorCode: code,
    errorDetail: describeProbeFailure(code, endpoint, timeoutMs),
  });

  try {
    const response = await fetch(new URL(`health/${endpoint}`, base), {
      signal: controller.signal,
      cache: "no-store",
      redirect: "manual",
      headers: { accept: "application/json" },
    });

    if (!response.ok) return failure(`HTTP_${response.status}`, response.status);

    const raw = (await response.text()).slice(0, HEALTH_MAX_BODY_BYTES);
    let reported: unknown = null;
    try {
      reported = JSON.parse(raw);
    } catch {
      reported = null;
    }
    const reportedStatus = (reported as { status?: unknown } | null)?.status;
    if (reportedStatus !== "healthy") return failure("INVALID_RESPONSE", response.status);

    return { ok: true, httpStatus: response.status, latencyMs: Date.now() - startedAt, timeoutMs };
  } catch (err) {
    // An aborted signal is the only trustworthy timeout signal; undici also reports
    // connect failures as `TypeError: fetch failed` with a socket code on `cause`.
    return failure(controller.signal.aborted ? "TIMEOUT" : classifyFetchError(err));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probes only what this process can genuinely observe:
 *  - PostgreSQL reachability + latency (a real `SELECT 1`)
 *  - the MCP health daemon, using an explicitly configured BACKEND_HEALTH_URL
 *
 * Adjudicator/provider health is not exposed by the backend, so it is reported
 * as unverified rather than guessed from unrelated environment variables.
 */
export async function checkBackendHealth(): Promise<SystemHealth> {
  const dbConfigured = isDatabaseConfigured();
  let dbReachable = false;
  let dbLatencyMs: number | undefined;
  let dbErrorCode: string | undefined;

  const pool = getDatabasePool();
  if (pool) {
    const start = Date.now();
    try {
      const client = await pool.connect();
      try {
        await client.query("SELECT 1");
        dbLatencyMs = Date.now() - start;
        dbReachable = true;
      } finally {
        client.release();
      }
    } catch (err) {
      dbErrorCode = classifyDbError(err);
      console.error("[Health PostgreSQL Error]", (err as Error)?.message ?? "unknown");
    }
  } else {
    dbErrorCode = "DATABASE_NOT_CONFIGURED";
  }

  const rawHealthUrl = process.env.BACKEND_HEALTH_URL?.trim();
  const healthBase = resolveHealthBase(rawHealthUrl);
  const backendConfigured = Boolean(rawHealthUrl);

  let backendReachable = false;
  let backendLiveness = false;
  let backendReadiness = false;
  let backendErrorCode: string | undefined;
  let backendErrorDetail: string | undefined;
  let endpoints: SystemHealth["backend"]["endpoints"];
  let recovery: SystemHealth["backend"]["recovery"] = null;

  if (!rawHealthUrl) {
    // Not configured: nothing to probe and nothing to claim.
  } else if (!healthBase) {
    backendErrorCode = "INVALID_URL";
    backendErrorDetail =
      "BACKEND_HEALTH_URL is not an http(s) origin, so the health daemon cannot be probed.";
  } else {
    // Probed concurrently: readiness is the slow call, liveness is instant, so a
    // sequential probe would add the daemon's readiness latency to every page load.
    const [live, ready, recoveryResponse] = await Promise.all([
      probeHealthEndpoint("live", healthBase, HEALTH_LIVENESS_TIMEOUT_MS),
      probeHealthEndpoint("ready", healthBase, HEALTH_READINESS_TIMEOUT_MS),
      fetchRecoveryRuntime(healthBase),
    ]);
    recovery = recoveryResponse;

    endpoints = { live, ready };
    // Any HTTP answer proves something is listening; only a validated 2xx body
    // proves the daemon itself is live / ready.
    backendReachable = live.httpStatus !== undefined || ready.httpStatus !== undefined;
    backendLiveness = live.ok;
    backendReadiness = ready.ok;

    // Readiness decides the "Not Ready" badge, so its code takes precedence.
    const decisive = ready.ok ? live : ready;
    if (!decisive.ok) {
      backendErrorCode = decisive.errorCode;
      backendErrorDetail = decisive.errorDetail;
    }

    // Sanitized diagnostics: endpoint, code and latency only. No origin, host, port
    // or credential is ever logged.
    if (!live.ok) {
      console.warn(`[Health Daemon] /health/live ${live.errorCode} after ${live.latencyMs}ms`);
    }
    if (!ready.ok) {
      console.warn(`[Health Daemon] /health/ready ${ready.errorCode} after ${ready.latencyMs}ms`);
    }
  }

  let status: SystemHealth["status"];
  if (dbReachable && backendConfigured && backendReadiness) {
    status = "healthy";
  } else if (dbReachable || backendReachable) {
    // Something verified, something else missing or unverifiable.
    status = "unhealthy";
  } else if (!dbConfigured && !backendConfigured) {
    status = "disconnected";
  } else {
    status = "disconnected";
  }

  return {
    status,
    mode: "live",
    database: {
      configured: dbConfigured,
      reachable: dbReachable,
      latencyMs: dbLatencyMs,
      errorCode: dbErrorCode,
    },
    backend: {
      configured: backendConfigured,
      reachable: backendReachable,
      liveness: backendLiveness,
      readiness: backendReadiness,
      errorCode: backendErrorCode,
      errorDetail: backendErrorDetail,
      endpoints,
      recovery,
    },
    provider: {
      verified: false,
      note: "The Agent Safety MCP backend does not expose adjudicator/provider health to the web tier, so provider availability is not verified here.",
    },
    checkedAt: new Date().toISOString(),
  };
}

async function fetchRecoveryRuntime(base: URL): Promise<SystemHealth["backend"]["recovery"]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(new URL("health/recovery", base), { signal: controller.signal, cache: "no-store" });
    if (!response.ok) return null;
    const value = await response.json();
    const states = ["disabled", "starting", "running", "idle", "error"];
    if (!value || !states.includes(value.state) || typeof value.enabled !== "boolean" ||
      !Number.isInteger(value.productionVerifierCount) || value.productionVerifierCount < 0 ||
      typeof value.failure !== "boolean" ||
      typeof value.observedAt !== "string" || !Number.isFinite(Date.parse(value.observedAt)) ||
      (value.lastPassAt !== null && (typeof value.lastPassAt !== "string" || !Number.isFinite(Date.parse(value.lastPassAt))))) return null;
    const stats = value.lastPass;
    if (stats !== null && (!stats || ["claimed", "committed", "failed", "escalated"].some((key) => !Number.isInteger(stats[key]) || stats[key] < 0))) return null;
    return { state: value.state, enabled: value.enabled, productionVerifierCount: value.productionVerifierCount,
      lastPassAt: value.lastPassAt, lastPass: stats, failure: value.failure, observedAt: value.observedAt };
  } catch {
    return null;
  } finally { clearTimeout(timer); }
}

export async function fetchLiveOverview(): Promise<DataResult<OverviewMetrics>> {
  return runQuery("Overview", async (pool) => {
    const [agentsRes, activeRes, pendingRes, outcomesRes, recentRes] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS count FROM agents"),
      pool.query("SELECT COUNT(*)::int AS count FROM actions WHERE status = 'PENDING'"),
      pool.query(
        `SELECT COUNT(*)::int AS count
           FROM actions
          WHERE status = 'PENDING'
            AND (lease_expires_at IS NULL OR lease_expires_at < NOW())`
      ),
      pool.query(
        `SELECT status, COUNT(*)::int AS count
           FROM actions
          WHERE status IN ('COMMITTED', 'FAILED')
          GROUP BY status`
      ),
      pool.query(
        `SELECT idempotency_key, action_type, status, created_at
           FROM actions
          ORDER BY created_at DESC
          LIMIT 6`
      ),
    ]);

    let totalCommitted = 0;
    let totalFailed = 0;
    for (const row of outcomesRes.rows) {
      if (row.status === "COMMITTED") totalCommitted = row.count;
      if (row.status === "FAILED") totalFailed = row.count;
    }

    // No recorded outcomes means the rate is unknown — not 100%.
    const outcomeCount = totalCommitted + totalFailed;
    const commitSuccessRate =
      outcomeCount > 0 ? Number(((totalCommitted / outcomeCount) * 100).toFixed(1)) : null;

    const recentActivity = recentRes.rows.map((row) => ({
      id: String(row.idempotency_key),
      type: "action" as const,
      title: `Action: ${row.action_type}`,
      description: `Status: ${row.status} (key: ${String(row.idempotency_key).slice(0, 12)}...)`,
      timestamp: new Date(row.created_at).toLocaleString(),
      status:
        row.status === "COMMITTED"
          ? ("success" as const)
          : row.status === "FAILED"
            ? ("danger" as const)
            : ("warning" as const),
    }));

    return {
      registeredAgents: agentsRes.rows[0]?.count ?? 0,
      activeActions: activeRes.rows[0]?.count ?? 0,
      // The unified backend never writes an adjudication history, so there is no
      // honest number to show for detected conflicts.
      detectedConflicts: null,
      pendingRecoveries: pendingRes.rows[0]?.count ?? 0,
      totalCommitted,
      totalFailed,
      commitSuccessRate,
      recentActivity,
    };
  });
}

export async function fetchLiveAgents(): Promise<DataResult<Agent[]>> {
  return runQuery("Agents", async (pool) => {
    const res = await pool.query(
      `SELECT id, key, name, metadata,
              created_at AS "createdAt", updated_at AS "updatedAt"
         FROM agents
        ORDER BY created_at DESC
        LIMIT 100`
    );
    return res.rows as Agent[];
  });
}

export async function fetchLiveResources(): Promise<DataResult<Resource[]>> {
  return runQuery("Resources", async (pool) => {
    const res = await pool.query(
      `SELECT id,
              resource_key  AS "key",
              resource_type AS "type",
              version,
              state,
              created_at AS "createdAt",
              updated_at AS "updatedAt"
         FROM resources
        ORDER BY updated_at DESC
        LIMIT 100`
    );
    return res.rows as Resource[];
  });
}

export async function fetchLiveIntents(): Promise<DataResult<Intent[]>> {
  return runQuery("Intents", async (pool) => {
    const intentsRes = await pool.query(
      `SELECT i.id,
              i.agent_id AS "agentId",
              a.key      AS "agentKey",
              a.name     AS "agentName",
              i.task_id  AS "taskId",
              i.intent_statement AS "statement",
              i.status,
              i.expiration_at AS "expirationAt",
              i.created_at    AS "recordedAt",
              i.updated_at    AS "updatedAt"
         FROM intents i
         LEFT JOIN agents a ON a.id = i.agent_id
        ORDER BY i.created_at DESC
        LIMIT 100`
    );

    const intents = intentsRes.rows as Intent[];
    if (intents.length === 0) return [];

    const intentIds = intents.map((i) => i.id);

    const [readsRes, stepsRes] = await Promise.all([
      pool.query(
        `SELECT ir.intent_id AS "intentId",
                ir.resource_id AS "resourceId",
                r.resource_key AS "resourceKey",
                ir.observed_version AS "observedVersion",
                r.version AS "currentVersion"
           FROM intent_reads ir
           LEFT JOIN resources r ON r.id = ir.resource_id
          WHERE ir.intent_id = ANY($1::uuid[])`,
        [intentIds]
      ),
      pool.query(
        `SELECT id,
                intent_id AS "intentId",
                step_number AS "seq",
                description,
                status,
                dependencies AS "dependsOn",
                created_at AS "createdAt"
           FROM intent_steps
          WHERE intent_id = ANY($1::uuid[])
          ORDER BY step_number ASC`,
        [intentIds]
      ),
    ]);

    const readsMap = new Map<string, unknown[]>();
    for (const r of readsRes.rows) {
      if (!readsMap.has(r.intentId)) readsMap.set(r.intentId, []);
      readsMap.get(r.intentId)!.push(r);
    }

    const stepsMap = new Map<string, unknown[]>();
    for (const s of stepsRes.rows) {
      if (!stepsMap.has(s.intentId)) stepsMap.set(s.intentId, []);
      stepsMap.get(s.intentId)!.push({
        ...s,
        // dependencies is JSONB; normalise to an array of strings for the UI.
        dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn : [],
      });
    }

    return intents.map((intent) => ({
      ...intent,
      reads: (readsMap.get(intent.id) ?? []) as Intent["reads"],
      steps: (stepsMap.get(intent.id) ?? []) as Intent["steps"],
    }));
  });
}

export interface DatabaseCapabilities {
  /** null when the extension catalogue could not be read. */
  pgvectorInstalled: boolean | null;
  pgvectorVersion: string | null;
}

/** Verifies pgvector by inspecting the extension catalogue — no guesswork. */
export async function fetchDatabaseCapabilities(): Promise<DataResult<DatabaseCapabilities>> {
  return runQuery("Capabilities", async (pool) => {
    const res = await pool.query("SELECT extversion FROM pg_extension WHERE extname = 'vector' LIMIT 1");
    if (res.rows.length === 0) {
      return { pgvectorInstalled: false, pgvectorVersion: null };
    }
    return {
      pgvectorInstalled: true,
      pgvectorVersion: String(res.rows[0].extversion),
    };
  });
}

const ACTION_SELECT = `
  SELECT a.idempotency_key  AS "idemKey",
         a.episode_id       AS "episodeId",
         a.agent_id         AS "agentId",
         ag.key             AS "agentKey",
         a.action_type      AS "actionType",
         a.arguments        AS "actionArgs",
         a.status,
         a.lease_owner      AS "leaseOwner",
         a.lease_expires_at AS "leaseExpires",
         a.external_reference AS "externalRef",
         a.outcome,
         a.attempts,
         a.created_at          AS "createdAt",
         a.resolved_at         AS "resolvedAt",
         a.effect_state        AS "effectState",
         a.effect_started_at   AS "effectStartedAt",
         a.effect_completed_at AS "effectCompletedAt",
         a.verifier_response   AS "verifierResponse",
         a.verified_at         AS "verifiedAt"
    FROM actions a
    LEFT JOIN agents ag ON ag.id = a.agent_id`;

export async function fetchLiveActions(): Promise<DataResult<Action[]>> {
  return runQuery("Actions", async (pool) => {
    const res = await pool.query(
      `${ACTION_SELECT}
        ORDER BY a.created_at DESC
        LIMIT 100`
    );

    const actions = res.rows as Action[];
    if (actions.length === 0) return [];

    const keys = actions.map((a) => a.idemKey);
    const rvRes = await pool.query(
      `SELECT arv.action_id AS "actionKey",
              arv.resource_id AS "resourceId",
              r.resource_key AS "resourceKey",
              arv.observed_version AS "observedVersion"
         FROM action_resource_versions arv
         LEFT JOIN resources r ON r.id = arv.resource_id
        WHERE arv.action_id = ANY($1)`,
      [keys]
    );

    const rvMap = new Map<string, Array<Record<string, unknown>>>();
    for (const r of rvRes.rows) {
      if (!rvMap.has(r.actionKey)) rvMap.set(r.actionKey, []);
      rvMap.get(r.actionKey)!.push({
        resourceId: r.resourceId,
        resourceKey: r.resourceKey,
        observedVersion: r.observedVersion,
      });
    }

    return actions.map((act) => ({
      ...act,
      resourceVersions: (rvMap.get(act.idemKey) ?? []) as Action["resourceVersions"],
    }));
  });
}

/** Single-action lookup used by the read-only Recovery Center inspection. */
export async function fetchLiveActionByKey(idemKey: string): Promise<DataResult<Action | null>> {
  return runQuery("ActionByKey", async (pool) => {
    const res = await pool.query(`${ACTION_SELECT} WHERE a.idempotency_key = $1 LIMIT 1`, [idemKey]);
    return (res.rows[0] as Action | undefined) ?? null;
  });
}

export async function fetchLiveEpisodes(): Promise<DataResult<Episode[]>> {
  return runQuery("Episodes", async (pool) => {
    const res = await pool.query(
      `SELECT episode_id AS "id",
              narrative,
              outcome,
              status,
              (embedding IS NOT NULL) AS "hasEmbedding",
              created_at AS "createdAt"
         FROM episodes
        ORDER BY created_at DESC
        LIMIT 100`
    );
    return res.rows as Episode[];
  });
}

export interface ProvenanceGraph {
  nodes: ProvenanceNode[];
  edges: ProvenanceEdge[];
  /** What this graph does and does not contain. */
  note: string;
  /** Entities the graph could not read in full. Empty when nothing was truncated. */
  truncated: string[];
}

/**
 * Safety valve for the whole-graph reads below, not a product limit. The list
 * endpoints paginate at 100 rows for the tables, which silently drops nodes from
 * a graph, so provenance reads its own window and reports when the valve trips.
 */
const PROVENANCE_ROW_CAP = 2000;

interface ProvenanceSource {
  agents: Array<{ id: string; key: string; name: string }>;
  resources: Array<{ id: string; key: string; type: string; version: number }>;
  intents: Array<{ id: string; agentId: string | null; statement: string; status: string }>;
  reads: Array<{
    intentId: string;
    resourceId: string;
    observedVersion: number;
    currentVersion: number | null;
  }>;
}

interface ProvenanceRead {
  source: ProvenanceSource;
  truncated: string[];
}

/**
 * Read-only provenance derived from real agents / intents / reads / resources.
 *
 * Every node is a row and every edge is a foreign key that exists in PostgreSQL:
 *  - agent -> intent            intents.agent_id
 *  - intent -> resource         intent_reads(intent_id, resource_id)
 * Conflict adjudications are deliberately absent: the backend never persists them.
 */
export async function fetchLiveProvenance(): Promise<DataResult<ProvenanceGraph>> {
  const read = await runQuery<ProvenanceRead>(
    "Provenance",
    async (pool) => {
      const [agentsRes, resourcesRes, intentsRes] = await Promise.all([
        pool.query(`SELECT id, key, name FROM agents ORDER BY created_at DESC LIMIT $1`, [
          PROVENANCE_ROW_CAP + 1,
        ]),
        pool.query(
          `SELECT id,
                  resource_key  AS "key",
                  resource_type AS "type",
                  version
             FROM resources
            ORDER BY updated_at DESC
            LIMIT $1`,
          [PROVENANCE_ROW_CAP + 1]
        ),
        pool.query(
          `SELECT id,
                  agent_id          AS "agentId",
                  intent_statement  AS "statement",
                  status
             FROM intents
            ORDER BY created_at DESC
            LIMIT $1`,
          [PROVENANCE_ROW_CAP + 1]
        ),
      ]);

      const truncated: string[] = [];
      const trim = <T>(rows: T[], label: string): T[] => {
        if (rows.length > PROVENANCE_ROW_CAP) {
          truncated.push(label);
          return rows.slice(0, PROVENANCE_ROW_CAP);
        }
        return rows;
      };

      const agents = trim(agentsRes.rows as ProvenanceSource["agents"], "agents");
      const resources = trim(resourcesRes.rows as ProvenanceSource["resources"], "resources");
      const intents = trim(intentsRes.rows as ProvenanceSource["intents"], "intents");

      let reads: ProvenanceSource["reads"] = [];
      if (intents.length > 0) {
        const readsRes = await pool.query(
          `SELECT ir.intent_id        AS "intentId",
                  ir.resource_id      AS "resourceId",
                  ir.observed_version AS "observedVersion",
                  r.version           AS "currentVersion"
             FROM intent_reads ir
             LEFT JOIN resources r ON r.id = ir.resource_id
            WHERE ir.intent_id = ANY($1::uuid[])`,
          [intents.map((i) => i.id)]
        );
        reads = readsRes.rows as ProvenanceSource["reads"];
      }

      return { source: { agents, resources, intents, reads }, truncated };
    }
  );

  if (!read.ok) return read;

  const { agents, resources, intents, reads } = read.data.source;
  const nodes: ProvenanceNode[] = [];
  const edges: ProvenanceEdge[] = [];

  for (const a of agents) {
    nodes.push({
      id: `agent:${a.id}`,
      label: a.name || a.key,
      type: "agent",
      status: "active",
      metadata: { key: a.key },
    });
  }

  for (const r of resources) {
    nodes.push({
      id: `res:${r.id}`,
      label: `${r.key} (v${r.version})`,
      type: "resource",
      status: "stable",
      metadata: { type: r.type, version: r.version },
    });
  }

  for (const i of intents) {
    nodes.push({
      id: `intent:${i.id}`,
      label: i.statement,
      type: "intent",
      status: i.status,
      metadata: { statement: i.statement },
    });
  }

  for (const i of intents) {
    if (i.agentId) {
      edges.push({
        id: `e-${i.agentId}-${i.id}`,
        source: `agent:${i.agentId}`,
        target: `intent:${i.id}`,
        label: "declares",
      });
    }
  }

  // intent_reads is UNIQUE(intent_id, resource_id), so each row is exactly one edge.
  for (const r of reads) {
    edges.push({
      id: `e-read-${r.intentId}-${r.resourceId}`,
      source: `intent:${r.intentId}`,
      target: `res:${r.resourceId}`,
      label: `reads (v${r.observedVersion})`,
      status:
        r.currentVersion !== null && r.observedVersion !== r.currentVersion
          ? "threatened"
          : "safe",
    });
  }

  return {
    ok: true,
    data: {
      nodes,
      edges,
      truncated: read.data.truncated,
      note: "Live intent/resource provenance. Conflict adjudications are not persisted by the unified backend and therefore never appear in this graph.",
    },
  };
}
