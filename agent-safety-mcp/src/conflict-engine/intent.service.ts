/**
 * Intent Service - intent management for the Conflict Engine (originated in Interlock)
 *
 * Handles the DECLARE step of the 5-step pipeline:
 * - Record agent's intent before acting
 * - Record read-set (which resources, at what versions)
 * - Record plan steps and their dependencies
 */

import { v4 as uuidv4 } from "uuid";
import { Agent, Intent, IntentRead, PlanStep, Task } from "../core/types";
import { IntentStatus, StepStatus } from "./types";
import { DatabaseClient } from "../database/client";
import { getProvenanceGraph } from "./provenance";

export class IntentService {
  private intents = new Map<string, Intent>();
  private reads = new Map<string, IntentRead[]>();
  private steps = new Map<string, PlanStep[]>();
  private db: DatabaseClient | null = null;

  constructor(db?: DatabaseClient) {
    this.db = db || null;
  }

  setDatabase(db: DatabaseClient): void {
    this.db = db;
  }

  async loadFromDatabase(): Promise<void> {
    if (!this.db) return;

    const intentsResult = await this.db.query(
      `SELECT id, agent_id, task_id, intent_statement, status, metadata, created_at, updated_at
         FROM intents
        ORDER BY created_at, id`
    );
    const readsResult = await this.db.query(
      `SELECT intent_id, resource_id, observed_version
         FROM intent_reads
        ORDER BY created_at, id`
    );
    const stepsResult = await this.db.query(
      `SELECT id, intent_id, step_number, description, dependencies, status, created_at
         FROM intent_steps
        ORDER BY intent_id, step_number, id`
    );

    this.clear();
    getProvenanceGraph().clear();

    for (const row of intentsResult.rows) {
      const metadata = this.parseJson(row.metadata) || {};
      const intent: Intent = {
        id: row.id,
        agentId: row.agent_id,
        taskId: row.task_id || metadata.task_id || "",
        statement: row.intent_statement,
        status: row.status as IntentStatus,
        recordedAt: new Date(row.created_at),
        resolvedAt: ["committed", "aborted"].includes(row.status)
          ? new Date(row.updated_at)
          : undefined,
      };
      this.intents.set(intent.id, intent);
    }

    for (const row of readsResult.rows) {
      const read: IntentRead = {
        intentId: row.intent_id,
        resourceId: row.resource_id,
        observedVersion: row.observed_version,
      };
      const intentReads = this.reads.get(row.intent_id) || [];
      intentReads.push(read);
      this.reads.set(row.intent_id, intentReads);
    }

    for (const row of stepsResult.rows) {
      const dependencies = this.parseJson(row.dependencies) || [];
      const step: PlanStep = {
        id: row.id,
        intentId: row.intent_id,
        seq: row.step_number,
        description: row.description || "",
        status: row.status as StepStatus,
        dependsOn: dependencies,
        createdAt: new Date(row.created_at),
      };
      const intentSteps = this.steps.get(row.intent_id) || [];
      intentSteps.push(step);
      this.steps.set(row.intent_id, intentSteps);

      for (const resourceId of dependencies) {
        getProvenanceGraph().recordResourceDependency(resourceId, step.id);
      }
    }
  }

  async declareIntentPersisted(
    agentId: string,
    taskId: string,
    statement: string,
    reads: Array<{ resourceId: string; observedVersion: number }> = [],
    planSteps: Array<{
      description: string;
      dependsOn?: string[];
      embedding?: number[];
    }> = [],
    agentRecord?: Agent,
    taskRecord?: Task
  ): Promise<Intent> {
    if (!this.db) {
      return this.declareIntent(agentId, taskId, statement, reads, planSteps);
    }

    const readResourceIds = new Set(reads.map((read) => read.resourceId));
    this.validateResourceDependencies(planSteps, readResourceIds);

    const id = uuidv4();
    const now = new Date();
    const intent: Intent = {
      id,
      agentId,
      taskId,
      statement,
      status: IntentStatus.OPEN,
      recordedAt: now,
    };
    const intentReads = reads.map((read) => ({
      intentId: id,
      resourceId: read.resourceId,
      observedVersion: read.observedVersion,
    }));
    const steps: PlanStep[] = planSteps.map((step, seq) => ({
      id: uuidv4(),
      intentId: id,
      seq,
      description: step.description,
      embedding: step.embedding,
      status: StepStatus.PENDING,
      dependsOn: step.dependsOn,
      createdAt: now,
    }));

    await this.db.transaction(async (tx) => {
      if (agentRecord) {
        await tx.query(
          `INSERT INTO agents (id, key, name, metadata)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (id) DO NOTHING`,
          [
            agentRecord.id,
            agentRecord.key,
            agentRecord.name,
            JSON.stringify(agentRecord.metadata || {}),
          ]
        );
      }
      if (taskRecord) {
        await tx.query(
          `INSERT INTO tasks (id, agent_id, task_key, description, status, metadata)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (id) DO NOTHING`,
          [
            taskRecord.id,
            taskRecord.agentId,
            taskRecord.taskKey || taskRecord.id,
            taskRecord.description || "",
            taskRecord.status,
            JSON.stringify(taskRecord.metadata || {}),
          ]
        );
      }
      const taskResult = await tx.query("SELECT id FROM tasks WHERE id = $1", [taskId]);
      const persistedTaskId = taskResult.rows.length > 0 ? taskId : null;
      await tx.query(
        `INSERT INTO intents (id, agent_id, task_id, intent_statement, status, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          id,
          agentId,
          persistedTaskId,
          statement,
          IntentStatus.OPEN,
          JSON.stringify({ task_id: taskId }),
        ]
      );

      for (const read of intentReads) {
        await tx.query(
          `INSERT INTO intent_reads (intent_id, resource_id, observed_version)
           VALUES ($1, $2, $3)`,
          [id, read.resourceId, read.observedVersion]
        );
      }

      for (const step of steps) {
        await tx.query(
          `INSERT INTO intent_steps (id, intent_id, step_number, description, dependencies, status)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            step.id,
            id,
            step.seq,
            step.description,
            JSON.stringify(step.dependsOn || []),
            StepStatus.PENDING,
          ]
        );
      }
    });

    this.intents.set(id, intent);
    this.reads.set(id, intentReads);
    this.steps.set(id, steps);
    this.recordProvenance(steps);
    return intent;
  }

  async appendStepsPersisted(
    intentId: string,
    newSteps: Array<{
      description: string;
      dependsOn?: string[];
      embedding?: number[];
    }>
  ): Promise<PlanStep[] | undefined> {
    if (!this.db) return this.appendSteps(intentId, newSteps);

    const intent = this.intents.get(intentId);
    if (!intent) return undefined;

    const existing = this.steps.get(intentId) || [];
    const readResourceIds = new Set(
      (this.reads.get(intentId) || []).map((read) => read.resourceId)
    );
    this.validateResourceDependencies(newSteps, readResourceIds);

    const appended = await this.db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [intentId]);
      const sequenceResult = await tx.query(
        "SELECT COALESCE(MAX(step_number) + 1, 0) AS next_step FROM intent_steps WHERE intent_id = $1",
        [intentId]
      );
      const startSeq = Number(sequenceResult.rows[0].next_step);
      const now = new Date();
      const steps = newSteps.map((step, idx) => ({
        id: uuidv4(),
        intentId,
        seq: startSeq + idx,
        description: step.description,
        embedding: step.embedding,
        status: StepStatus.PENDING,
        dependsOn: step.dependsOn,
        createdAt: now,
      }));

      for (const step of steps) {
        await tx.query(
          `INSERT INTO intent_steps (id, intent_id, step_number, description, dependencies, status)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            step.id,
            intentId,
            step.seq,
            step.description,
            JSON.stringify(step.dependsOn || []),
            StepStatus.PENDING,
          ]
        );
      }
      return steps;
    });

    this.steps.set(intentId, [...existing, ...appended]);
    this.recordProvenance(appended);
    return appended;
  }

  private parseJson(value: any): any {
    return typeof value === "string" ? JSON.parse(value) : value;
  }

  private recordProvenance(steps: PlanStep[]): void {
    for (const step of steps) {
      for (const resourceId of step.dependsOn ?? []) {
        getProvenanceGraph().recordResourceDependency(resourceId, step.id);
      }
    }
  }

  /**
   * DECLARE STEP: Create a new intent with reads and plan steps
   */
  declareIntent(
    agentId: string,
    taskId: string,
    statement: string,
    reads: Array<{ resourceId: string; observedVersion: number }> = [],
    planSteps: Array<{
      description: string;
      dependsOn?: string[];
      embedding?: number[];
    }> = []
  ): Intent {
    const readResourceIds = new Set(reads.map((read) => read.resourceId));
    this.validateResourceDependencies(planSteps, readResourceIds);

    const id = uuidv4();
    const now = new Date();

    const intent: Intent = {
      id,
      agentId,
      taskId,
      statement,
      status: IntentStatus.OPEN,
      recordedAt: now,
    };

    this.intents.set(id, intent);

    // Store reads
    const intentReads = reads.map((r) => ({
      intentId: id,
      resourceId: r.resourceId,
      observedVersion: r.observedVersion,
    }));
    this.reads.set(id, intentReads);

    // Store steps
    const steps = planSteps.map((s, idx) => ({
      id: uuidv4(),
      intentId: id,
      seq: idx,
      description: s.description,
      embedding: s.embedding,
      status: StepStatus.PENDING,
      dependsOn: s.dependsOn,
      createdAt: now,
    }));
    this.steps.set(id, steps);

    for (const step of steps) {
      for (const resourceId of step.dependsOn ?? []) {
        getProvenanceGraph().recordResourceDependency(resourceId, step.id);
      }
    }

    return intent;
  }

  /**
   * Append steps to an already-declared intent.
   * Used when plan grows during execution (e.g., LangChain callbacks).
   */
  appendSteps(
    intentId: string,
    newSteps: Array<{
      description: string;
      dependsOn?: string[];
      embedding?: number[];
    }>
  ): PlanStep[] | undefined {
    const intent = this.intents.get(intentId);
    if (!intent) return undefined;

    const existing = this.steps.get(intentId) || [];
    const readResourceIds = new Set(
      (this.reads.get(intentId) || []).map((read) => read.resourceId)
    );
    this.validateResourceDependencies(newSteps, readResourceIds);

    const now = new Date();
    const startSeq = existing.length;

    const appended = newSteps.map((s, idx) => ({
      id: uuidv4(),
      intentId,
      seq: startSeq + idx,
      description: s.description,
      embedding: s.embedding,
      status: StepStatus.PENDING,
      dependsOn: s.dependsOn,
      createdAt: now,
    }));

    const updated = [...existing, ...appended];
    this.steps.set(intentId, updated);

    for (const step of appended) {
      for (const resourceId of step.dependsOn ?? []) {
        getProvenanceGraph().recordResourceDependency(resourceId, step.id);
      }
    }

    return appended;
  }

  private validateResourceDependencies(
    steps: Array<{ dependsOn?: string[] }>,
    readResourceIds: Set<string>
  ): void {
    for (const step of steps) {
      for (const resourceId of step.dependsOn ?? []) {
        if (!readResourceIds.has(resourceId)) {
          throw new Error(
            `Step dependency ${resourceId} must reference a resource in the intent read set`
          );
        }
      }
    }
  }

  /**
   * Get an intent by ID
   */
  getIntent(intentId: string): Intent | undefined {
    return this.intents.get(intentId);
  }

  /**
   * Get all steps for an intent
   */
  getIntentSteps(intentId: string): PlanStep[] {
    return this.steps.get(intentId) || [];
  }

  /**
   * Get all reads for an intent
   */
  getIntentReads(intentId: string): IntentRead[] {
    return this.reads.get(intentId) || [];
  }

  /**
   * Update intent status (in-memory only — used by tests that have no DB)
   */
  updateIntentStatus(intentId: string, status: IntentStatus): Intent | undefined {
    const intent = this.intents.get(intentId);
    if (!intent) return undefined;

    const updated: Intent = {
      ...intent,
      status,
      resolvedAt: ["committed", "aborted"].includes(status) ? new Date() : undefined,
    };

    this.intents.set(intentId, updated);
    return updated;
  }

  /**
   * Persist intent status transition, then update cache.
   * If the DB write fails the cache is NOT updated and the error propagates.
   */
  async updateIntentStatusPersisted(
    intentId: string,
    status: IntentStatus
  ): Promise<Intent | undefined> {
    const intent = this.intents.get(intentId);
    if (!intent) return undefined;

    if (this.db) {
      await this.db.query(
        `UPDATE intents
            SET status = $1, updated_at = now()
          WHERE id = $2`,
        [status, intentId]
      );
    }

    return this.updateIntentStatus(intentId, status);
  }

  /**
   * Mark steps as invalidated (in-memory only)
   */
  invalidateSteps(intentId: string, stepSeqs: number[]): void {
    const steps = this.steps.get(intentId);
    if (!steps) return;

    const updated = steps.map((s) => ({
      ...s,
      status: stepSeqs.includes(s.seq) ? StepStatus.INVALIDATED : s.status,
    }));

    this.steps.set(intentId, updated);
  }

  /**
   * Persist step invalidations, then update cache.
   */
  async invalidateStepsPersisted(intentId: string, stepSeqs: number[]): Promise<void> {
    if (this.db && stepSeqs.length > 0) {
      const steps = this.steps.get(intentId);
      if (steps) {
        const ids = steps
          .filter((s) => stepSeqs.includes(s.seq))
          .map((s) => s.id);
        if (ids.length > 0) {
          await this.db.query(
            `UPDATE intent_steps
                SET status = $1, updated_at = now()
              WHERE id = ANY($2::uuid[])`,
            [StepStatus.INVALIDATED, ids]
          );
        }
      }
    }
    this.invalidateSteps(intentId, stepSeqs);
  }

  /**
   * Mark steps as repaired (in-memory only)
   */
  repairSteps(intentId: string, stepSeqs: number[]): void {
    const steps = this.steps.get(intentId);
    if (!steps) return;

    const updated = steps.map((s) => ({
      ...s,
      status: stepSeqs.includes(s.seq) ? StepStatus.REPAIRED : s.status,
    }));

    this.steps.set(intentId, updated);
  }

  /**
   * Persist step repairs, then update cache.
   */
  async repairStepsPersisted(intentId: string, stepSeqs: number[]): Promise<void> {
    if (this.db && stepSeqs.length > 0) {
      const steps = this.steps.get(intentId);
      if (steps) {
        const ids = steps
          .filter((s) => stepSeqs.includes(s.seq))
          .map((s) => s.id);
        if (ids.length > 0) {
          await this.db.query(
            `UPDATE intent_steps
                SET status = $1, updated_at = now()
              WHERE id = ANY($2::uuid[])`,
            [StepStatus.REPAIRED, ids]
          );
        }
      }
    }
    this.repairSteps(intentId, stepSeqs);
  }

  /**
   * Mark a step as done (in-memory only)
   */
  completeStep(intentId: string, stepSeq: number): void {
    const steps = this.steps.get(intentId);
    if (!steps) return;

    const updated = steps.map((s) => ({
      ...s,
      status: s.seq === stepSeq ? StepStatus.DONE : s.status,
    }));

    this.steps.set(intentId, updated);
  }

  /**
   * Persist step completion, then update cache.
   */
  async completeStepPersisted(intentId: string, stepSeq: number): Promise<void> {
    if (this.db) {
      const steps = this.steps.get(intentId);
      if (steps) {
        const step = steps.find((s) => s.seq === stepSeq);
        if (step) {
          await this.db.query(
            `UPDATE intent_steps
                SET status = $1, updated_at = now()
              WHERE id = $2`,
            [StepStatus.DONE, step.id]
          );
        }
      }
    }
    this.completeStep(intentId, stepSeq);
  }

  /**
   * Get intents by status
   */
  getIntentsByStatus(status: IntentStatus): Intent[] {
    return Array.from(this.intents.values()).filter((i) => i.status === status);
  }

  /**
   * Get open intents (threatened or still open)
   */
  getOpenIntents(): Intent[] {
    return Array.from(this.intents.values()).filter((i) =>
      [IntentStatus.OPEN, IntentStatus.THREATENED, IntentStatus.REPAIRING].includes(i.status as any)
    );
  }

  /**
   * List all intents
   */
  listIntents(): Intent[] {
    return Array.from(this.intents.values());
  }

  /**
   * Clear all intents (for testing)
   */
  clear(): void {
    this.intents.clear();
    this.reads.clear();
    this.steps.clear();
  }
}

// Singleton instance
let intentService: IntentService | null = null;

export function getIntentService(): IntentService {
  if (!intentService) {
    intentService = new IntentService();
  }
  return intentService;
}

export function setIntentService(service: IntentService): void {
  intentService = service;
}

