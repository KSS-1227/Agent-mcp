/**
 * Task Service - Unified task management for Anchor and Interlock
 *
 * Tasks are work items that can contain intents (Interlock) or actions (Anchor)
 * - Agents can create, query, and update tasks
 * - Tasks track status, description, and associated agent
 */

import { v4 as uuidv4 } from "uuid";
import { Task } from "./types";
import { DatabaseClient } from "../database/client";

export class TaskService {
  private tasks = new Map<string, Task>();
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
      `SELECT id, agent_id, task_key, description, status, metadata, created_at, updated_at
         FROM tasks
        ORDER BY created_at, id`
    );
    this.tasks.clear();
    this.keyIndex.clear();
    for (const row of result.rows) {
      const task = this.toTask(row);
      this.tasks.set(task.id, task);
      if (task.taskKey && !this.keyIndex.has(task.taskKey)) {
        this.keyIndex.set(task.taskKey, task.id);
      }
    }
  }

  /**
   * Create a new task.
   */
  createTask(
    agentId: string,
    description: string,
    metadata?: Record<string, any>,
    taskKey?: string
  ): Task | Promise<Task> {
    const id = uuidv4();
    const now = new Date();
    const key = taskKey || id;

    // Check if task key already exists
    const existingId = this.keyIndex.get(key);
    if (existingId) {
      const existing = this.tasks.get(existingId);
      if (existing) return existing;
    }

    const task: Task = {
      id,
      agentId,
      taskKey: key,
      description,
      status: "pending",
      metadata,
      createdAt: now,
      updatedAt: now,
    };

    if (this.db) {
      return this.persistTask(task).then((persisted) => {
        this.tasks.set(persisted.id, persisted);
        if (persisted.taskKey) this.keyIndex.set(persisted.taskKey, persisted.id);
        return persisted;
      });
    }

    this.tasks.set(id, task);
    this.keyIndex.set(key, id);
    return task;
  }

  /**
   * Get a task by UUID.
   */
  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Get a task by external key.
   */
  getTaskByKey(taskKey: string): Task | undefined {
    const id = this.keyIndex.get(taskKey);
    return id ? this.tasks.get(id) : undefined;
  }

  /**
   * Update task status.
   */
  updateTaskStatus(
    taskId: string,
    status: "pending" | "in_progress" | "completed" | "failed"
  ): Task | undefined | Promise<Task | undefined> {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;

    const updated: Task = {
      ...task,
      status,
      updatedAt: new Date(),
    };

    if (this.db) {
      return this.persistTaskStatus(updated).then((persisted) => {
        if (persisted) this.tasks.set(taskId, persisted);
        return persisted;
      });
    }

    this.tasks.set(taskId, updated);
    return updated;
  }

  /**
   * Update task metadata.
   */
  updateTaskMetadata(taskId: string, metadata: Record<string, any>): Task | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;

    const updated: Task = {
      ...task,
      metadata: { ...task.metadata, ...metadata },
      updatedAt: new Date(),
    };

    this.tasks.set(taskId, updated);
    return updated;
  }

  /**
   * List all tasks for an agent.
   */
  listTasksByAgent(agentId: string): Task[] {
    return Array.from(this.tasks.values()).filter((t) => t.agentId === agentId);
  }

  /**
   * List tasks by status.
   */
  listTasksByStatus(status: "pending" | "in_progress" | "completed" | "failed"): Task[] {
    return Array.from(this.tasks.values()).filter((t) => t.status === status);
  }

  /**
   * List all tasks.
   */
  listTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Clear all tasks (for testing).
   */
  clear(): void {
    this.tasks.clear();
    this.keyIndex.clear();
  }

  private async persistTask(task: Task): Promise<Task> {
    return this.db!.transaction(async (tx) => {
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [`agent-safety:task-key:${task.taskKey}`]
      );

      const existing = await tx.query(
        `SELECT id, agent_id, task_key, description, status, metadata, created_at, updated_at
           FROM tasks
          WHERE task_key = $1
          ORDER BY created_at, id
          LIMIT 1`,
        [task.taskKey]
      );
      if (existing.rows[0]) return this.toTask(existing.rows[0]);

      const inserted = await tx.query(
        `INSERT INTO tasks (id, agent_id, task_key, description, status, metadata, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, agent_id, task_key, description, status, metadata, created_at, updated_at`,
        [
          task.id,
          task.agentId,
          task.taskKey,
          task.description ?? null,
          task.status,
          task.metadata ?? null,
          task.createdAt,
          task.updatedAt,
        ]
      );
      const row = inserted.rows[0];
      if (!row) throw new Error("Task creation did not return a database row");
      return this.toTask(row);
    });
  }

  private async persistTaskStatus(task: Task): Promise<Task | undefined> {
    const result = await this.db!.query(
      `UPDATE tasks
          SET status = $1, updated_at = $2
        WHERE id = $3
        RETURNING id, agent_id, task_key, description, status, metadata, created_at, updated_at`,
      [task.status, task.updatedAt, task.id]
    );
    const row = result.rows[0];
    return row ? this.toTask(row) : undefined;
  }

  private toTask(row: any): Task {
    return {
      id: row.id,
      agentId: row.agent_id,
      taskKey: row.task_key,
      description: row.description || "",
      status: row.status,
      metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}

// Singleton instance
let taskService: TaskService | null = null;

export function getTaskService(): TaskService {
  if (!taskService) {
    taskService = new TaskService();
  }
  return taskService;
}

export function setTaskService(service: TaskService): void {
  taskService = service;
}
