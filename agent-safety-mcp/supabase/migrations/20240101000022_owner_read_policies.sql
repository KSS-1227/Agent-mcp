-- Read-only dashboard access: a signed-in user can see the work of the agents they own.
-- No INSERT/UPDATE/DELETE policies: writes stay server-side. conflicts is intentionally
-- left operator-only (a conflict spans two owners and its reason can name the other party's resource).
ALTER TABLE actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE intent_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE episodes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS actions_owner_select ON actions;
CREATE POLICY actions_owner_select ON actions
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM agents a
    WHERE a.id = actions.agent_id AND a.owner_id = (SELECT auth.uid())
  ));

DROP POLICY IF EXISTS intents_owner_select ON intents;
CREATE POLICY intents_owner_select ON intents
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM agents a
    WHERE a.id = intents.agent_id AND a.owner_id = (SELECT auth.uid())
  ));

DROP POLICY IF EXISTS intent_steps_owner_select ON intent_steps;
CREATE POLICY intent_steps_owner_select ON intent_steps
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM intents i
    JOIN agents a ON a.id = i.agent_id
    WHERE i.id = intent_steps.intent_id AND a.owner_id = (SELECT auth.uid())
  ));

DROP POLICY IF EXISTS episodes_owner_select ON episodes;
CREATE POLICY episodes_owner_select ON episodes
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM actions ac
    JOIN agents a ON a.id = ac.agent_id
    WHERE ac.episode_id = episodes.episode_id AND a.owner_id = (SELECT auth.uid())
  ));