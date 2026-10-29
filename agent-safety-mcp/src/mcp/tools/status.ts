/**
 * Status & Query Tools
 */

import { AgentService } from "../../core/agent.service";
import { IntentService } from "../../conflict-engine/intent.service";

export interface ToolWithHandler {
  name: string;
  description?: string;
  inputSchema: any;
  _handler: (args: any) => Promise<any>;
}

export function getStatusQueryTools(
  agentService: AgentService,
  intentService: IntentService
): ToolWithHandler[] {
  const tools: ToolWithHandler[] = [];

  tools.push({
    name: "get_intent_status",
    description: "Get detailed status of an intent",
    inputSchema: {
      type: "object",
      properties: {
        intentId: { type: "string" },
        agentId: { type: "string" },
      },
      required: ["intentId"],
    },
    _handler: async (args: any) => {
      const intent = intentService.getIntent(args.intentId);
      if (!intent) throw new Error(`Intent not found: ${args.intentId}`);

      return {
        intent,
        steps: intentService.getIntentSteps(args.intentId),
        reads: intentService.getIntentReads(args.intentId),
        status: intent.status,
      };
    },
  });

  // NOTE: get_action_status is registered in actions.ts (getActionProtocolTools)
  // to provide the complete implementation with ActionCoordinator.
  // Removed duplicate stub here to avoid MCP tool name collision.

  tools.push({
    name: "query_open_work",
    description: "Get summary of all open intents and in-flight actions",
    inputSchema: {
      type: "object",
      properties: { agentId: { type: "string" } },
      required: ["agentId"],
    },
    _handler: async (args: any) => {
      const openIntents = intentService.getOpenIntents();
      const filtered = args.agentId
        ? openIntents.filter((i) => i.agentId === args.agentId)
        : openIntents;

      return {
        openIntents: filtered,
        totalThreatened: filtered.length,
      };
    },
  });

  return tools;
}


