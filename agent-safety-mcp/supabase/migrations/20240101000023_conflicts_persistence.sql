-- Persist conflicts detected by the prepare_action gate so owners can monitor them.
-- conflicting_intent_id becomes optional: a stale read involves one intent and a changed resource.
ALTER TABLE conflicts ALTER COLUMN conflicting_intent_id DROP NOT NULL;
ALTER TABLE conflicts ADD COLUMN IF NOT EXISTS dedupe_key TEXT;
ALTER TABLE conflicts ADD COLUMN IF NOT EXISTS resource_changes JSONB NOT NULL DEFAULT '[]'::jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS uq_conflicts_dedupe_key ON conflicts(dedupe_key) WHERE dedupe_key IS NOT NULL;

ALTER TABLE conflicts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conflicts_owner_select ON conflicts;
CREATE POLICY conflicts_owner_select ON conflicts
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM intents i
    JOIN agents a ON a.id = i.agent_id
    WHERE i.id = conflicts.intent_id AND a.owner_id = (SELECT auth.uid())
  ));

-- Column-level read access: reason, conflicting_intent_id and dedupe_key stay unreadable to users.
REVOKE ALL ON conflicts FROM anon, authenticated;
GRANT SELECT (id, intent_id, conflict_type, severity, decision, affected_steps, preserved_steps, resource_changes, created_at)
  ON conflicts TO authenticated;