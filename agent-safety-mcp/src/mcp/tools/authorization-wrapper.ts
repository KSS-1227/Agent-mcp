/**
 * Tool Authorization Wrapper
 *
 * Middleware that enforces authorization for MCP tools before execution.
 * Integrates with the authorization module to check ownership and role restrictions.
 *
 * Usage: Wrap tool handlers and tool definitions with authorization enforcement.
 */

import {
  verifyAgentExists,
  checkAgentOwnership,
  checkSystemAgent,
  checkReadAccess,
  checkWriteAccess,
  extractAndVerifyCallingAgent,
} from "../../auth/authorization";
import {
  checkTaskOwnership,
  checkIntentOwnership,
  checkActionOwnership,
} from "./authorization-checkers";

export interface ToolWithHandler {
  name: string;
  description?: string;
  inputSchema: any;
  _handler: (args: any) => Promise<any>;
}

export interface AuthRule {
  toolName: string;
  type: "none" | "caller-identity" | "owner" | "system" | "owner-via-parent" | "custom";
  ownerField?: string;
  parentType?: "task" | "intent" | "action";
  validationFn?: (args: any) => Promise<void>;
}

const TOOL_AUTH_RULES: Map<string, AuthRule> = new Map([
  ["register_agent", { toolName: "register_agent", type: "system" }],
  // Agent records form the shared registry used to discover registered agents.
  ["get_agent", { toolName: "get_agent", type: "none" }],
  ["list_agents", { toolName: "list_agents", type: "none" }],
  ["update_agent", { toolName: "update_agent", type: "owner", ownerField: "agent_id" }],

  ["create_task", { toolName: "create_task", type: "owner", ownerField: "agentId" }],
  ["get_task", { toolName: "get_task", type: "owner-via-parent", parentType: "task" }],
  ["update_task_status", { toolName: "update_task_status", type: "owner-via-parent", parentType: "task" }],
  ["list_tasks", { toolName: "list_tasks", type: "owner", ownerField: "agentId" }],

  ["prepare_action", { toolName: "prepare_action", type: "owner-via-parent", parentType: "intent" }],
  ["complete_action", { toolName: "complete_action", type: "owner-via-parent", parentType: "action" }],
  ["get_action_status", { toolName: "get_action_status", type: "owner-via-parent", parentType: "action" }],
  ["reconcile_action", { toolName: "reconcile_action", type: "system" }],

  ["declare_intent", { toolName: "declare_intent", type: "owner", ownerField: "agent_id" }],
  ["get_intent", { toolName: "get_intent", type: "owner-via-parent", parentType: "intent" }],
  ["list_intents", { toolName: "list_intents", type: "owner", ownerField: "agentId" }],
  ["append_intent_steps", { toolName: "append_intent_steps", type: "owner-via-parent", parentType: "intent" }],

  ["check_conflict", { toolName: "check_conflict", type: "owner-via-parent", parentType: "intent" }],
  ["check_threatened", { toolName: "check_threatened", type: "caller-identity" }],
  ["diff_intent_vs_resource", { toolName: "diff_intent_vs_resource", type: "owner-via-parent", parentType: "intent" }],
  ["adjudicate_conflict", { toolName: "adjudicate_conflict", type: "owner-via-parent", parentType: "intent" }],

  ["get_intent_status", { toolName: "get_intent_status", type: "owner-via-parent", parentType: "intent" }],
  ["query_open_work", { toolName: "query_open_work", type: "owner", ownerField: "agentId" }],

  // Resources are the shared, versioned coordination state consumed by all agents.
  ["register_resource", { toolName: "register_resource", type: "none" }],
  ["get_resource", { toolName: "get_resource", type: "none" }],
  ["list_resources", { toolName: "list_resources", type: "none" }],
  ["update_resource", { toolName: "update_resource", type: "none" }],
]);

export async function applyAuthRule(toolName: string, args: any, services?: any): Promise<void> {
  const rule = TOOL_AUTH_RULES.get(toolName);
  
  if (!rule) {
    throw new Error(`[403] Tool not authorized: ${toolName}`);
  }

  switch (rule.type) {
    case "none":
      return;

    case "caller-identity":
      extractAndVerifyCallingAgent(args);
      return;

    case "system":
      const systemAgentId = extractAndVerifyCallingAgent(args);
      checkSystemAgent(systemAgentId);
      return;

    case "owner":
      if (!rule.ownerField) {
        throw new Error(`[500] Authorization rule error: owner type requires ownerField`);
      }
      const callerId = extractAndVerifyCallingAgent(args);
      const ownerId = args[rule.ownerField];
      if (!ownerId) {
        throw new Error(`[400] Missing required field: ${rule.ownerField}`);
      }
      checkAgentOwnership(callerId, ownerId);
      return;

    case "owner-via-parent":
      const callerIdViaParent = extractAndVerifyCallingAgent(args);
      if (!services) {
        throw new Error(`[500] Services required for owner-via-parent authorization`);
      }
      
      if (rule.parentType === "task") {
        checkTaskOwnership(
          callerIdViaParent,
          args.taskId,
          services.taskService,
          args.taskKey
        );
      } else if (rule.parentType === "intent") {
        checkIntentOwnership(
          callerIdViaParent,
          args.intent_id ?? args.intentId,
          services.intentService
        );
      } else if (rule.parentType === "action") {
        await checkActionOwnership(callerIdViaParent, args.action_id, services.db);
      } else {
        throw new Error(`[500] Unknown parent type: ${rule.parentType}`);
      }
      return;

    case "custom":
      if (rule.validationFn) {
        await rule.validationFn(args);
      }
      return;

    default:
      throw new Error(`[500] Unknown authorization rule type: ${rule.type}`);
  }
}

export function withAuthorization(tool: ToolWithHandler, services?: any): ToolWithHandler {
  const originalHandler = tool._handler;
  return {
    ...tool,
    _handler: async (args: any) => {
      await applyAuthRule(tool.name, args, services);
      return originalHandler(args);
    },
  };
}

export function applyAuthorizationToTools(
  tools: ToolWithHandler[],
  services?: any
): ToolWithHandler[] {
  return tools.map((tool) => withAuthorization(tool, services));
}
