/**
 * Agent Service - Unified agent management for Anchor and Interlock
 *
 * Both systems share the same agent abstraction:
 * - Agents are identified by UUID (id) and external key
 * - An agent can declare intents, prepare actions, and perform reads
 */

import { v4 as uuidv4 } from "uuid";
import { Agent } from "./types";
import { DatabaseClient } from "../database/client";

export class AgentService {
  private agents = new Map<string, Agent>();
  private keyIndex = new Map<string, string>(); // key -> id mapping
  private db: DatabaseClient | null = null;

  constructor(db?: DatabaseClient) {
    this.db = db || null;
  }

  setDatabase(db: DatabaseClient): void {
    this.db = db;
  }

  async loadFromDatabase(): Promise<void> {
    if (!this.db) return;
    const result = await this.db.query(
      `SELECT id, key, name, metadata, created_at, updated_at
         FROM agents
        ORDER BY created_at, id`
    );
    this.agents.clear();
    this.keyIndex.clear();
    for (const row of result.rows) {
      const agent = this.toAgent(row);
      this.agents.set(agent.id, agent);
      this.keyIndex.set(agent.key, agent.id);
    }
  }

  /**
   * Register a new agent in the system.
   * Returns the created agent with its UUID.
   */
  registerAgent(
    agentKey: string,
    name: string,
    metadata?: Record<string, any>
  ): Agent | Promise<Agent> {
    // Check if agent already exists
    const existingId = this.keyIndex.get(agentKey);
    if (existingId) {
      const existing = this.agents.get(existingId);
      if (existing) return existing;
    }

    const id = uuidv4();
    const now = new Date();
    const agent: Agent = {
      id,
      key: agentKey,
      name,
      metadata,
      createdAt: now,
      updatedAt: now,
    };

    if (this.db) {
      return this.persistAgent(agent).then((persisted) => {
        this.agents.set(persisted.id, persisted);
        this.keyIndex.set(persisted.key, persisted.id);
        return persisted;
      });
    }

    this.agents.set(id, agent);
    this.keyIndex.set(agentKey, id);
    return agent;
  }

  /**
   * Get an agent by UUID.
   */
  getAgent(agentId: string): Agent | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Get an agent by external key.
   */
  getAgentByKey(agentKey: string): Agent | undefined {
    const id = this.keyIndex.get(agentKey);
    return id ? this.agents.get(id) : undefined;
  }

  /**
   * Update agent metadata.
   */
  updateAgent(
    agentId: string,
    metadata: Record<string, any>
  ): Agent | undefined | Promise<Agent | undefined> {
    const agent = this.agents.get(agentId);
    if (!agent) return undefined;

    const updated: Agent = {
      ...agent,
      metadata: { ...agent.metadata, ...metadata },
      updatedAt: new Date(),
    };

    if (this.db) {
      return this.persistAgentUpdate(updated).then((persisted) => {
        if (persisted) this.agents.set(agentId, persisted);
        return persisted;
      });
    }

    this.agents.set(agentId, updated);
    return updated;
  }

  /**
   * List all registered agents.
   */
  listAgents(): Agent[] {
    return Array.from(this.agents.values());
  }

  /**
   * Clear all agents (for testing).
   */
  clear(): void {
    this.agents.clear();
    this.keyIndex.clear();
  }

  private async persistAgent(agent: Agent): Promise<Agent> {
    const result = await this.db!.query(
      `INSERT INTO agents (id, key, name, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key
       RETURNING id, key, name, metadata, created_at, updated_at`,
      [
        agent.id,
        agent.key,
        agent.name,
        agent.metadata ?? null,
        agent.createdAt,
        agent.updatedAt,
      ]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Agent registration did not return a database row");
    return this.toAgent(row);
  }

  private async persistAgentUpdate(agent: Agent): Promise<Agent | undefined> {
    const result = await this.db!.query(
      `UPDATE agents
          SET metadata = $1, updated_at = $2
        WHERE id = $3
        RETURNING id, key, name, metadata, created_at, updated_at`,
      [agent.metadata ?? null, agent.updatedAt, agent.id]
    );
    const row = result.rows[0];
    return row ? this.toAgent(row) : undefined;
  }

  private toAgent(row: any): Agent {
    return {
      id: row.id,
      key: row.key,
      name: row.name,
      metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}

// Singleton instance
let agentService: AgentService | null = null;

export function getAgentService(): AgentService {
  if (!agentService) {
    agentService = new AgentService();
  }
  return agentService;
}

export function setAgentService(service: AgentService): void {
  agentService = service;
}
