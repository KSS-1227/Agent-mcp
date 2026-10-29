/**
 * Agent Management Tools - thin interface to AgentService
 * 
 * Maps MCP tool inputs to AgentService methods.
 * No business logic here—all logic stays in AgentService.
 */

import { AgentService } from "../../core/agent.service";

export interface ToolWithHandler {
  name: string;
  description?: string;
  inputSchema: any;
  _handler: (args: any) => Promise<any>;
}

export function getAgentServiceTools(service: AgentService): ToolWithHandler[] {
  const tools: ToolWithHandler[] = [];

  // register_agent - Register a new agent with Agent Safety
  tools.push({
    name: "register_agent",
    description: "Register a new AI agent with Agent Safety",
    inputSchema: {
      type: "object",
      properties: {
        agent_key: {
          type: "string",
          description: "External agent identifier (e.g., 'coding-agent-1')",
        },
        name: {
          type: "string",
          description: "Human-readable agent name (e.g., 'Coding Agent')",
        },
        metadata: {
          type: "object",
          description: "Optional metadata about the agent",
        },
      },
      required: ["agent_key", "name"],
    },
    _handler: async (args: any) => {
      // Call AgentService.registerAgent() with provided parameters
      const agent = await service.registerAgent(args.agent_key, args.name, args.metadata);

      // Return the persisted agent with all fields
      return {
        id: agent.id,
        key: agent.key,
        name: agent.name,
        metadata: agent.metadata,
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
      };
    },
  });

  // get_agent - Retrieve agent by ID
  tools.push({
    name: "get_agent",
    description: "Retrieve an agent by its UUID",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "Agent UUID",
        },
      },
      required: ["agent_id"],
    },
    _handler: async (args: any) => {
      const agent = service.getAgent(args.agent_id);
      if (!agent) throw new Error(`Agent not found: ${args.agent_id}`);
      return {
        id: agent.id,
        key: agent.key,
        name: agent.name,
        metadata: agent.metadata,
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
      };
    },
  });

  // list_agents - List all agents
  tools.push({
    name: "list_agents",
    description: "List all registered agents",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    _handler: async () => {
      const agents = service.listAgents();
      return {
        agents: agents.map((a) => ({
          id: a.id,
          key: a.key,
          name: a.name,
          metadata: a.metadata,
          createdAt: a.createdAt,
          updatedAt: a.updatedAt,
        })),
      };
    },
  });

  // update_agent - Update agent metadata
  tools.push({
    name: "update_agent",
    description: "Update an agent's metadata",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "Agent UUID",
        },
        metadata: {
          type: "object",
          description: "Updated metadata object",
        },
      },
      required: ["agent_id", "metadata"],
    },
    _handler: async (args: any) => {
      const agent = await service.updateAgent(args.agent_id, args.metadata);
      if (!agent) throw new Error(`Agent not found: ${args.agent_id}`);
      return {
        id: agent.id,
        key: agent.key,
        name: agent.name,
        metadata: agent.metadata,
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
      };
    },
  });

  return tools;
}


