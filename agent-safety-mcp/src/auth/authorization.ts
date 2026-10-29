/**
 * Authorization Module - Trusted Local Boundary Model
 *
 * Enforces resource ownership and role-based access control.
 * Assumes stdio-based MCP transport is intrinsically trusted (local process only).
 * All authorization is runtime verification against database state.
 *
 * Key principles:
 * 1. Stdio identity comes from tool arguments; HTTP transport replaces identity
 *    aliases with the agent mapped from the verified JWT before tool dispatch
 * 2. Identity is verified against database (not just assumed valid)
 * 3. Ownership checked before any read/write operation
 * 4. Errors are generic; never leak agent names or sensitive data
 * 5. Reconciliation restricted to explicitly authorized agents
 */

import { getAgentService } from "../core/agent.service";
import type { AgentService } from "../core/agent.service";

/**
 * System agent IDs that can perform privileged operations (reconciliation, etc.)
 * Can be overridden via SYSTEM_AGENT_IDS environment variable (comma-separated)
 */
const DEFAULT_SYSTEM_AGENT_IDS = [
  "11111111-1111-1111-1111-111111111111", // Reserved for reconcilers
];

function getSystemAgentIds(): Set<string> {
  const env = process.env.SYSTEM_AGENT_IDS;
  if (env) {
    return new Set(env.split(",").map((id) => id.trim()));
  }
  return new Set(DEFAULT_SYSTEM_AGENT_IDS);
}

// Global agent service instance (can be overridden for testing)
let currentAgentService: AgentService | null = null;

/**
 * Override agent service for testing.
 * In production, this uses the singleton returned by getAgentService().
 */
export function setAgentServiceForTesting(service: AgentService): void {
  currentAgentService = service;
}

/**
 * Reset agent service to use singleton (after testing).
 */
export function resetAgentService(): void {
  currentAgentService = null;
}

/**
 * Get the current agent service (singleton or test override).
 */
function getAuthAgentService(): AgentService {
  if (currentAgentService) {
    return currentAgentService;
  }
  return getAgentService();
}

/**
 * Verify that an agent exists in the system.
 * Throws 403 if agent not found (rather than 404 to avoid info leakage).
 * 
 * @param agentId UUID of the agent to verify
 * @returns The agent object if it exists
 * @throws Error with status 403 if agent not found
 */
export function verifyAgentExists(agentId: string): any {
  const agentService = getAuthAgentService();
  const agent = agentService.getAgent(agentId);
  
  if (!agent) {
    throw new Error(
      `[403] Agent verification failed. Please ensure the agent is registered.`
    );
  }
  
  return agent;
}

/**
 * Check that the caller (agentId) owns the specified resource.
 * Throws 403 if ownership mismatch.
 * 
 * Used for:
 * - Actions (check agentId matches action.agent_id)
 * - Tasks (check agentId matches task.agent_id)
 * - Intents (check agentId matches intent.agent_id)
 * 
 * @param callerId UUID of the calling agent
 * @param ownerId UUID of the resource owner
 * @throws Error with status 403 if not the owner
 */
export function checkAgentOwnership(callerId: string, ownerId: string): void {
  if (callerId !== ownerId) {
    throw new Error(
      `[403] Access denied. This operation requires authorization.`
    );
  }
}

/**
 * Check that the caller is a system agent (can perform privileged operations).
 * Throws 403 if not a system agent.
 * 
 * Used for:
 * - Reconciliation operations
 * - Agent registration (future: admin only)
 * - System maintenance tasks
 * 
 * @param agentId UUID of the calling agent
 * @throws Error with status 403 if not a system agent
 */
export function checkSystemAgent(agentId: string): void {
  const systemIds = getSystemAgentIds();
  
  if (!systemIds.has(agentId)) {
    throw new Error(
      `[403] This operation requires system authorization.`
    );
  }
}

/**
 * Check that an agent exists AND is owned by the caller.
 * Combines verifyAgentExists + checkAgentOwnership for brevity.
 * 
 * @param callerId UUID of the calling agent
 * @param resourceId UUID of the resource (or owner UUID)
 * @returns true if verified and owned; never returns false (throws instead)
 */
export function verifyAgentOwnership(callerId: string, resourceId: string): boolean {
  verifyAgentExists(callerId);
  checkAgentOwnership(callerId, resourceId);
  return true;
}

/**
 * Check authorization for reading an agent''s resources (actions, tasks, etc.)
 * Enforces: caller can only read own resources or public data
 * 
 * @param callerId UUID of the calling agent
 * @param resourceOwnerId UUID of resource owner (or null for public)
 * @throws Error with 403 if not authorized
 */
export function checkReadAccess(callerId: string, resourceOwnerId: string | null): void {
  // Public resources (no owner) are readable by anyone
  if (resourceOwnerId === null) {
    return;
  }
  
  // Private resources require ownership
  checkAgentOwnership(callerId, resourceOwnerId);
}

/**
 * Check authorization for modifying an agent''s resources
 * Enforces: caller can only modify own resources
 * 
 * @param callerId UUID of the calling agent
 * @param resourceOwnerId UUID of resource owner
 * @throws Error with 403 if not authorized
 */
export function checkWriteAccess(callerId: string, resourceOwnerId: string): void {
  checkAgentOwnership(callerId, resourceOwnerId);
}

/**
 * Extract and verify agentId from tool arguments.
 * HTTP transport binds these arguments to the verified JWT identity first;
 * stdio callers continue to provide their identity explicitly.
 * 
 * Used in tool handlers to verify caller identity upfront
 * 
 * @param args Tool arguments (must have agentId or callingAgent)
 * @returns Verified agentId
 * @throws Error with 403 if not provided or invalid
 */
export function extractAndVerifyCallingAgent(args: any): string {
  const agentId = args.agentId || args.callingAgent || args.agent_id;
  
  if (!agentId || typeof agentId !== "string") {
    throw new Error(
      `[400] Missing required agent identifier in request.`
    );
  }
  
  // Verify agent exists (throws 403 if not)
  verifyAgentExists(agentId);
  
  return agentId;
}
