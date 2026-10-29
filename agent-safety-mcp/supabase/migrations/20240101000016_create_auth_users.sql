-- Phase 12E Migration: User-Agent Mapping for Authenticated HTTP MCP
-- Creates auth_users table to map Supabase user_id to authorized agent_id
-- Enables secure HTTP authentication and authorization

CREATE TABLE IF NOT EXISTS auth_users (
  user_id UUID NOT NULL PRIMARY KEY,
  agent_id UUID NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  
  -- Foreign key to agents table
  CONSTRAINT fk_auth_users_agent_id FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_auth_users_user_id ON auth_users(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_users_agent_id ON auth_users(agent_id);

-- Ensure one-to-one mapping: one user maps to exactly one agent
-- (This is a unique constraint, already implicit via PRIMARY KEY on user_id)

-- Enable Row Level Security (RLS) on auth_users table
ALTER TABLE auth_users ENABLE ROW LEVEL SECURITY;

-- Deny all access by default
CREATE POLICY auth_users_deny_all ON auth_users
  FOR ALL
  USING (false)
  WITH CHECK (false);

-- Service role can query auth_users (required for MCP server getAgentIdForUser() calls)
-- Service role SET row_security = off allows it to bypass RLS policies
ALTER ROLE service_role SET row_security = off;

-- Explicitly grant service_role permissions
GRANT SELECT, INSERT ON auth_users TO service_role;

-- Deny anonymous role completely
REVOKE ALL ON auth_users FROM anon;
