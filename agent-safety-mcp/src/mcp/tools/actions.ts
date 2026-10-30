/**
 * Action Protocol Tools - thin interface to Anchor action coordinator
 * 
 * Implements Phase 1 (INTEND) and Phase 3 (COMMIT) of the exactly-once action protocol.
 * Reuses existing ActionCoordinator for crash-safe semantics.
 */

import { ActionCoordinator } from "../../recovery-engine/coordinator";
import { ActionReconciler } from "../../recovery-engine/reconciliation";
import { getVerifierRegistry, ProductionActionVerifierDispatcher } from "../../recovery-engine/verifier_registry";
import { ActionDisposition, dispositionToString, ActionState, Receipt } from "../../recovery-engine/types";
import { getIntentService } from "../../conflict-engine/intent.service";
import { adjudicate } from "../../conflict-engine/detection";
import { getProvenanceGraph } from "../../conflict-engine/provenance";
import { IntentStatus } from "../../conflict-engine/types";
import { getAgentService } from "../../core/agent.service";
import type { AgentService } from "../../core/agent.service";
import { getResourceService } from "../../core/resource.service";
import { createDatabaseClient, DatabaseClient } from "../../database/client";
import { PlanStep } from "../../core/types";
import { v4 as uuidv4, validate as validateUUID } from "uuid";
import { assertConfiguredGithubRepository, githubRepository, githubToken, GITHUB_CREATE_ISSUE, GitHubIssueExecutor, validateCreateIssueArgs } from "../../recovery-engine/github-issue";
import { VerdictDisposition } from "../../recovery-engine/types";
import { TitanEmbedder } from "../../recovery-engine/titan-embedder";

export interface ToolWithHandler {
  name: string;
  description?: string;
  inputSchema: any;
  _handler: (args: any) => Promise<any>;
}

let cachedActionTools: ToolWithHandler[] | null = null;

const RECONCILER_AGENT_KEY = "agent-safety-reconciler";

/**
 * Intent states that are terminal under the existing state machine: these are
 * exactly the states that intent.service.ts records resolvedAt for. A resolved
 * intent must not create new actions.
 */
const TERMINAL_INTENT_STATUSES: ReadonlySet<string> = new Set<string>([
  IntentStatus.COMMITTED,
  IntentStatus.ABORTED,
]);

export async function resolveReconcilerAgentId(
  agentService: AgentService,
  pool: any
): Promise<string> {
  const agent =
    agentService.getAgentByKey(RECONCILER_AGENT_KEY) ??
    (await agentService.registerAgent(
      RECONCILER_AGENT_KEY,
      "Action Reconciler",
      { systemAgent: true, purpose: "action_reconciliation" }
    ));

  if (
    !agent ||
    !validateUUID(agent.id) ||
    agentService.getAgent(agent.id)?.key !== RECONCILER_AGENT_KEY
  ) {
    throw new Error("A valid registered reconciler agent is required");
  }

  const persisted = await pool.query(
    "SELECT id FROM agents WHERE id = $1",
    [agent.id]
  );
  if (persisted.rows[0]?.id?.toLowerCase() !== agent.id.toLowerCase()) {
    throw new Error("The reconciler agent is not registered in the database");
  }

  return agent.id;
}

export function getActionProtocolTools(database?: DatabaseClient): ToolWithHandler[] {
  if (!database && cachedActionTools) {
    return cachedActionTools;
  }

  // Get services using singleton pattern (same as other MCP tools)
  const intentService = getIntentService();
  const agentService = getAgentService();
  const resourceService = getResourceService();
  
  if (!database && !process.env.DATABASE_URL?.startsWith("postgresql://")) {
    throw new Error("DATABASE_URL must be set to a PostgreSQL connection string when no database client is supplied");
  }
  const db: DatabaseClient = database ?? createDatabaseClient({
    connectionString: process.env.DATABASE_URL,
  });

  const tools: ToolWithHandler[] = [];

  tools.push({
    name: "execute_github_issue",
    description: "Execute a prepared github.create_issue action once and verify it through GitHub",
    inputSchema: { type: "object", properties: { action_id: { type: "string" } }, required: ["action_id"] },
    _handler: async (args: any) => {
      if (typeof args.action_id !== "string" || !args.action_id.trim()) throw new Error("action_id is required");
      const token = githubToken();
      if (!token) throw new Error("GITHUB_TOKEN is required for github.create_issue");
      const pool = (db as any).pool;
      const lookup = new ActionCoordinator(pool, "system", 120);
      const action = await lookup.load(args.action_id);
      if (!action || action.actionType !== GITHUB_CREATE_ISSUE) throw new Error("Prepared github.create_issue action not found");
      validateCreateIssueArgs(action.actionArgs);
      assertConfiguredGithubRepository(action.actionArgs);
      if (action.status !== ActionState.Pending || action.effectState !== "NOT_STARTED" || !action.leaseOwner || !action.leaseExpires || action.leaseExpires.getTime() <= Date.now()) throw new Error("Action is not awaiting execution under a live lease");
      await lookup.authorizeEffectStart(action.idemKey, action.leaseOwner);
      const coordinator = new ActionCoordinator(pool, action.agentId, 120);
      const verdict = await new GitHubIssueExecutor(token).execute({ ...action, effectState: "IN_PROGRESS" });
      const receipt: Receipt = verdict.disposition === VerdictDisposition.Applied
        ? { externalRef: verdict.externalRef, outcome: { ...verdict.outcome, status: "success" } }
        : verdict.disposition === VerdictDisposition.NotApplied
          ? { externalRef: "", outcome: { ...verdict.outcome, status: "failed", reason: verdict.reason } }
          : { externalRef: "", outcome: { status: "unknown", reason: verdict.reason } };
      const result = await coordinator.completeWithLifecycle(action.idemKey, receipt);
      return { action_id: action.idemKey, status: result.action.status.toLowerCase(), effect_state: result.action.effectState, outcome: result.action.outcome };
    },
  });

  /**
   * prepare_action - Phase 1 of the exactly-once action protocol (INTEND)
   *
   * Creates a durable action record with deterministic idempotency key
   * before any external API call is made. Enables crash-safe recovery.
   *
   * The action is only prepared if:
   * 1. The intent exists and is not in a terminal state
   * 2. The step belongs to that intent
   * 3. The step is not invalidated, and deterministic conflict analysis does not
   *    list it as affected by a resource change since the intent was declared
   * 4. All inputs are valid
   *
   * Returns the action with idempotency_key and disposition.
   * If the same logical request is prepared again, returns the existing action
   * with disposition "ALREADY_COMMITTED" or "BUSY" depending on status.
   */
  tools.push({
    name: "prepare_action",
    description:
      "Prepare a durable action intent before execution (INTEND phase - Phase 1 of exactly-once protocol)",
    inputSchema: {
      type: "object",
      properties: {
        intent_id: {
          type: "string",
          description: "UUID of the intent declaring this action",
        },
        step_id: {
          type: "string",
          description: "UUID of the plan step this action executes",
        },
        action_type: {
          type: "string",
          description: "Type of action (e.g., send_email, scale_cluster)",
        },
        arguments: {
          type: "object",
          description: "Arguments to the action (must be JSON-serializable)",
        },
      },
      required: ["intent_id", "step_id", "action_type", "arguments"],
    },
    _handler: async (args: any) => {
      // 1. Validate UUID formats
      if (!validateUUID(args.intent_id)) {
        throw new Error(`Invalid intent_id UUID: ${args.intent_id}`);
      }
      if (!validateUUID(args.step_id)) {
        throw new Error(`Invalid step_id UUID: ${args.step_id}`);
      }

      // 2. Validate action_type is a non-empty string
      if (!args.action_type || typeof args.action_type !== "string") {
        throw new Error("action_type is required and must be a string");
      }
      if (args.action_type === GITHUB_CREATE_ISSUE) {
        validateCreateIssueArgs(args.arguments);
        if (!githubRepository()) throw new Error("GITHUB_REPOSITORY must be configured as owner/repository");
        assertConfiguredGithubRepository(args.arguments);
        if (!githubToken()) throw new Error("GITHUB_TOKEN is required for github.create_issue");
      }

      // 3. Validate arguments is a JSON-serializable object
      if (!args.arguments || typeof args.arguments !== "object") {
        throw new Error("arguments is required and must be an object");
      }

      try {
        JSON.stringify(args.arguments);
      } catch (err) {
        throw new Error(
          `arguments is not JSON-serializable: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }

      // 4. Verify intent exists
      const intent = intentService.getIntent(args.intent_id);
      if (!intent) {
        throw new Error(`Intent not found: ${args.intent_id}`);
      }

      // 4a. Terminal intents are resolved; they must not create new actions.
      if (TERMINAL_INTENT_STATUSES.has(intent.status)) {
        throw new Error(
          `Cannot prepare action: intent ${args.intent_id} is ${intent.status} and cannot accept new actions`
        );
      }

      // 5. Verify step belongs to this intent
      const steps: PlanStep[] = intentService.getIntentSteps(args.intent_id);
      const step = steps.find((s: PlanStep) => s.id === args.step_id);
      if (!step) {
        throw new Error(
          `Step not found in intent: step_id=${args.step_id}, intent_id=${args.intent_id}`
        );
      }

      // 6. Verify step is not invalidated by conflict
      if (step.status === "invalidated") {
        throw new Error(
          `Cannot prepare action: step is invalidated by conflict: ${args.step_id}`
        );
      }

      // 7. Deterministic conflict gate. Only provenance plus version tracking are
      // consulted here, so provider availability and model output can neither
      // authorize an action nor clear a conflict. This runs before any episode or
      // action row is written.
      const conflict = adjudicate(
        `prepare_action:${args.intent_id}:${args.step_id}`,
        args.intent_id,
        resourceService,
        intentService
      );
      if (conflict.affectedSteps.includes(step.seq)) {
        const causes = conflict.diff.changes
          .filter(
            (change) =>
              getProvenanceGraph().findDependentSteps(change.resourceId, [step])
                .length > 0
          )
          .map(
            (change) =>
              `${change.key} (v${change.thenVersion} -> v${change.nowVersion})`
          );
        throw new Error(
          `Cannot prepare action: step ${step.seq} depends on a resource that changed after the intent was declared` +
            `${causes.length > 0 ? `: ${causes.join(", ")}` : ""}. Re-read the resource and re-declare the intent before acting.`
        );
      }

      // 8. Use ActionCoordinator to prepare action with crash-safe semantics
      // The coordinator will:
      // - Generate deterministic idempotency key from intent_id + step_id + action_type + arguments
      // - Insert action record with uniqueness constraint for deduplication
      // - Return disposition (Owned, AlreadyCommitted, Busy, etc.)

      // For in-memory testing, create a mock coordinator
      // In production, this would use the actual database pool
      let coordinator: ActionCoordinator;
      let pool: any;
      try {
        // Try to get the pool from the database client
        pool = (db as any).pool;
        coordinator = new ActionCoordinator(pool, intent.agentId, 120);
      } catch {
        // In-memory mock for testing
        // This is handled by tests that mock ActionCoordinator
        throw new Error(
          "Database connection required for prepare_action (not available in test environment)"
        );
      }

      // Use a combined "episode ID" that includes intent + step to ensure uniqueness
      const episodeId = `${args.intent_id}:${args.step_id}`;

      // Create the pending episode before inserting the action that references it.
      // The primary-key conflict is intentionally a no-op so retries and concurrent
      // prepares never replace an existing episode or its recovery data.
      await pool.query(
        `INSERT INTO episodes (episode_id, narrative, outcome, status)
         VALUES ($1, $2, 'pending', 'pending')
         ON CONFLICT (episode_id) DO NOTHING`,
        [episodeId, step.description]
      );

      const { action, disposition } = await coordinator.intendWithResourceSnapshot(
        episodeId,
        args.intent_id,
        args.action_type,
        args.arguments
      );

      if (disposition === ActionDisposition.Owned && args.action_type !== GITHUB_CREATE_ISSUE) {
        if (!action.leaseOwner) {
          throw new Error("Owned action is missing its lease owner");
        }
        // Non-GitHub actions are authorized for external execution here, so they
        // must pass the same serialization gate as execute_github_issue.
        await coordinator.authorizeEffectStart(action.idemKey, action.leaseOwner);
      }

      // Map ActionDisposition enum to string for MCP response
      const dispositionStr = dispositionToString(disposition);

      // Build response
      const response: any = {
        action_id: action.idemKey, // Use idemKey as the stable identifier
        intent_id: args.intent_id,
        step_id: args.step_id,
        action_type: action.actionType,
        idempotency_key: action.idemKey,
        status: action.status.toLowerCase(),
        disposition: dispositionStr,
        created_at: action.createdAt?.toISOString() || new Date().toISOString(),
      };

      // Include deduplication flag if action was not newly created
      if (
        disposition === ActionDisposition.AlreadyCommitted ||
        disposition === ActionDisposition.Busy ||
        disposition === ActionDisposition.Orphaned
      ) {
        response.deduplicated = true;
      }

      return response;
    },
  });

  /**
   * complete_action - Phase 3 of the exactly-once action protocol (COMMIT)
   *
   * Records the outcome of an action that has already been executed externally.
   * Atomically commits the action state and outcome to the database.
   *
   * This tool:
   * - Does NOT execute the external action (that must happen outside)
   * - Does NOT retry the external action
   * - Does record the execution outcome (success or failure)
   * - Preserves idempotency (repeated calls are safe)
   * - Persists state atomically with external reference and outcome
   * - On success, resolves the episode and marks the intent step done as part of
   *   that same commit
   *
   * The external caller is responsible for:
   * - Executing the action (using information from prepare_action)
   * - Capturing the outcome (response, error, etc.)
   * - Calling complete_action with the outcome
   *
   * Flow:
   *   1. prepare_action returns action_id + idempotency_key
   *   2. Caller executes external action using idempotency_key for idempotency
   *   3. Caller captures outcome
   *   4. Caller invokes complete_action with action_id + outcome
   *   5. This tool atomically persists the outcome
   *
   * Crash safety:
   *   - If the caller crashes between step 2 and 4: reconciler will detect orphaned PENDING action
   *   - If the caller crashes during step 5: database transaction rollback ensures no partial state
   *   - Repeated calls to complete_action with same action_id are idempotent
   */
  tools.push({
    name: "complete_action",
    description:
      "Record the outcome of an executed action (COMMIT phase - Phase 3 of exactly-once protocol)",
    inputSchema: {
      type: "object",
      properties: {
        agentId: {
          type: "string",
          description: "Calling agent identity; HTTP binds it from the verified JWT",
        },
        action_id: {
          type: "string",
          description: "The idempotency_key returned from prepare_action (or action UUID)",
        },
        outcome: {
          type: "object",
          description: "The execution outcome from the external action",
          properties: {
            status: {
              type: "string",
              description: "success, failed, or unknown. Use 'unknown' when the effect may have occurred but cannot be confirmed (e.g. network timeout). The reconciler will resolve unknown outcomes via external verification.",
            },
            external_id: {
              type: "string",
              description: "Optional external system ID (e.g., Stripe transaction ID)",
            },
            response: {
              type: "object",
              description: "Response data from external system",
            },
            error: {
              type: "string",
              description: "Error message if status is failed",
            },
            metadata: {
              type: "object",
              description: "Additional metadata about the execution",
            },
          },
          required: ["status"],
        },
      },
      required: ["action_id", "outcome"],
    },
    _handler: async (args: any) => {
      // 1. Validate action_id format (should be SHA256 hex or UUID)
      const actionId = args.action_id;
      if (!actionId || typeof actionId !== "string") {
        throw new Error("action_id is required and must be a string");
      }

      // 2. Validate outcome structure
      const outcome = args.outcome;
      if (!outcome || typeof outcome !== "object") {
        throw new Error("outcome is required and must be an object");
      }

      if (!outcome.status || typeof outcome.status !== "string") {
        throw new Error("outcome.status is required and must be one of: success, failed, unknown");
      }

      if (!["success", "failed", "unknown"].includes(outcome.status)) {
        throw new Error('outcome.status must be one of: success, failed, unknown');
      }

      // 3. Ensure outcome is JSON-serializable
      try {
        JSON.stringify(outcome);
      } catch (err) {
        throw new Error(
          `outcome is not JSON-serializable: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }

      // 4. Load the existing action from database
      let coordinator: ActionCoordinator;
      try {
        const pool = (db as any).pool;
        const callerId = args.agentId || args.callingAgent || args.agent_id;
        if (typeof callerId !== "string" || callerId.length === 0) {
          throw new Error("Calling agent identity is required");
        }
        coordinator = new ActionCoordinator(pool, callerId, 120);
      } catch {
        throw new Error(
          "Database connection required for complete_action (not available in test environment)"
        );
      }
      const preparedAction = await coordinator.load(actionId);
      if (preparedAction?.actionType === GITHUB_CREATE_ISSUE) {
        throw new Error("github.create_issue receipts are accepted only from execute_github_issue after GitHub verification");
      }

      // 5. Build receipt from outcome — preserve all caller-supplied fields so
      //    nothing is silently dropped (e.g. reason, metadata, custom keys).
      const receipt: Receipt = {
        externalRef: outcome.external_id || "",
        outcome: { ...outcome, status: outcome.status },
      };

      // 6. Atomically commit through the same coordinator that owns action state.
      //    A successful outcome also resolves the episode and completes the intent
      //    step in the same transaction, so a COMMITTED action is never left next
      //    to an open episode or a pending step. Failed and unknown outcomes leave
      //    both records untouched; the parent intent status is never changed here.
      const { action, alreadyCommitted } = await coordinator.completeWithLifecycle(
        actionId,
        receipt
      );

      // 7. Return the authoritative persisted state, including on retries.
      return {
        action_id: action.idemKey,
        status: action.status.toLowerCase(),
        effect_state: action.effectState,
        ...(alreadyCommitted && { already_committed: true }),
        outcome: action.outcome,
        committed_at: action.resolvedAt?.toISOString(),
      };
    },
  });


  /**
   * get_action_status - Query the current status of an action (read-only)
   *
   * This tool provides read-only access to action status without any side effects.
   * It does NOT:
   * - Modify action state
   * - Acquire or extend leases
   * - Execute external actions
   * - Retry or reconcile actions
   * - Create or update any database records
   *
   * This is used for monitoring, polling, and verification of completed actions.
   * The action_id must be the idempotency_key returned from prepare_action.
   */
  tools.push({
    name: "get_action_status",
    description:
      "Query the current status of an action without any modifications (read-only)",
    inputSchema: {
      type: "object",
      properties: {
        action_id: {
          type: "string",
          description:
            "The idempotency_key returned from prepare_action (SHA256 hex string)",
        },
      },
      required: ["action_id"],
    },
    _handler: async (args: any) => {
      // 1. Validate action_id format
      const actionId = args.action_id;
      if (!actionId || typeof actionId !== "string") {
        throw new Error("action_id is required and must be a string");
      }

      if (actionId.trim().length === 0) {
        throw new Error("action_id cannot be empty");
      }

      // 2. Create coordinator for read-only access
      let coordinator: ActionCoordinator;
      try {
        const pool = (db as any).pool;
        coordinator = new ActionCoordinator(pool, "system", 120);
      } catch {
        throw new Error(
          "Database connection required for get_action_status (not available in test environment)"
        );
      }

      // 3. Load the action (read-only operation)
      // This queries the database but does NOT modify any state
      const action = await coordinator.load(actionId);

      // 4. Action not found - return error
      if (!action) {
        throw new Error(`Action not found: ${actionId}`);
      }

      // 5. Build response with current action status
      // Response uses snake_case for consistency with other MCP tools
      const response: any = {
        action_id: action.idemKey,
        episode_id: action.episodeId,
        agent_id: action.agentId,
        action_type: action.actionType,
        status: action.status.toLowerCase(),
        created_at: action.createdAt?.toISOString(),
        resolved_at: action.resolvedAt?.toISOString() || null,
      };

      // 6. Include lease information if action is PENDING
      if (action.status === ActionState.Pending) {
        response.lease_owner = action.leaseOwner;
        response.lease_expires = action.leaseExpires?.toISOString() || null;
        response.attempts = action.attempts;
      }

      // 7. Include outcome if action is resolved (COMMITTED or FAILED)
      if (
        action.status === ActionState.Committed ||
        action.status === ActionState.Failed
      ) {
        response.outcome = action.outcome;
        response.external_ref = action.externalRef;
      }

      // 8. Include arguments for reference
      response.arguments = action.actionArgs;

      return response;
    },
  });

  /**
   * reconcile_action - Recover from crash scenarios via external verification
   *
   * This tool invokes the Anchor reconciliation protocol for actions that may have
   * crashed mid-execution. It does NOT re-execute the external action; instead, it
   * queries an external system to determine what actually happened.
   *
   * Flow:
   *   1. Action is PENDING with expired lease (orphaned)
   *   2. Verifier queries external system for ground truth
   *   3. Based on verdict:
   *      - APPLIED: commitRecovered() ? COMMITTED
   *      - NOT_APPLIED: markFailed() ? FAILED
   *      - UNKNOWN: remain PENDING/UNKNOWN without automatic retry
   *
   * The verifier is server-side/pre-registered. MCP caller cannot submit arbitrary code.
   *
   * Input:
   *   action_id: The idempotency key (SHA256 hex) from prepare_action
   *   verifier_id: Deprecated compatibility field; ignored. The persisted action_type selects the verifier.
   *
   * Output:
   *   - APPLIED: { action_id, status: "committed", verdict: "applied", reconciled: true, ... }
   *   - NOT_APPLIED: { action_id, status: "failed", verdict: "not_applied", reconciled: true, ... }
   *   - UNKNOWN: { action_id, status: "pending", verdict: "unknown", reconciled: true, ... }
   */
  tools.push({
    name: "reconcile_action",
    description:
      "Recover from crash scenarios by verifying external ground truth (reconciliation phase)",
    inputSchema: {
      type: "object",
      properties: {
        action_id: {
          type: "string",
          description:
            "The idempotency_key returned from prepare_action (SHA256 hex string)",
        },
        verifier_id: {
          type: "string",
          description:
            "Deprecated and ignored. The production verifier is selected from the action's persisted action_type.",
        },
      },
      required: ["action_id"],
    },
    _handler: async (args: any) => {
      
      

      // 1. Validate action_id
      const actionId = args.action_id;
      if (!actionId || typeof actionId !== "string") {
        throw new Error("action_id is required and must be a string");
      }

      if (actionId.trim().length === 0) {
        throw new Error("action_id cannot be empty");
      }

      // 2. Create coordinator to load the action
      let coordinator: ActionCoordinator;
      let reconcilerAgentId: string;
      const pool = (db as any).pool;
      reconcilerAgentId = await resolveReconcilerAgentId(agentService, pool);
      try {
        coordinator = new ActionCoordinator(pool, reconcilerAgentId, 120);
      } catch {
        throw new Error(
          "Database connection required for reconcile_action (not available in test environment)"
        );
      }

      // 3. Load the existing action
      const action = await coordinator.load(actionId);
      if (!action) {
        throw new Error(`Action not found: ${actionId}`);
      }
      // 4. Check if action is eligible for reconciliation
      // APPLIED: Already resolved, return existing outcome (no re-verification needed)
      if (action.status === ActionState.Committed) {
        return {
          action_id: action.idemKey,
          status: action.status.toLowerCase(),
          verdict: "already_committed",
          reconciled: false, // Not newly reconciled, but already resolved
          outcome: action.outcome,
          external_ref: action.externalRef,
          message: "Action already committed from previous reconciliation or Phase 3",
        };
      }

      // NOT_APPLIED: Already marked failed, preserve terminal semantics
      if (action.status === ActionState.Failed) {
        return {
          action_id: action.idemKey,
          status: action.status.toLowerCase(),
          verdict: "already_failed",
          reconciled: false, // Not newly reconciled, terminal state
          outcome: action.outcome,
          message: "Action already marked as failed. Operator intervention required.",
        };
      }

      // 5. For PENDING actions, determine if eligible for reconciliation
      // According to Anchor: only reconciler may attempt recovery of orphaned actions
      // An action is orphaned if lease has expired
      if (action.status === ActionState.Pending) {
        const now = new Date();
        const isOrphaned =
          !action.leaseExpires || action.leaseExpires.getTime() <= now.getTime();

        if (!isOrphaned) {
          // Action is PENDING with active lease held by another agent
          return {
            action_id: action.idemKey,
            status: "pending",
            verdict: "busy",
            reconciled: false,
            message: `Action is currently being executed by ${action.leaseOwner}. Lease expires at ${action.leaseExpires?.toISOString()}`,
          };
        }
      }

      // 6. Dispatch using the persisted action type; caller input cannot select
      // a verifier for a different action type.
      const verifierRegistry = getVerifierRegistry();
      const verifier = new ProductionActionVerifierDispatcher(verifierRegistry);

      const reconciler = new ActionReconciler(
        (db as any).pool,
        coordinator,
        verifier,
        new TitanEmbedder(),
        reconcilerAgentId,
        120
      );

      // 8. Run reconciliation for this single action
      try {
        const claimed = await reconciler.reconcileAction(actionId);
        if (!claimed) {
          return {
            action_id: action.idemKey,
            status: "pending",
            verdict: "busy",
            reconciled: false,
            message: "Action lease was acquired by another reconciler",
          };
        }

        // 9. Reload the action to get the result
        const reconciledAction = await coordinator.load(actionId);
        if (!reconciledAction) {
          throw new Error(`Action disappeared during reconciliation: ${actionId}`);
        }

        // 10. Build response based on new state
        const response: any = {
          action_id: reconciledAction.idemKey,
          status: reconciledAction.status.toLowerCase(),
          reconciled: true,
          attempts: reconciledAction.attempts,
        };

        if (reconciledAction.status === ActionState.Committed) {
          response.verdict = "applied";
          response.outcome = reconciledAction.outcome;
          response.external_ref = reconciledAction.externalRef;
          response.resolved_at = reconciledAction.resolvedAt?.toISOString();
        } else if (reconciledAction.status === ActionState.Failed) {
          response.verdict = "not_applied";
          response.outcome = reconciledAction.outcome;
          response.message =
            reconciledAction.outcome?.reason ||
            "Action was verified as not applied";
          response.resolved_at = reconciledAction.resolvedAt?.toISOString();
        } else if (reconciledAction.status === ActionState.Pending) {
          response.verdict = "unknown";
          response.outcome = reconciledAction.outcome;
          response.lease_expires = reconciledAction.leaseExpires?.toISOString();
          response.message =
            reconciledAction.outcome?.reason ||
            "Could not establish external ground truth";
        }

        return response;
      } catch (error) {
        const errorMsg =
          error instanceof Error ? error.message : String(error);
        throw new Error(`Reconciliation failed: ${errorMsg}`);
      }
    },
  });
  if (!database) cachedActionTools = tools;
  return tools;
}







