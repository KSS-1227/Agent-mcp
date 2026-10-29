/**
 * Authorization Checkers - Parent-Resource Ownership Verification
 *
 * Provides functions to verify caller ownership of resources by looking up
 * the parent resource (task, intent, action) and comparing agentId.
 *
 * These checkers are called by authorization-wrapper.ts for tools that
 * require ownership verification but receive only child/reference IDs.
 */

import { extractAndVerifyCallingAgent } from "../../auth/authorization";
import type { TaskService } from "../../core/task.service";
import type { IntentService } from "../../conflict-engine/intent.service";
import { ActionCoordinator } from "../../recovery-engine/coordinator";
import type { DatabaseClient } from "../../database/client";

export function checkTaskOwnership(
  callerId: string,
  taskId: string | undefined,
  taskService: TaskService,
  taskKey?: string
): void {
  const task = taskId
    ? taskService.getTask(taskId)
    : taskKey
      ? taskService.getTaskByKey(taskKey)
      : undefined;
  if (!task) {
    throw new Error("[404] Task not found or access denied.");
  }
  if (callerId !== task.agentId) {
    throw new Error("[403] Access denied.");
  }
}

export function checkIntentOwnership(
  callerId: string,
  intentId: string,
  intentService: IntentService
): void {
  const intent = intentService.getIntent(intentId);
  if (!intent) {
    throw new Error("[404] Intent not found or access denied.");
  }
  if (callerId !== intent.agentId) {
    throw new Error("[403] Access denied.");
  }
}

export async function checkActionOwnership(
  callerId: string,
  actionId: string,
  db: DatabaseClient
): Promise<void> {
  try {
    const pool = (db as any).pool;
    if (!pool) {
      throw new Error("[403] Access denied");
    }
    const coordinator = new ActionCoordinator(pool, callerId, 120);
    const action = await coordinator.load(actionId);
    if (!action) {
      throw new Error("[404] Action not found or access denied.");
    }
    if (callerId !== action.agentId) {
      throw new Error("[403] Access denied.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("[403]") || message.startsWith("[404]")) {
      throw error;
    }
    throw new Error("[403] Access denied");
  }
}
