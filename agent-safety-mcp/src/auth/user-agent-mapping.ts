import { DatabaseClient } from "../database/client";

/**
 * User-Agent Mapping - Secure identity binding
 * Maps Supabase user_id to authorized agent_id via auth_users table
 */

export interface AuthUser {
  user_id: string;
  agent_id: string;
  created_at: string;
}

/**
 * Look up agent_id for authenticated user
 * Fails if user not mapped (prevents unregistered users from accessing system)
 * 
 * @param userId Supabase Auth user UUID
 * @param db Database client with service-role permissions
 * @returns agent_id if mapping exists
 * @throws Error if user not found in auth_users
 */
export async function getAgentIdForUser(userId: string, db: DatabaseClient): Promise<string> {
  try {
    const result = await db.query<AuthUser>(
      "SELECT user_id, agent_id, created_at FROM auth_users WHERE user_id = $1",
      [userId]
    );

    if (result.rows.length === 0) {
      throw new Error(`User not registered: ${userId}`);
    }

    return result.rows[0].agent_id;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Agent mapping lookup failed: ${message}`);
  }
}

/**
 * Register a new user-agent mapping (admin operation)
 * Only call this during provisioning; never expose to HTTP
 * 
 * @param userId Supabase Auth user UUID
 * @param agentId Agent UUID to bind
 * @param db Database client with service-role permissions
 */
export async function createUserAgentMapping(
  userId: string,
  agentId: string,
  db: DatabaseClient
): Promise<void> {
  try {
    await db.query(
      "INSERT INTO auth_users (user_id, agent_id) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING",
      [userId, agentId]
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to create user-agent mapping: ${message}`);
  }
}
