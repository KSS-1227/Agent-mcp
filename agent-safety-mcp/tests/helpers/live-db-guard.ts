import dotenv from "dotenv";
import {
  assertIsolatedTestDatabaseConfig,
  verifyConnectedTestDatabase,
  type TestDatabaseIdentity,
} from "../../src/config/database-isolation.mjs";

export interface LiveDatabaseTestConfig {
  enabled: boolean;
  databaseUrl?: string;
  supabaseUrl?: string;
  supabaseServiceRoleKey?: string;
  identity?: TestDatabaseIdentity;
}

/** Environment loading is deliberately behind an explicit test-only opt-in. */
export function loadLiveDatabaseTestConfig(
  env: NodeJS.ProcessEnv = process.env,
  loadEnv: () => void = () => { dotenv.config(); }
): LiveDatabaseTestConfig {
  if (env.RUN_LIVE_DB_TESTS !== "1") return { enabled: false };

  loadEnv();
  const databaseUrl = env.TEST_DATABASE_URL;
  if (!databaseUrl?.trim()) {
    throw new Error("RUN_LIVE_DB_TESTS=1 requires TEST_DATABASE_URL; DATABASE_URL is not accepted for live tests");
  }
  const identity = assertIsolatedTestDatabaseConfig(env);
  return {
    enabled: true,
    databaseUrl,
    supabaseUrl: env.TEST_SUPABASE_URL,
    supabaseServiceRoleKey: env.TEST_SUPABASE_SERVICE_ROLE_KEY,
    identity,
  };
}

/** Call after connecting and before any test fixture writes. */
export async function verifyLiveDatabaseTestIdentity(
  queryable: { query(sql: string): Promise<{ rows: Array<{ database_name?: string }> }> },
  config: LiveDatabaseTestConfig
): Promise<void> {
  if (!config.enabled || !config.identity) {
    throw new Error("Live test database identity is unavailable");
  }
  await verifyConnectedTestDatabase(queryable, config.identity);
}

/** Registers cleanup in Vitest's afterEach hook, which runs after pass or failure. */
export function installAfterEachCleanup(
  registerAfterEach: (callback: () => Promise<void>) => unknown,
  cleanup: () => Promise<void>
): void {
  registerAfterEach(async () => cleanup());
}

/**
 * Deleting live fixtures is authorized separately from running live tests.
 * Only the exact string "1" enables it, so values such as "true", "01" or ""
 * stay denied.
 */
export function isLiveCleanupAuthorized(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.RUN_LIVE_RECOVERY_CLEANUP === "1";
}

export interface LiveCleanupPrerequisites {
  /** Live database testing is enabled for this file (both opt-in flags). */
  liveEnabled: boolean;
  /** isLiveCleanupAuthorized() evaluated for this process. */
  cleanupAuthorized: boolean;
  /** The expected database identity matched before any fixture was written. */
  identityVerified: boolean;
  /** Read-only schema preflight passed before any fixture was written. */
  preflightPassed: boolean;
}

export type LiveCleanupRefusal =
  | "live-database-testing-disabled"
  | "cleanup-not-authorized"
  | "database-identity-not-verified"
  | "schema-preflight-not-passed";

const CLEANUP_REFUSAL_MESSAGES: Record<LiveCleanupRefusal, string> = {
  "live-database-testing-disabled": "live database testing is disabled",
  "cleanup-not-authorized": "RUN_LIVE_RECOVERY_CLEANUP is not set to 1",
  "database-identity-not-verified": "database identity was not verified",
  "schema-preflight-not-passed": "schema preflight did not pass",
};

export type LiveCleanupGate =
  | { allowed: true }
  | { allowed: false; refusal: LiveCleanupRefusal };

/**
 * Cleanup is allowed only when every prerequisite holds independently.
 * Authorizing cleanup never substitutes for identity or schema verification.
 */
export function evaluateLiveCleanupGate(
  prerequisites: LiveCleanupPrerequisites
): LiveCleanupGate {
  if (!prerequisites.liveEnabled) {
    return { allowed: false, refusal: "live-database-testing-disabled" };
  }
  if (!prerequisites.cleanupAuthorized) {
    return { allowed: false, refusal: "cleanup-not-authorized" };
  }
  if (!prerequisites.identityVerified) {
    return { allowed: false, refusal: "database-identity-not-verified" };
  }
  if (!prerequisites.preflightPassed) {
    return { allowed: false, refusal: "schema-preflight-not-passed" };
  }
  return { allowed: true };
}

export type LiveFixtureTable =
  | "actions"
  | "intent_steps"
  | "intents"
  | "episodes"
  | "agents";

/**
 * Children first. actions.episode_id is ON DELETE SET NULL, so deleting an
 * episode before its action would silently orphan the action row instead of
 * removing it. agents is last because actions and intents cascade from it.
 */
export const LIVE_FIXTURE_DELETE_ORDER: readonly LiveFixtureTable[] = [
  "actions",
  "intent_steps",
  "intents",
  "episodes",
  "agents",
];

export interface LiveFixturePlan {
  namespace: string;
  agentIds: string[];
  intentIds: string[];
  stepIds: string[];
  episodeIds: string[];
  actionKeys: string[];
  /** Explicitly tracked rows whose FK cascade is expected when fixture actions are deleted. */
  actionEvidenceIds?: string[];
  testExternalEffectIds?: string[];
  /** Exact step/intent pairs deliberately removed by the missing-step scenario. */
  intentionallyRemovedSteps?: Array<{ intentId: string; stepId: string }>;
}

export interface IntentionallyRemovedStep {
  intentId: string;
  stepId: string;
}

export interface LiveCleanupUnresolved {
  table: LiveFixtureTable | "tasks" | "auth_users" | "intent_reads" | "conflicts" | "action_resource_versions" | "action_evidence" | "test_external_effects";
  id: string;
  reason: "ownership-unverified" | "ambiguous-count" | "delete-failed" | "still-present" | "cleanup-aborted";
}

export interface LiveCleanupReport {
  attempted: boolean;
  ok: boolean;
  connectionReusable: boolean;
  refusal?: LiveCleanupRefusal;
  deleted: Partial<Record<LiveFixtureTable, number>>;
  unresolved: LiveCleanupUnresolved[];
  failures: string[];
  residue: Partial<Record<LiveFixtureTable, number>>;
}

/** Formats only the table, tracked fixture identifier, and fixed reason code. */
export function formatLiveCleanupUnresolved(
  unresolved: readonly LiveCleanupUnresolved[]
): string {
  return unresolved
    .map(({ table, id, reason }) => `${table}:${id} (${reason})`)
    .join("; ");
}

export interface LiveCleanupQueryable {
  query(
    sql: string,
    params?: unknown[]
  ): Promise<{ rowCount?: number | null; rows: any[] }>;
}

/** Deletes only the exact test step and returns ownership evidence on rowCount=1. */
export async function deleteExactMissingStep(
  client: LiveCleanupQueryable,
  intentId: string,
  stepId: string
): Promise<IntentionallyRemovedStep> {
  const result = await client.query(
    "DELETE FROM intent_steps WHERE id = $1 AND intent_id = $2",
    [stepId, intentId]
  );
  if (result.rowCount !== 1) {
    throw new Error("Could not remove the exact test-owned step for the missing-step scenario");
  }
  return { intentId, stepId };
}

export interface LiveCleanupClient extends LiveCleanupQueryable {
  release(destroy?: boolean): void;
}

export interface LiveCleanupPool {
  connect(): Promise<LiveCleanupClient>;
  end(): Promise<void>;
}

export interface LiveCleanupOptions {
  prerequisites: LiveCleanupPrerequisites;
  /** Both callbacks run on the pinned cleanup client, inside the cleanup transaction. */
  reverifyIdentity: (client: LiveCleanupQueryable) => Promise<void>;
  reverifySchema: (client: LiveCleanupQueryable) => Promise<void>;
  log?: (message: string) => void;
}

// Ownership is always evaluated for exact ids; no predicate ever widens the set.
const OWNERSHIP_SQL = {
  agents: `SELECT id, (left(key, length($2)) = $2) AS owned
             FROM agents
            WHERE id = ANY($1::uuid[])
            FOR UPDATE`,
  intents: `SELECT id, (agent_id = ANY($2::uuid[]) AND metadata->>'purpose' = $3) AS owned
              FROM intents
              WHERE id = ANY($1::uuid[])
              FOR UPDATE`,
  intent_steps: `SELECT id, intent_id, (intent_id = ANY($2::uuid[])) AS owned
                   FROM intent_steps
                  WHERE id = ANY($1::uuid[])
                  FOR UPDATE`,
  episodes: `SELECT episode_id AS id, narrative
               FROM episodes
               WHERE episode_id = ANY($1::text[])
               FOR UPDATE`,
  actions: `SELECT idempotency_key AS id,
                   (episode_id = ANY($2::text[]) AND agent_id = ANY($3::uuid[])) AS owned
              FROM actions
              WHERE idempotency_key = ANY($1::text[])
              FOR UPDATE`,
} as const;

// Migrations define these cascading or mutating references. Every row must be
// absent or one of the already-proven fixture rows before any deletion begins.
const CASCADE_SCOPE_SQL = {
  tasks: "SELECT id FROM tasks WHERE agent_id = ANY($1::uuid[]) FOR UPDATE",
  intents: "SELECT id FROM intents WHERE agent_id = ANY($1::uuid[]) FOR UPDATE",
  actions: `SELECT idempotency_key AS id FROM actions
             WHERE agent_id = ANY($1::uuid[]) OR lease_owner = ANY($1::uuid[])
                OR episode_id = ANY($2::text[])
             FOR UPDATE`,
  auth_users: "SELECT user_id AS id FROM auth_users WHERE agent_id = ANY($1::uuid[]) FOR UPDATE",
  intent_steps: "SELECT id FROM intent_steps WHERE intent_id = ANY($1::uuid[]) FOR UPDATE",
  intent_reads: "SELECT id FROM intent_reads WHERE intent_id = ANY($1::uuid[]) FOR UPDATE",
  conflicts: `SELECT id FROM conflicts
               WHERE intent_id = ANY($1::uuid[]) OR conflicting_intent_id = ANY($1::uuid[])
               FOR UPDATE`,
  action_resource_versions: "SELECT action_id AS id FROM action_resource_versions WHERE action_id = ANY($1::text[]) FOR UPDATE",
  action_evidence: `SELECT ae.id, a.idempotency_key AS action_key
                     FROM action_evidence ae
                     JOIN actions a ON a.id = ae.action_id
                    WHERE a.idempotency_key = ANY($1::text[])
                    FOR UPDATE OF ae`,
  test_external_effects: `SELECT te.id, a.idempotency_key AS action_key
                            FROM test_external_effects te
                            JOIN actions a ON a.id = te.action_id
                           WHERE a.idempotency_key = ANY($1::text[])
                           FOR UPDATE OF te`,
} as const;

const DELETE_SQL = {
  actions: "DELETE FROM actions WHERE idempotency_key = ANY($1::text[])",
  intent_steps: "DELETE FROM intent_steps WHERE id = ANY($1::uuid[])",
  intents: "DELETE FROM intents WHERE id = ANY($1::uuid[])",
  episodes: "DELETE FROM episodes WHERE episode_id = ANY($1::text[])",
  agents: "DELETE FROM agents WHERE id = ANY($1::uuid[])",
} as const;

const RESIDUE_SQL = {
  actions:
    "SELECT count(*)::int AS remaining FROM actions WHERE idempotency_key = ANY($1::text[])",
  intent_steps:
    "SELECT count(*)::int AS remaining FROM intent_steps WHERE id = ANY($1::uuid[])",
  intents:
    "SELECT count(*)::int AS remaining FROM intents WHERE id = ANY($1::uuid[])",
  episodes:
    "SELECT count(*)::int AS remaining FROM episodes WHERE episode_id = ANY($1::text[])",
  agents:
    "SELECT count(*)::int AS remaining FROM agents WHERE id = ANY($1::uuid[])",
} as const;

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fixtureIds(plan: LiveFixturePlan): Record<LiveFixtureTable, string[]> {
  return {
    actions: unique(plan.actionKeys),
    intent_steps: unique(plan.stepIds),
    intents: unique(plan.intentIds),
    episodes: unique(plan.episodeIds),
    agents: unique(plan.agentIds),
  };
}

function fixtureDependentIds(plan: LiveFixturePlan): {
  action_evidence: string[];
  test_external_effects: string[];
} {
  return {
    action_evidence: unique(plan.actionEvidenceIds ?? []),
    test_external_effects: unique(plan.testExternalEffectIds ?? []),
  };
}

/**
 * Deletes only fixture rows whose ownership is proven for this run.
 *
 * Refuses without issuing any statement when the gate denies cleanup or when
 * the identity re-check fails. When any requested row exists but its ownership
 * cannot be proven, no row is deleted at all and the row is reported instead of
 * broadening a predicate or retrying a destructive statement.
 */
export async function runLiveFixtureCleanup(
  client: LiveCleanupClient,
  plan: LiveFixturePlan,
  options: LiveCleanupOptions
): Promise<LiveCleanupReport> {
  const log = options.log ?? (() => {});
  const report: LiveCleanupReport = {
    attempted: false,
    ok: false,
    connectionReusable: true,
    deleted: {},
    unresolved: [],
    failures: [],
    residue: {},
  };

  const gate = evaluateLiveCleanupGate(options.prerequisites);
  if (!gate.allowed) {
    report.refusal = gate.refusal;
    log(
      `[cleanup] skipped (${CLEANUP_REFUSAL_MESSAGES[gate.refusal]}); fixture rows may remain`
    );
    return report;
  }

  report.attempted = true;
  let transactionOpen = false;
  const requested = fixtureIds(plan);
  const allRequested = (): LiveCleanupUnresolved[] =>
    LIVE_FIXTURE_DELETE_ORDER.flatMap((table) =>
      requested[table].map((id) => ({ table, id, reason: "cleanup-aborted" as const }))
    );
  const abort = async (
    message: string,
    unresolved: LiveCleanupUnresolved[] = allRequested()
  ): Promise<LiveCleanupReport> => {
    report.failures.push(message);
    report.unresolved.push(...unresolved);
    if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
        transactionOpen = false;
      } catch (error) {
        report.connectionReusable = false;
        report.failures.push(`cleanup rollback failed: ${describeError(error)}`);
      }
    }
    return report;
  };

  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    transactionOpen = true;
    await options.reverifyIdentity(client);
    await options.reverifySchema(client);
  } catch (error) {
    if (!transactionOpen) report.connectionReusable = false;
    return abort(`cleanup identity/schema preflight failed: ${describeError(error)}`);
  }

  const proven: Record<LiveFixtureTable, string[]> = {
    actions: [],
    intent_steps: [],
    intents: [],
    episodes: [],
    agents: [],
  };
  const unowned: LiveCleanupUnresolved[] = [];
  const stepIntent = new Map<string, string>();

  try {
    // Lock agent roots first. Their FK rows cannot be added or changed while
    // this transaction verifies and removes the known fixture graph.
    if (requested.agents.length) {
      const result = await client.query(OWNERSHIP_SQL.agents, [requested.agents, `${plan.namespace}:`]);
      for (const row of result.rows) {
        if (row.owned === true) proven.agents.push(String(row.id));
        else unowned.push({ table: "agents", id: String(row.id), reason: "ownership-unverified" });
      }
    }

    if (requested.intents.length) {
      const result = await client.query(OWNERSHIP_SQL.intents, [requested.intents, proven.agents, plan.namespace]);
      for (const row of result.rows) {
        if (row.owned === true) proven.intents.push(String(row.id));
        else unowned.push({ table: "intents", id: String(row.id), reason: "ownership-unverified" });
      }
    }

    if (requested.intent_steps.length) {
      const result = await client.query(OWNERSHIP_SQL.intent_steps, [requested.intent_steps, proven.intents]);
      for (const row of result.rows) {
        const id = String(row.id);
        if (row.owned === true) {
          proven.intent_steps.push(id);
          stepIntent.set(id, String(row.intent_id));
        } else unowned.push({ table: "intent_steps", id, reason: "ownership-unverified" });
      }
    }

    if (requested.episodes.length) {
      const result = await client.query(OWNERSHIP_SQL.episodes, [requested.episodes]);
      for (const row of result.rows) {
        const id = String(row.id);
        const parts = id.split(":");
        const intentionallyRemovedStep = plan.intentionallyRemovedSteps?.some((removed) =>
          removed.intentId === parts[0] &&
          removed.stepId === parts[1] &&
          requested.intents.includes(removed.intentId) &&
          requested.intent_steps.includes(removed.stepId)
        ) ?? false;
        const owned = parts.length === 2 &&
          proven.intents.includes(parts[0]) &&
          (stepIntent.get(parts[1]) === parts[0] || intentionallyRemovedStep) &&
          typeof row.narrative === "string" && row.narrative.includes(plan.namespace);
        if (owned) proven.episodes.push(id);
        else unowned.push({ table: "episodes", id, reason: "ownership-unverified" });
      }
    }

    if (requested.actions.length) {
      const result = await client.query(OWNERSHIP_SQL.actions, [requested.actions, proven.episodes, proven.agents]);
      for (const row of result.rows) {
        if (row.owned === true) proven.actions.push(String(row.id));
        else unowned.push({ table: "actions", id: String(row.id), reason: "ownership-unverified" });
      }
    }

    if (unowned.length) {
      return abort(
        `${unowned.length} fixture row(s) could not be proven to belong to ${plan.namespace}; no rows were deleted`,
        unowned
      );
    }

    const cascadeChecks: Array<{
      table: keyof typeof CASCADE_SCOPE_SQL;
      ids: string[];
      allowed: Set<string>;
      params: unknown[][];
      parentActionKey?: boolean;
    }> = [
      { table: "tasks", ids: [], allowed: new Set(), params: [proven.agents] },
      { table: "intents", ids: proven.agents, allowed: new Set(proven.intents), params: [proven.agents] },
      { table: "actions", ids: proven.agents, allowed: new Set(proven.actions), params: [proven.agents, proven.episodes] },
      { table: "auth_users", ids: [], allowed: new Set(), params: [proven.agents] },
      { table: "intent_steps", ids: proven.intents, allowed: new Set(proven.intent_steps), params: [proven.intents] },
      { table: "intent_reads", ids: [], allowed: new Set(), params: [proven.intents] },
      { table: "conflicts", ids: [], allowed: new Set(), params: [proven.intents] },
      { table: "action_resource_versions", ids: [], allowed: new Set(), params: [proven.actions] },
      // These tables cascade from actions.id. The test does not create either
      // dependent today, so their expected sets are empty unless a future
      // fixture explicitly tracks exact dependent IDs. Any untracked row blocks
      // action deletion; tracked rows are removed only by the later action
      // delete's FK cascade, after this verification succeeds.
      { table: "action_evidence", ids: [], allowed: new Set(fixtureDependentIds(plan).action_evidence), params: [proven.actions], parentActionKey: true },
      { table: "test_external_effects", ids: [], allowed: new Set(fixtureDependentIds(plan).test_external_effects), params: [proven.actions], parentActionKey: true },
    ];
    const cascadeUnresolved: LiveCleanupUnresolved[] = [];
    for (const check of cascadeChecks) {
      if (!check.params[0].length) continue;
      const result = await client.query(CASCADE_SCOPE_SQL[check.table], check.params);
      for (const row of result.rows) {
        const id = String(row.id);
        if (!check.allowed.has(id) || (check.parentActionKey && !proven.actions.includes(String(row.action_key)))) {
          cascadeUnresolved.push({ table: check.table, id, reason: "ownership-unverified" });
        }
      }
    }
    if (cascadeUnresolved.length) {
      return abort("Untracked or unowned dependent rows could be affected by cascade or SET NULL; no rows were deleted", cascadeUnresolved);
    }
  } catch (error) {
    return abort(`cleanup ownership/cascade preflight failed: ${describeError(error)}`);
  }

  for (const table of LIVE_FIXTURE_DELETE_ORDER) {
    const ids = proven[table];
    if (!ids.length) {
      report.deleted[table] = 0;
      continue;
    }

    let rowCount: number;
    try {
      const result = await client.query(DELETE_SQL[table], [ids]);
      rowCount = result.rowCount ?? 0;
    } catch (error) {
      return abort(`delete from ${table} failed: ${describeError(error)}`, ids.map((id) => ({ table, id, reason: "delete-failed" })));
    }

    report.deleted[table] = rowCount;
    if (rowCount !== ids.length) {
      return abort(
        `delete from ${table} affected ${rowCount} of ${ids.length} expected rows`,
        ids.map((id) => ({ table, id, reason: "ambiguous-count" }))
      );
    }
  }

  try {
    await client.query("COMMIT");
    transactionOpen = false;
  } catch (error) {
    report.connectionReusable = false;
    return abort(`cleanup commit failed: ${describeError(error)}`);
  }

  for (const table of LIVE_FIXTURE_DELETE_ORDER) {
    const ids = requested[table];
    if (!ids.length) continue;
    try {
      const result = await client.query(RESIDUE_SQL[table], [ids]);
      const remaining = Number(result.rows[0]?.remaining ?? 0);
      report.residue[table] = remaining;
      if (remaining > 0) {
        report.failures.push(`${remaining} ${table} fixture row(s) remain after cleanup`);
        report.unresolved.push(...ids.map((id) => ({ table, id, reason: "still-present" as const })));
      }
    } catch (error) {
      report.failures.push(`residue check for ${table} failed: ${describeError(error)}`);
      report.unresolved.push(...ids.map((id) => ({ table, id, reason: "still-present" as const })));
    }
  }

  report.ok = report.failures.length === 0;
  if (report.ok) {
    log(`[cleanup] verified: no ${plan.namespace} fixture rows remain`);
  }
  return report;
}

/** Owns the pinned connection and pool shutdown for every cleanup outcome. */
export async function withLiveCleanupClient<T>(
  pool: LiveCleanupPool,
  run: (client: LiveCleanupClient, discardClient: () => void) => Promise<T>
): Promise<T> {
  let client: LiveCleanupClient | undefined;
  let discard = false;
  try {
    client = await pool.connect();
    return await run(client, () => { discard = true; });
  } finally {
    try {
      client?.release(discard);
    } finally {
      await pool.end();
    }
  }
}

/**
 * Read-only residue report: counts the exact tracked ids that still exist.
 * Never deletes, and never claims a cleanup outcome.
 */
export async function reportLiveFixtureResidue(
  pool: LiveCleanupQueryable,
  plan: LiveFixturePlan,
  log: (message: string) => void = () => {}
): Promise<{ counts: Partial<Record<LiveFixtureTable, number>>; total: number }> {
  const requested = fixtureIds(plan);
  const counts: Partial<Record<LiveFixtureTable, number>> = {};
  let total = 0;

  for (const table of LIVE_FIXTURE_DELETE_ORDER) {
    const ids = requested[table];
    if (!ids.length) continue;
    const result = await pool.query(RESIDUE_SQL[table], [ids]);
    const remaining = Number(result.rows[0]?.remaining ?? 0);
    counts[table] = remaining;
    total += remaining;
  }

  const summary = LIVE_FIXTURE_DELETE_ORDER.map(
    (table) => `${table}=${counts[table] ?? 0}`
  ).join(" ");
  log(
    `[cleanup] residue retained for ${plan.namespace}: ${summary} (total=${total}); no deletion was performed`
  );
  return { counts, total };
}
