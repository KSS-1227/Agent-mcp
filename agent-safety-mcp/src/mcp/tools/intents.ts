/**
 * Intent Declaration Tools - thin interface to IntentService
 * 
 * Implements DECLARE step of 5-step Interlock pipeline.
 * Maps MCP inputs to IntentService methods.
 * All business logic stays in IntentService.
 */

import { IntentService } from "../../conflict-engine/intent.service";
import { AgentService } from "../../core/agent.service";
import { ResourceService } from "../../core/resource.service";
import { TaskService } from "../../core/task.service";

export interface ToolWithHandler {
  name: string;
  description?: string;
  inputSchema: any;
  _handler: (args: any) => Promise<any>;
}

export function getIntentServiceTools(
  intentService: IntentService,
  agentService?: AgentService,
  resourceService?: ResourceService,
  taskService?: TaskService
): ToolWithHandler[] {
  const tools: ToolWithHandler[] = [];

  // declare_intent - Register agent intent before acting
  tools.push({
    name: "declare_intent",
    description:
      "Declare an agent's intent before acting (DECLARE step of Interlock 5-step pipeline)",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "UUID of the agent declaring the intent",
        },
        task_id: {
          type: "string",
          description: "UUID of the task this intent belongs to",
        },
        statement: {
          type: "string",
          description: "Natural language statement of what the agent intends to do",
        },
        reads: {
          type: "array",
          description: "Resources the agent has read and their observed versions",
          items: {
            type: "object",
            properties: {
              resource_id: { type: "string" },
              observed_version: { type: "number" },
            },
            required: ["resource_id", "observed_version"],
          },
        },
        plan_steps: {
          type: "array",
          description: "Plan steps the agent intends to execute",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              depends_on: {
                type: "array",
                description: "Resource IDs this step depends on; each must also appear in reads",
                items: { type: "string" },
              },
            },
            required: ["description"],
          },
        },
      },
      required: ["agent_id", "task_id", "statement"],
    },
    _handler: async (args: any) => {
      // Validate agent exists
      if (agentService) {
        const agent = agentService.getAgent(args.agent_id);
        if (!agent) {
          throw new Error(`Agent not found: ${args.agent_id}`);
        }
      }

      // Validate task exists
      if (taskService) {
        const task = taskService.getTask(args.task_id);
        if (!task) {
          throw new Error(`Task not found: ${args.task_id}`);
        }
      }

      // Validate resources exist and extract versions
      const reads: Array<{
        resourceId: string;
        observedVersion: number;
      }> = [];

      if (args.reads && Array.isArray(args.reads)) {
        for (const read of args.reads) {
          if (resourceService) {
            const resource = resourceService.getResource(read.resource_id);
            if (!resource) {
              throw new Error(`Resource not found: ${read.resource_id}`);
            }
          }

          reads.push({
            resourceId: read.resource_id,
            observedVersion: read.observed_version,
          });
        }
      }

      // Convert plan steps format
      const planSteps: Array<{
        description: string;
        dependsOn?: string[];
        embedding?: number[];
      }> = [];

      if (args.plan_steps && Array.isArray(args.plan_steps)) {
        for (const step of args.plan_steps) {
          planSteps.push({
            description: step.description,
            dependsOn: step.depends_on,
            embedding: step.embedding,
          });
        }
      }

      // Declare intent using IntentService
      const intent = await intentService.declareIntentPersisted(
        args.agent_id,
        args.task_id,
        args.statement,
        reads,
        planSteps,
        agentService?.getAgent(args.agent_id),
        taskService?.getTask(args.task_id)
      );

      // Get reads to return
      const intentReads = intentService.getIntentReads(intent.id);
      const intentSteps = intentService.getIntentSteps(intent.id);

      // Return structured response
      return {
        id: intent.id,
        agentId: intent.agentId,
        taskId: intent.taskId,
        statement: intent.statement,
        status: intent.status,
        reads: intentReads.map((r) => ({
          resourceId: r.resourceId,
          observedVersion: r.observedVersion,
        })),
        steps: intentSteps.map((s) => ({
          id: s.id,
          seq: s.seq,
          description: s.description,
          status: s.status,
          dependsOn: s.dependsOn,
        })),
        createdAt: intent.recordedAt,
        updatedAt: intent.recordedAt,
      };
    },
  });

  // get_intent - Retrieve intent by ID
  tools.push({
    name: "get_intent",
    description: "Retrieve an intent by its UUID",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        intent_id: {
          type: "string",
          description: "Intent UUID",
        },
      },
      required: ["intent_id"],
    },
    _handler: async (args: any) => {
      const intent = intentService.getIntent(args.intent_id);
      if (!intent) throw new Error(`Intent not found: ${args.intent_id}`);

      const reads = intentService.getIntentReads(args.intent_id);
      const steps = intentService.getIntentSteps(args.intent_id);

      return {
        id: intent.id,
        agentId: intent.agentId,
        taskId: intent.taskId,
        statement: intent.statement,
        status: intent.status,
        reads: reads.map((r) => ({
          resourceId: r.resourceId,
          observedVersion: r.observedVersion,
        })),
        steps: steps.map((s) => ({
          id: s.id,
          seq: s.seq,
          description: s.description,
          status: s.status,
          dependsOn: s.dependsOn,
        })),
        createdAt: intent.recordedAt,
        updatedAt: intent.recordedAt,
      };
    },
  });

  // list_intents - List intents by status
  tools.push({
    name: "list_intents",
    description: "List intents by status or all open intents",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        status: {
          type: "string",
          description: 'Filter by status (e.g., "open", "committed", "aborted")',
        },
      },
      required: ["agentId"],
    },
    _handler: async (args: any) => {
      let intents;
      if (args.status === "open") {
        intents = intentService.getOpenIntents();
      } else if (args.status) {
        intents = intentService.getIntentsByStatus(args.status);
      } else {
        intents = intentService.listIntents();
      }
      intents = intents.filter((intent) => intent.agentId === args.agentId);

      return {
        intents: intents.map((intent) => {
          const reads = intentService.getIntentReads(intent.id);
          const steps = intentService.getIntentSteps(intent.id);

          return {
            id: intent.id,
            agentId: intent.agentId,
            taskId: intent.taskId,
            statement: intent.statement,
            status: intent.status,
            readsCount: reads.length,
            stepsCount: steps.length,
            createdAt: intent.recordedAt,
          };
        }),
      };
    },
  });

  // append_intent_steps - Add more steps to an intent
  tools.push({
    name: "append_intent_steps",
    description: "Add more plan steps to an existing intent",
    inputSchema: {
      type: "object",
      properties: {
        intent_id: {
          type: "string",
          description: "Intent UUID",
        },
        steps: {
          type: "array",
          description: "Plan steps to append",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              depends_on: {
                type: "array",
                description: "Resource IDs this step depends on; each must be in the intent read set",
                items: { type: "string" },
              },
            },
            required: ["description"],
          },
        },
      },
      required: ["intent_id", "steps"],
    },
    _handler: async (args: any) => {
      const newSteps: Array<{
        description: string;
        dependsOn?: string[];
        embedding?: number[];
      }> = [];

      for (const step of args.steps || []) {
        newSteps.push({
          description: step.description,
          dependsOn: step.depends_on,
        });
      }

      const appended = await intentService.appendStepsPersisted(args.intent_id, newSteps);
      if (!appended) {
        throw new Error(`Intent not found: ${args.intent_id}`);
      }

      return {
        appended: appended.map((s) => ({
          id: s.id,
          seq: s.seq,
          description: s.description,
          status: s.status,
          dependsOn: s.dependsOn,
        })),
      };
    },
  });

  return tools;
}
