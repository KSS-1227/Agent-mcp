-- Preserve the resource versions read when an action is prepared.
CREATE TABLE IF NOT EXISTS action_resource_versions (
  action_id VARCHAR(255) NOT NULL REFERENCES actions(idempotency_key) ON DELETE CASCADE,
  resource_id UUID NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
  observed_version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (action_id, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_action_resource_versions_resource_id
  ON action_resource_versions(resource_id);
