-- Close public read access to two tables that were created without RLS.
-- Safe to rerun: enabling RLS on a table that already has it is a no-op.
ALTER TABLE action_resource_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_safety_schema_migrations ENABLE ROW LEVEL SECURITY;