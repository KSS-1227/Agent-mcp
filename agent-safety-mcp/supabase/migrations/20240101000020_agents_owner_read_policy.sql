-- Let a signed-in Supabase user read only the agents they own (read-only dashboard access).
-- Server-side writes are unaffected: the MCP server connects with a role that bypasses RLS.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_agents_owner_id ON agents(owner_id);

ALTER TABLE agents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agents_owner_select ON agents;
CREATE POLICY agents_owner_select ON agents
  FOR SELECT
  TO authenticated
  USING (owner_id = (SELECT auth.uid()));