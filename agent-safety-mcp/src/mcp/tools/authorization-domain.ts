/**
 * Tool-Specific Authorization Functions
 */

import {
  checkAgentOwnership,
  extractAndVerifyCallingAgent,
  checkSystemAgent,
} from "../../auth/authorization";
import { getTaskService } from "../../core/task.service";
import { getIntentService } from "../../conflict-engine/intent.service";

/**
 * Verify caller owns a task
 */
export function verifyTaskOwnership(callerId: string, taskId: string): void {
  const taskService = getTaskService();
  const task = taskService.getTask(taskId);
  if (!task) {
    throw new Error(`[403] Task not found or access denied.`);
  }
  checkAgentOwnership(callerId, task.agentId);
}

/**
 * Verify caller owns an intent
 */
export function verifyIntentOwnership(callerId: string, intentId: string): void {
  const intentService = getIntentService();
  const intent = intentService.getIntent(intentId);
  if (!intent) {
    throw new Error(`[403] Intent not found or access denied.`);
  }
  checkAgentOwnership(callerId, intent.agentId);
}

/**
 * Verify caller can read tasks for an agent
 */
export function verifyTaskListAccess(callerId: string, targetAgentId?: string): void {
  if (!targetAgentId) {
    return;
  }
  if (callerId !== targetAgentId) {
    try {
      checkSystemAgent(callerId);
    } catch {
      throw new Error(`[403] Access denied.`);
    }
  }
}

/**
 * Verify caller can read intents for an agent
 */
export function verifyIntentListAccess(callerId: string, targetAgentId?: string): void {
  if (!targetAgentId) {
    return;
  }
  if (callerId !== targetAgentId) {
    try {
      checkSystemAgent(callerId);
    } catch {
      throw new Error(`[403] Access denied.`);
    }
  }
}

