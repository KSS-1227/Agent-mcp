/**
 * Conflict Detection Tools - thin interface to Interlock conflict detection
 * 
 * Implements WATCH, DIFF, ADJUDICATE, and RESOLVE steps of the 5-step
 * Interlock pipeline. Maps MCP inputs to detection.ts functions.
 * All business logic stays in conflict detection services.
 */

import {
  findThreatened,
  diffForIntent,
  adjudicateWithGrok,
  resolve,
} from "../../conflict-engine/detection";
import { getProvenanceGraph } from "../../conflict-engine/provenance";
import { ResourceService } from "../../core/resource.service";
import { IntentService } from "../../conflict-engine/intent.service";
import { CommitLog } from "../../core/types";

export interface ToolWithHandler {
  name: string;
  description?: string;
  inputSchema: any;
  _handler: (args: any) => Promise<any>;
}

export function getConflictDetectionTools(
  resourceService: ResourceService,
  intentService: IntentService
): ToolWithHandler[] {
  const tools: ToolWithHandler[] = [];

  /**
   * check_conflict - Full conflict detection pipeline for an intent
   *
   * Takes an intent_id and runs the complete 5-step Interlock pipeline:
   * 1. DECLARE: intent already declared
   * 2. WATCH: check if any resources have changed (handled by checking versions)
   * 3. DIFF: show what changed since the intent was declared
   * 4. ADJUDICATE: determine if conflict is irrelevant/invalidating/fatal
   * 5. RESOLVE: (not applied in MCP, just analyzed)
   *
   * Returns structured response showing affected_steps vs preserved_steps.
   */
  tools.push({
    name: "check_conflict",
    description:
      "Check if an intent has unresolved conflicts using full Interlock pipeline (WATCH->DIFF->ADJUDICATE)",
    inputSchema: {
      type: "object",
      properties: {
        intent_id: {
          type: "string",
          description: "UUID of the intent to check for conflicts",
        },
      },
      required: ["intent_id"],
    },
    _handler: async (args: any) => {
      const intentId = args.intent_id;

      // Validate intent exists
      const intent = intentService.getIntent(intentId);
      if (!intent) {
        throw new Error(`Intent not found: ${intentId}`);
      }

      const allSteps = intentService.getIntentSteps(intentId);

      // DIFF: Compare intent snapshot with current resource versions
      const diff = diffForIntent(intentId, resourceService, intentService);

      // No changes detected - no conflict
      if (diff.changes.length === 0) {
        return {
          has_conflict: false,
          intent_id: intentId,
          verdict: "irrelevant",
          rationale: "No resources that this intent depends on have changed.",
          affected_steps: [],
          preserved_steps: allSteps.map((s) => ({
            seq: s.seq,
            description: s.description,
            status: s.status,
          })),
          changed_resources: [],
          steps_total: allSteps.length,
          model: "provenance-graph",
        };
      }

      // ADJUDICATE: Determine if the changes actually affect this intent plan
      try {
        // Use a synthetic commit ID for the adjudication
        const commitId = `synthetic-${intentId}-${Date.now()}`;
        const adjudication = await adjudicateWithGrok(
          commitId,
          intentId,
          resourceService,
          intentService
        );

        // Extract affected/preserved steps using provenance graph
        const changedResourceIds = diff.changes.map((c) => c.resourceId);
        
        const affectedSteps = getProvenanceGraph().findAffectedSteps(
          changedResourceIds,
          allSteps
        );
        const preservedSteps = getProvenanceGraph().findPreservedSteps(
          changedResourceIds,
          allSteps
        );

        return {
          has_conflict: adjudication.verdict !== "irrelevant",
          intent_id: intentId,
          verdict: adjudication.verdict,
          rationale: adjudication.rationale,
          affected_steps: affectedSteps.map((s) => ({
            seq: s.seq,
            description: s.description,
            status: s.status,
          })),
          preserved_steps: preservedSteps.map((s) => ({
            seq: s.seq,
            description: s.description,
            status: s.status,
          })),
          changed_resources: diff.changes.map((c) => ({
            resource_id: c.resourceId,
            resource_key: c.key,
            resource_type: c.kind,
            then_version: c.thenVersion,
            now_version: c.nowVersion,
          })),
          steps_total: allSteps.length,
          model: adjudication.model,
          ...(adjudication.providerError
            ? { provider_error: adjudication.providerError }
            : {}),
        };
      } catch (err) {
        // If adjudication fails, return the diff results with error
        return {
          has_conflict: true,
          intent_id: intentId,
          verdict: "unknown",
          rationale: `Could not complete adjudication: ${err instanceof Error ? err.message : String(err)}`,
          affected_steps: [],
          preserved_steps: allSteps.map((s) => ({
            seq: s.seq,
            description: s.description,
            status: s.status,
          })),
          changed_resources: diff.changes.map((c) => ({
            resource_id: c.resourceId,
            resource_key: c.key,
            resource_type: c.kind,
            then_version: c.thenVersion,
            now_version: c.nowVersion,
          })),
          steps_total: allSteps.length,
          model: "provenance-graph",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  /**
   * check_threatened - Watch step: find all threatened intents by a resource change
   *
   * Simulates what happens when a resource commit lands.
   * Returns list of intents that might be affected.
   */
  tools.push({
    name: "check_threatened",
    description:
      "Find all open intents threatened by a resource version change (WATCH step)",
    inputSchema: {
      type: "object",
      properties: {
        agentId: {
          type: "string",
          description: "UUID of the calling agent",
        },
        resource_id: {
          type: "string",
          description: "UUID of the resource that changed",
        },
        new_version: {
          type: "number",
          description: "New version number of the resource",
        },
      },
      required: ["agentId", "resource_id", "new_version"],
    },
    _handler: async (args: any) => {
      const resource = resourceService.getResource(args.resource_id);
      if (!resource) {
        throw new Error(`Resource not found: ${args.resource_id}`);
      }

      // Create synthetic commit log entry
      const commit: CommitLog = {
        id: `synthetic-${args.resource_id}-${Date.now()}`,
        agentId: "system",
        resourceId: args.resource_id,
        prevVersion: args.new_version - 1,
        newVersion: args.new_version,
        statement: "Resource version check",
        committedAt: new Date(),
      };

      // Run WATCH step
      const threatened = findThreatened(commit, intentService);
      const callerThreats = threatened.filter(
        (entry) => intentService.getIntent(entry.intentId)?.agentId === args.agentId
      );

      return {
        resource_id: args.resource_id,
        new_version: args.new_version,
        threatened_count: callerThreats.length,
        threatened_intents: callerThreats.map((t) => ({
          intent_id: t.intentId,
          detected_by: t.detectedBy,
        })),
      };
    },
  });

  /**
   * diff_intent_vs_resource - Diff step: show what changed for an intent
   *
   * Compares intent snapshot with current resource versions.
   * Returns list of resources that have changed since the intent was declared.
   */
  tools.push({
    name: "diff_intent_vs_resource",
    description: "Show what changed for an intent since it was declared (DIFF step)",
    inputSchema: {
      type: "object",
      properties: {
        intent_id: {
          type: "string",
          description: "Intent UUID",
        },
      },
      required: ["intent_id"],
    },
    _handler: async (args: any) => {
      const intent = intentService.getIntent(args.intent_id);
      if (!intent) {
        throw new Error(`Intent not found: ${args.intent_id}`);
      }

      const diff = diffForIntent(args.intent_id, resourceService, intentService);

      return {
        intent_id: args.intent_id,
        source: diff.source,
        changes_count: diff.changes.length,
        changes: diff.changes.map((c) => ({
          resource_id: c.resourceId,
          resource_key: c.key,
          resource_type: c.kind,
          then_version: c.thenVersion,
          now_version: c.nowVersion,
        })),
      };
    },
  });

  /**
   * adjudicate_conflict - Adjudicate step: determine if conflict invalidates the plan
   *
   * Takes an intent_id and returns adjudication verdict:
   * - "irrelevant": no steps depend on changed resources
   * - "invalidating": some steps depend on changed resources (selective repair needed)
   * - "fatal": fundamental premise gone (would abort)
   */
  tools.push({
    name: "adjudicate_conflict",
    description:
      "Determine if conflict invalidates the plan or is irrelevant (ADJUDICATE step)",
    inputSchema: {
      type: "object",
      properties: {
        intent_id: {
          type: "string",
          description: "Intent UUID",
        },
      },
      required: ["intent_id"],
    },
    _handler: async (args: any) => {
      const intent = intentService.getIntent(args.intent_id);
      if (!intent) {
        throw new Error(`Intent not found: ${args.intent_id}`);
      }

      const commitId = `synthetic-${args.intent_id}-${Date.now()}`;
      const adjudication = await adjudicateWithGrok(
        commitId,
        args.intent_id,
        resourceService,
        intentService
      );

      return {
        intent_id: args.intent_id,
        verdict: adjudication.verdict,
        rationale: adjudication.rationale,
        affected_steps: adjudication.affectedSteps,
        steps_total: adjudication.stepsTotal,
        model: adjudication.model,
        tokens_in: adjudication.tokensIn,
        tokens_out: adjudication.tokensOut,
        latency_ms: adjudication.latencyMs,
        ...(adjudication.providerError
          ? { provider_error: adjudication.providerError }
          : {}),
      };
    },
  });

  return tools;
}
