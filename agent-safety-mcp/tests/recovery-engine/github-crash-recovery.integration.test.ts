import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Pool } from "pg";
import { v4 as uuidv4 } from "uuid";
import {
  installAfterEachCleanup,
  isLiveCleanupAuthorized,
  loadLiveDatabaseTestConfig,
  reportLiveFixtureResidue,
  runLiveFixtureCleanup,
  verifyLiveDatabaseTestIdentity,
  withLiveCleanupClient,
  type LiveCleanupClient,
  type LiveCleanupQueryable,
  type LiveFixturePlan,
} from "../helpers/live-db-guard";
import { ActionCoordinator } from "../../src/recovery-engine/coordinator";
import { GITHUB_CREATE_ISSUE, GitHubIssueVerifier, githubMarker } from "../../src/recovery-engine/github-issue";
import { Action, VerdictDisposition, verdictDispositionToString } from "../../src/recovery-engine/types";
import { getActionProtocolTools } from "../../src/mcp/tools/actions";
import { IntentService, getIntentService, setIntentService } from "../../src/conflict-engine/intent.service";
import { ResourceService, getResourceService, setResourceService } from "../../src/core/resource.service";
import { DatabaseClient } from "../../src/database/client";
import { getVerifierRegistry, setVerifierRegistry, VerifierRegistry } from "../../src/recovery-engine/verifier_registry";

const requested = process.env.RUN_GITHUB_CRASH_RECOVERY_TEST === "1";
const liveConfig = loadLiveDatabaseTestConfig();
const testRepo = process.env.TEST_GITHUB_REPOSITORY?.trim();
const testToken = process.env.TEST_GITHUB_TOKEN?.trim();
const configuredProductionRepo = process.env.GITHUB_REPOSITORY?.trim().toLowerCase();

if (requested && !liveConfig.enabled) {
  throw new Error("RUN_GITHUB_CRASH_RECOVERY_TEST=1 requires the isolated RUN_LIVE_DB_TESTS=1 configuration");
}
if (requested && (!testRepo || !testToken)) {
  throw new Error("The opted-in crash recovery test requires TEST_GITHUB_REPOSITORY and TEST_GITHUB_TOKEN");
}
if (requested && (!testRepo || !/^[^/]+\/[^/]+$/.test(testRepo))) {
  throw new Error("TEST_GITHUB_REPOSITORY must be owner/repository");
}
if (requested && testRepo?.toLowerCase() === "kss-1227/agent-mcp") {
  throw new Error("The crash recovery test refuses the production Agent-mcp repository; configure a dedicated test repository");
}
if (requested && testRepo?.toLowerCase() === configuredProductionRepo) {
  throw new Error("TEST_GITHUB_REPOSITORY must differ from the configured production GITHUB_REPOSITORY");
}

const enabled = requested && liveConfig.enabled && Boolean(testRepo && testToken);
const describeLive = enabled ? describe : describe.skip;
const execFileAsync = promisify(execFile);

const schemaSql = `SELECT to_regclass('public.agents') AS agents,
                          to_regclass('public.intents') AS intents,
                          to_regclass('public.intent_steps') AS intent_steps,
                          to_regclass('public.episodes') AS episodes,
                          to_regclass('public.actions') AS actions,
                          to_regclass('public.action_evidence') AS action_evidence,
                          to_regclass('public.intent_reads') AS intent_reads,
                          to_regclass('public.resources') AS resources`;

async function verifyFixtureSchema(client: LiveCleanupQueryable): Promise<void> {
  const result = await client.query(schemaSql);
  const row = result.rows[0];
  if (!row || Object.values(row).some((value) => value == null)) {
    throw new Error("Crash recovery test requires the existing recovery and action-evidence tables");
  }
}

function parseWorkerJson(stdout: string, expectedKeys: string[]): Record<string, any> {
  const trimmed = stdout.trim();
  if (!trimmed || trimmed.includes("\n") || trimmed.includes("\r")) {
    throw new Error("Recovery worker stdout must contain exactly one JSON object");
  }
  let value: any;
  try { value = JSON.parse(trimmed); }
  catch { throw new Error("Recovery worker stdout was not valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Recovery worker result must be a JSON object");
  }
  const actualKeys = Object.keys(value).sort();
  const requiredKeys = [...expectedKeys].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(requiredKeys)) {
    throw new Error(`Recovery worker result keys differed from the expected protocol: ${actualKeys.join(",")}`);
  }
  return value;
}

function describeCleanupError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

describeLive("GitHub issue crash recovery (isolated live integration)", () => {
  let db: Pool | undefined;
  let identityVerified = false;
  let schemaVerified = false;
  let originAgentId = "";
  let reconcilerAgentId = "";
  let sentinelAgentId = "";
  let intentId = "";
  let stepId = "";
  let siblingStepId = "";
  let episodeId = "";
  let idemKey = "";
  let physicalActionId = "";
  let evidenceId = "";
  let sentinelUpdatedAtIso = "";
  let namespace = "";
  let sentinelNamespace = "";
  let originalNodeEnv: string | undefined;
  let originalGithubRepository: string | undefined;
  let originalGithubToken: string | undefined;

  const fixturePlan: LiveFixturePlan = {
    namespace: "not-initialized",
    agentIds: [],
    intentIds: [],
    stepIds: [],
    episodeIds: [],
    actionKeys: [],
    actionEvidenceIds: [],
  };
  const sentinelPlan: LiveFixturePlan = {
    namespace: "not-initialized-sentinel",
    agentIds: [],
    intentIds: [],
    stepIds: [],
    episodeIds: [],
    actionKeys: [],
  };

  const cleanupOptions = (client: LiveCleanupClient) => ({
    prerequisites: {
      liveEnabled: liveConfig.enabled,
      cleanupAuthorized: isLiveCleanupAuthorized(),
      identityVerified,
      preflightPassed: schemaVerified,
    },
    reverifyIdentity: async (sameClient: LiveCleanupQueryable) => verifyLiveDatabaseTestIdentity(sameClient, liveConfig),
    reverifySchema: verifyFixtureSchema,
  });

  async function cleanupFixturesAndCheckSentinel(): Promise<void> {
    if (!db) return;
    const pool = db;
    try {
      if (!identityVerified || !schemaVerified) {
        await pool.end();
        return;
      }
      await withLiveCleanupClient(pool, async (client, discardClient) => {
        const opts = cleanupOptions(client);
        const failures: string[] = [];
        let primaryOutcome = "primary fixture cleanup not attempted";

        // Primary cleanup is reported on its own. Whatever it decides, the
        // unrelated sentinel is still verified and removed below.
        try {
          const primaryCleanup = await runLiveFixtureCleanup(client, fixturePlan, opts);
          if (!primaryCleanup.connectionReusable) discardClient();
          if (primaryCleanup.attempted && !primaryCleanup.ok) {
            failures.push(`primary fixture cleanup failed: ${primaryCleanup.failures.join("; ")}`);
          }
          if (!primaryCleanup.attempted) await reportLiveFixtureResidue(client, fixturePlan);
          primaryOutcome = !primaryCleanup.attempted
            ? `primary fixture cleanup refused (${primaryCleanup.refusal})`
            : primaryCleanup.ok
              ? "primary fixture cleanup verified"
              : "primary fixture cleanup failed";
        } catch (error) {
          failures.push(`primary fixture cleanup threw: ${describeCleanupError(error)}`);
          primaryOutcome = "primary fixture cleanup threw";
        } finally {
          // The unrelated sentinel is verified and removed even when the primary
          // fixture cleanup refused or threw; both outcomes are reported apart.
          let sentinelOutcome = "sentinel fixture cleanup not attempted";
          try {
            if (sentinelAgentId) {
              const sentinel = await client.query(
                "SELECT id, key, name, metadata, updated_at FROM agents WHERE id = $1::uuid",
                [sentinelAgentId],
              );
              const sentinelRow = sentinel.rows[0];
              if (
                sentinel.rowCount !== 1 ||
                !sentinelRow ||
                sentinelRow.key !== sentinelPlan.namespace + ":agent" ||
                sentinelRow.metadata?.purpose !== `${sentinelNamespace}:sentinel`
              ) {
                failures.push("The unrelated sentinel agent changed during primary fixture cleanup");
              } else if (new Date(sentinelRow.updated_at).toISOString() !== sentinelUpdatedAtIso) {
                failures.push("The unrelated sentinel agent timestamp changed during primary fixture cleanup");
              }
            }

            const sentinelCleanup = await runLiveFixtureCleanup(client, sentinelPlan, opts);
            if (!sentinelCleanup.connectionReusable) discardClient();
            if (sentinelCleanup.attempted && !sentinelCleanup.ok) {
              failures.push(`sentinel fixture cleanup failed: ${sentinelCleanup.failures.join("; ")}`);
            }
            if (!sentinelCleanup.attempted) await reportLiveFixtureResidue(client, sentinelPlan);
            sentinelOutcome = !sentinelCleanup.attempted
              ? `sentinel fixture cleanup refused (${sentinelCleanup.refusal})`
              : sentinelCleanup.ok
                ? "sentinel fixture cleanup verified"
                : "sentinel fixture cleanup failed";
          } catch (error) {
            failures.push(`sentinel fixture cleanup threw: ${describeCleanupError(error)}`);
            sentinelOutcome = "sentinel fixture cleanup threw";
          }

          if (failures.length) {
            throw new Error(`Guarded crash-test cleanup failed - ${primaryOutcome}; ${sentinelOutcome}: ${failures.join("; ")}`);
          }
        }
      });
    } finally {
      db = undefined;
      identityVerified = false;
      schemaVerified = false;
    }
  }

  installAfterEachCleanup(afterEach, async () => {
    try {
      await cleanupFixturesAndCheckSentinel();
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalNodeEnv;
      if (originalGithubRepository === undefined) delete process.env.GITHUB_REPOSITORY; else process.env.GITHUB_REPOSITORY = originalGithubRepository;
      if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = originalGithubToken;
    }
  });

  it("recovers one issue in a fresh process after the originating executor is terminated", async () => {
    if (!liveConfig.databaseUrl || !liveConfig.identity || !testRepo || !testToken) {
      throw new Error("Isolated GitHub/Postgres integration configuration is incomplete");
    }
    const [owner, repository] = testRepo.split("/");
    originalNodeEnv = process.env.NODE_ENV;
    originalGithubRepository = process.env.GITHUB_REPOSITORY;
    originalGithubToken = process.env.GITHUB_TOKEN;
    process.env.NODE_ENV = "test";
    process.env.GITHUB_REPOSITORY = testRepo;
    process.env.GITHUB_TOKEN = testToken;

    db = new Pool({ connectionString: liveConfig.databaseUrl });
    await verifyLiveDatabaseTestIdentity(db, liveConfig);
    identityVerified = true;
    await verifyFixtureSchema(db as unknown as LiveCleanupClient);
    schemaVerified = true;

    namespace = `github-crash-recovery-${uuidv4()}`;
    sentinelNamespace = `${namespace}-sentinel`;
    Object.assign(fixturePlan, { namespace });
    Object.assign(sentinelPlan, { namespace: sentinelNamespace });
    originAgentId = uuidv4();
    reconcilerAgentId = uuidv4();
    sentinelAgentId = uuidv4();
    intentId = uuidv4();
    stepId = uuidv4();
    siblingStepId = uuidv4();
    episodeId = `${intentId}:${stepId}`;
    Object.assign(fixturePlan, {
      agentIds: [originAgentId, reconcilerAgentId],
      intentIds: [intentId],
      stepIds: [stepId, siblingStepId],
      episodeIds: [episodeId],
    });
    Object.assign(sentinelPlan, { agentIds: [sentinelAgentId] });

    const siblingBefore = {
      status: "pending",
      stepNumber: 1,
      description: `${namespace} sibling step`,
      dependencies: [] as unknown[],
    };
    const sentinelBefore = { name: `${sentinelNamespace} sentinel`, metadata: { purpose: `${sentinelNamespace}:sentinel` } };
    const seed = await db.connect();
    try {
      await verifyLiveDatabaseTestIdentity(seed, liveConfig);
      await seed.query("BEGIN");
      await seed.query("INSERT INTO agents (id, key, name, metadata) VALUES ($1, $2, $3, $4)", [originAgentId, `${namespace}:origin`, `${namespace} origin agent`, { purpose: namespace }]);
      await seed.query("INSERT INTO agents (id, key, name, metadata) VALUES ($1, $2, $3, $4)", [reconcilerAgentId, `${namespace}:reconciler`, `${namespace} recovery agent`, { purpose: namespace }]);
      await seed.query("INSERT INTO agents (id, key, name, metadata) VALUES ($1, $2, $3, $4)", [sentinelAgentId, `${sentinelNamespace}:agent`, sentinelBefore.name, sentinelBefore.metadata]);
      await seed.query("INSERT INTO intents (id, agent_id, intent_statement, status, metadata) VALUES ($1, $2, $3, 'open', $4)", [intentId, originAgentId, `${namespace} create one controlled issue`, { purpose: namespace }]);
      await seed.query("INSERT INTO intent_steps (id, intent_id, step_number, description, dependencies, status) VALUES ($1, $2, 0, $3, '[]'::jsonb, 'pending')", [stepId, intentId, `${namespace} issue step`]);
      await seed.query("INSERT INTO intent_steps (id, intent_id, step_number, description, dependencies, status) VALUES ($1, $2, $3, $4, $5::jsonb, $6)", [siblingStepId, intentId, siblingBefore.stepNumber, siblingBefore.description, JSON.stringify(siblingBefore.dependencies), siblingBefore.status]);
      await seed.query("INSERT INTO episodes (episode_id, narrative, outcome, status) VALUES ($1, $2, 'pending', 'pending')", [episodeId, `${namespace}: prepared recovery episode`]);
      await seed.query("COMMIT");
    } catch (error) {
      await seed.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      seed.release();
    }

    const siblingSnapshotResult = await db.query(
      "SELECT id, intent_id, step_number, description, dependencies, status, updated_at FROM intent_steps WHERE id = $1::uuid AND intent_id = $2::uuid",
      [siblingStepId, intentId],
    );
    expect(siblingSnapshotResult.rowCount).toBe(1);
    const siblingSnapshot = siblingSnapshotResult.rows[0];
    const sentinelSnapshotResult = await db.query(
      "SELECT id, key, name, metadata, updated_at FROM agents WHERE id = $1::uuid",
      [sentinelAgentId],
    );
    expect(sentinelSnapshotResult.rowCount).toBe(1);
    const sentinelSnapshot = sentinelSnapshotResult.rows[0];
    sentinelUpdatedAtIso = new Date(sentinelSnapshot.updated_at).toISOString();

    const recoveryAgentCheck = await db.query(
      "SELECT id FROM agents WHERE id = $1::uuid AND key = $2",
      [reconcilerAgentId, `${namespace}:reconciler`],
    );
    expect(recoveryAgentCheck.rowCount).toBe(1);
    // Ownership is carried by two distinct seeded agent records: the origin agent
    // that authorized the action and the separate reconciler identity that
    // recovers it. The worker also refuses to run when both ids are equal.
    const originAgentCheck = await db.query(
      "SELECT id FROM agents WHERE id = $1::uuid AND key = $2",
      [originAgentId, `${namespace}:origin`],
    );
    expect(originAgentCheck.rowCount).toBe(1);

    const args = {
      owner,
      repository,
      title: `Agent MCP controlled crash recovery ${new Date().toISOString()} ${uuidv4().slice(0, 8)}`,
      body: `${namespace} automated test issue. It is intentionally left open for audit; no action is required.`,
    };
    const previousIntentService = getIntentService();
    const previousResourceService = getResourceService();
    const previousVerifierRegistry = getVerifierRegistry();
    const testDatabaseClient = new DatabaseClient(db);
    try {
      const testIntentService = new IntentService(testDatabaseClient);
      await testIntentService.loadFromDatabase();
      const testResourceService = new ResourceService(testDatabaseClient);
      await testResourceService.loadFromDatabase();
      setIntentService(testIntentService);
      setResourceService(testResourceService);
      const testVerifierRegistry = new VerifierRegistry();
      testVerifierRegistry.registerProduction(GITHUB_CREATE_ISSUE, new GitHubIssueVerifier(testToken));
      setVerifierRegistry(testVerifierRegistry);
      const prepare = getActionProtocolTools(testDatabaseClient).find((tool) => tool.name === "prepare_action");
      if (!prepare) throw new Error("Existing prepare_action MCP tool was not registered");
      const prepared = await prepare._handler({ intent_id: intentId, step_id: stepId, action_type: GITHUB_CREATE_ISSUE, arguments: args });
      idemKey = prepared.idempotency_key;
    } finally {
      setIntentService(previousIntentService);
      setResourceService(previousResourceService);
      setVerifierRegistry(previousVerifierRegistry);
    }
    fixturePlan.actionKeys.push(idemKey);
    expect(idemKey).toMatch(/^[a-f0-9]{64}$/);
    const coordinator = new ActionCoordinator(db, originAgentId, 120);
    const initialAction = await db.query("SELECT id FROM actions WHERE idempotency_key = $1", [idemKey]);
    expect(initialAction.rowCount).toBe(1);
    physicalActionId = initialAction.rows[0].id;

    // production DATABASE_URL stays untouched in the child environment, so the
    // child's own isolation guard has to prove TEST_DATABASE_URL is a different
    // database; the worker exits non-zero instead of writing when it cannot.
    const childBaseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "test",
      RUN_LIVE_DB_TESTS: "1",
      RUN_GITHUB_CRASH_RECOVERY_TEST: "1",
      TEST_GITHUB_REPOSITORY: testRepo,
      TEST_GITHUB_TOKEN: testToken,
      GITHUB_REPOSITORY: testRepo,
      CRASH_RECOVERY_ACTION_KEY: idemKey,
      CRASH_RECOVERY_AGENT_ID: originAgentId,
      CRASH_RECOVERY_RECONCILER_ID: reconcilerAgentId,
    };

    let crashExit: any;
    try {
      await execFileAsync(process.execPath, ["--import", "tsx", "tests/recovery-engine/github-crash-recovery-worker.ts"], {
        cwd: process.cwd(), env: { ...childBaseEnv, CRASH_RECOVERY_MODE: "execute" }, timeout: 90_000, maxBuffer: 20_000,
      });
    } catch (error: any) {
      crashExit = error;
    }
    expect(crashExit?.code).toBe(86);
    expect(String(crashExit?.stdout ?? "")).toBe("");

    const afterOriginExit = await db.query(
      "SELECT id, status, effect_state FROM actions WHERE idempotency_key = $1",
      [idemKey],
    );
    expect(afterOriginExit.rowCount).toBe(1);
    expect(afterOriginExit.rows[0].id).toBe(physicalActionId);
    expect(afterOriginExit.rows[0].status).toBe("PENDING");
    expect(afterOriginExit.rows[0].effect_state).toBe("IN_PROGRESS");
    await db.query("UPDATE actions SET lease_expires_at = now() - interval '1 second' WHERE idempotency_key = $1 AND status = 'PENDING' AND effect_state = 'IN_PROGRESS'", [idemKey]);

    const registeredRecoveryAgent = await db.query(
      "SELECT id FROM agents WHERE id = $1::uuid AND key = $2",
      [reconcilerAgentId, `${namespace}:reconciler`],
    );
    expect(registeredRecoveryAgent.rowCount).toBe(1);
    let workerStdout = "";
    let recoveredEvidence: any[] = [];
    try {
      const worker = await execFileAsync(process.execPath, ["--import", "tsx", "tests/recovery-engine/github-crash-recovery-worker.ts"], {
        cwd: process.cwd(), env: { ...childBaseEnv, CRASH_RECOVERY_MODE: "recover" }, timeout: 90_000, maxBuffer: 20_000,
      });
      workerStdout = String(worker.stdout ?? "");
    } finally {
      // Evidence is written inside the recovery transaction itself, so it is
      // tracked here - immediately after recovery and before any assertion that
      // can fail - to keep the guarded cleanup able to delete exactly these rows.
      const trackedEvidence = await db.query(
        `SELECT ae.id, ae.source, ae.evidence_type, ae.external_reference, ae.payload
           FROM action_evidence ae
           JOIN actions a ON a.id = ae.action_id
          WHERE a.idempotency_key = $1
          ORDER BY ae.id`,
        [idemKey],
      );
      recoveredEvidence = trackedEvidence.rows;
      for (const trackedRow of recoveredEvidence) {
        fixturePlan.actionEvidenceIds?.push(String(trackedRow.id));
      }
    }
    const workerResult = parseWorkerJson(workerStdout, [
      "mode", "claimed", "status", "effectState", "externalRef", "postAttemptsDuringRecovery",
    ]);
    expect(workerResult.mode).toBe("recover");
    expect(workerResult.claimed).toBe(true);
    expect(workerResult.status).toBe("COMMITTED");
    expect(workerResult.effectState).toBe("APPLIED");
    expect(workerResult.postAttemptsDuringRecovery).toBe(0);

    const final = await db.query(
      `SELECT a.id, a.status, a.effect_state, a.external_reference, a.outcome, a.arguments AS action_arguments,
              e.episode_id, e.narrative, e.outcome AS episode_outcome, e.status AS episode_status,
              i.agent_id AS intent_agent_id, s.id AS action_step_id, s.intent_id AS action_step_intent_id,
              s.status AS step_status, i.status AS intent_status,
              sibling.status AS sibling_status, sibling.step_number AS sibling_step_number,
              sibling.description AS sibling_description, sibling.dependencies AS sibling_dependencies,
              sibling.updated_at AS sibling_updated_at
         FROM actions a
         JOIN episodes e ON e.episode_id = a.episode_id
         JOIN intent_steps s ON s.id = split_part(a.episode_id, ':', 2)::uuid
         JOIN intents i ON i.id = split_part(a.episode_id, ':', 1)::uuid
         JOIN intent_steps sibling ON sibling.id = $2::uuid AND sibling.intent_id = i.id
        WHERE a.idempotency_key = $1`,
      [idemKey, siblingStepId],
    );
    expect(final.rowCount).toBe(1);
    const row = final.rows[0];
    expect(row.id).toBe(physicalActionId);
    expect(row.status).toBe("COMMITTED");
    expect(row.effect_state).toBe("APPLIED");
    expect(row.external_reference).toMatch(/^\d+$/);
    expect(row.episode_id).toBe(episodeId);
    expect(row.intent_agent_id).toBe(originAgentId);
    expect(row.action_step_id).toBe(stepId);
    expect(row.action_step_intent_id).toBe(intentId);
    // Ownership survives recovery in the action arguments and the untouched
    // sibling step; the seeded narrative does not, because production replaces it.
    expect(row.action_arguments.body).toContain(namespace);
    // The narrative is now the truthful recovery account written by commitAtomic.
    expect(row.narrative).toMatch(
      new RegExp(
        `^Action ${GITHUB_CREATE_ISSUE.replace(/\./g, "\\.")} was verified as applied after the originating process failed ` +
          `before recording it\\. Recovered by reconciler on attempt \\d+\\. ` +
          `Evidence: GitHub repository API confirmed the issue and correlation marker$`,
      ),
    );
    const issueNumber = Number(row.external_reference);
    // GitHub owns the canonical URL casing, so assert its shape and repository
    // path case-insensitively instead of rebuilding an expected string.
    const issueUrl = new URL(String(row.outcome.html_url));
    expect(issueUrl.protocol).toBe("https:");
    expect(issueUrl.hostname).toBe("github.com");
    expect(issueUrl.pathname.toLowerCase()).toBe(`/${testRepo}/issues/${issueNumber}`.toLowerCase());
    expect(row.outcome.issue_number).toBe(issueNumber);
    expect(workerResult.externalRef).toBe(row.external_reference);
    expect(row.episode_outcome).toBe("recovered");
    expect(row.episode_status).toBe("resolved");
    expect(row.step_status).toBe("done");
    expect(row.intent_status).toBe("open");
    expect(row.sibling_status).toBe(siblingBefore.status);
    expect(row.sibling_step_number).toBe(siblingBefore.stepNumber);
    expect(row.sibling_description).toBe(siblingSnapshot.description);
    expect(row.sibling_dependencies).toEqual(siblingSnapshot.dependencies);
    expect(new Date(row.sibling_updated_at).toISOString()).toBe(new Date(siblingSnapshot.updated_at).toISOString());

    const finalAction = await coordinator.load(idemKey);
    expect(finalAction).toBeDefined();
    const marker = githubMarker(finalAction as Action);
    const confirmation = await new GitHubIssueVerifier(testToken).verify(finalAction as Action);
    expect(confirmation.disposition).toBe(VerdictDisposition.Applied);
    expect(confirmation.externalRef).toBe(String(issueNumber));
    // Compare against the URL GitHub returned for this issue, not a rebuilt string.
    expect(confirmation.outcome.html_url).toBe(row.outcome.html_url);
    expect(recoveredEvidence).toHaveLength(1);
    const evidenceRow = recoveredEvidence[0];
    evidenceId = String(evidenceRow.id);
    expect(fixturePlan.actionEvidenceIds).toEqual([evidenceId]);
    expect(evidenceRow.source).toBe(GITHUB_CREATE_ISSUE);
    expect(evidenceRow.evidence_type).toBe("verified_external_effect");
    expect(evidenceRow.external_reference).toBe(String(issueNumber));
    // Production persists the stable label, never the VerdictDisposition ordinal.
    expect(evidenceRow.payload.disposition).toBe(verdictDispositionToString(VerdictDisposition.Applied));
    expect(evidenceRow.payload.reason).toContain("correlation marker");
    expect(evidenceRow.payload.correlationMarker).toBe(marker);
    expect(evidenceRow.payload.outcome.issue_number).toBe(issueNumber);
    expect(evidenceRow.payload.outcome.html_url).toBe(row.outcome.html_url);

    const sentinelCheck = await db.query("SELECT id, key, name, metadata, updated_at FROM agents WHERE id = $1::uuid", [sentinelAgentId]);
    expect(sentinelCheck.rowCount).toBe(1);
    expect(sentinelCheck.rows[0].key).toBe(sentinelSnapshot.key);
    expect(sentinelCheck.rows[0].name).toBe(sentinelSnapshot.name);
    expect(sentinelCheck.rows[0].metadata).toEqual(sentinelSnapshot.metadata);
    expect(new Date(sentinelCheck.rows[0].updated_at).toISOString()).toBe(new Date(sentinelSnapshot.updated_at).toISOString());

    // Exercise the repository's authorized cleanup and prove its exact fixture
    // deletes leave an unrelated sentinel untouched before its own cleanup.
    await cleanupFixturesAndCheckSentinel();
  }, 120_000);
});
