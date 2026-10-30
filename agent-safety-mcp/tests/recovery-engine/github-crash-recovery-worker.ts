import { Pool } from "pg";
import { ActionCoordinator } from "../../src/recovery-engine/coordinator";
import { ActionReconciler } from "../../src/recovery-engine/reconciliation";
import { GITHUB_CREATE_ISSUE, GitHubIssueExecutor, GitHubIssueVerifier } from "../../src/recovery-engine/github-issue";
import { ProductionActionVerifierDispatcher, VerifierRegistry } from "../../src/recovery-engine/verifier_registry";
import { loadLiveDatabaseTestConfig, verifyLiveDatabaseTestIdentity } from "../helpers/live-db-guard";

class RecoveryTestEmbedder {
  readonly identity = { provider: "test", model: "crash-recovery-test-1024" };
  async embed(): Promise<number[]> { return new Array(1024).fill(0.01); }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing worker setting ${name}`);
  return value;
}

function writeResult(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV !== "test" || process.env.RUN_GITHUB_CRASH_RECOVERY_TEST !== "1") {
    throw new Error("Worker requires the explicit test-only opt-in");
  }
  const config = loadLiveDatabaseTestConfig(process.env, () => {});
  if (!config.enabled || !config.databaseUrl) throw new Error("Validated isolated test database is unavailable");
  const mode = required("CRASH_RECOVERY_MODE");
  const actionKey = required("CRASH_RECOVERY_ACTION_KEY");
  const originAgentId = required("CRASH_RECOVERY_AGENT_ID");
  const repository = required("TEST_GITHUB_REPOSITORY");
  if (process.env.GITHUB_REPOSITORY?.trim().toLowerCase() !== repository.toLowerCase()) {
    throw new Error("Worker repository target does not match the dedicated test repository");
  }
  const token = required("TEST_GITHUB_TOKEN");
  const db = new Pool({ connectionString: config.databaseUrl });

  try {
    await verifyLiveDatabaseTestIdentity(db, config);

    if (mode === "execute") {
      const coordinator = new ActionCoordinator(db, originAgentId, 120);
      const action = await coordinator.load(actionKey);
      if (!action || action.actionType !== GITHUB_CREATE_ISSUE || !action.leaseOwner) {
        throw new Error("Prepared GitHub issue action is unavailable");
      }
      await coordinator.authorizeEffectStart(actionKey, action.leaseOwner);
      const authorized = await coordinator.load(actionKey);
      if (!authorized) throw new Error("Authorized action could not be reloaded");

      // This test-only adapter performs the real POST, then terminates this
      // process before returning the successful response to GitHubIssueExecutor.
      // The production executor and verifier have no fault-injection API.
      const terminateAfterCreate: typeof fetch = async (input, init) => {
        const response = await fetch(input, init);
        if (init?.method === "POST" && response.ok) {
          process.stderr.write(`Test executor observed accepted GitHub POST (${response.status}); terminating origin process\n`);
          process.exit(86);
        }
        return response;
      };
      const verdict = await new GitHubIssueExecutor(token, terminateAfterCreate)
        .execute({ ...authorized, effectState: "IN_PROGRESS" });
      writeResult({ mode, unexpectedReturn: true, disposition: verdict.disposition });
      return;
    }

    if (mode === "recover") {
      const reconcilerId = required("CRASH_RECOVERY_RECONCILER_ID");
      if (reconcilerId === originAgentId) throw new Error("Originating and recovery agents must be distinct");
      const registeredAgent = await db.query("SELECT id FROM agents WHERE id = $1::uuid", [reconcilerId]);
      if (registeredAgent.rowCount !== 1) throw new Error("Recovery agent fixture was not persisted");
      const coordinator = new ActionCoordinator(db, reconcilerId, 120);

      let postAttemptsDuringRecovery = 0;
      const verifierFetch: typeof fetch = async (input, init) => {
        if (init?.method === "POST") {
          postAttemptsDuringRecovery++;
          throw new Error("Recovery verifier attempted a GitHub POST");
        }
        return fetch(input, init);
      };
      const registry = new VerifierRegistry();
      registry.registerProduction(GITHUB_CREATE_ISSUE, new GitHubIssueVerifier(token, verifierFetch));
      const reconciler = new ActionReconciler(
        db,
        coordinator,
        new ProductionActionVerifierDispatcher(registry),
        new RecoveryTestEmbedder(),
        reconcilerId,
        120,
      );
      const claimed = await reconciler.reconcileAction(actionKey);
      const action = await coordinator.load(actionKey);
      writeResult({
        mode,
        claimed,
        status: action?.status,
        effectState: action?.effectState,
        externalRef: action?.externalRef,
        postAttemptsDuringRecovery,
      });
      return;
    }

    throw new Error("Unknown worker mode");
  } finally {
    await db.end();
  }
}

main().catch(() => {
  // Keep credentials, authorization headers, database URLs, and issue details
  // out of stdout and diagnostics.
  process.stderr.write("GitHub crash recovery worker failed\n");
  process.exitCode = 1;
});
