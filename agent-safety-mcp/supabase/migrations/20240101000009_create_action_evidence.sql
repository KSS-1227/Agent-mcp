-- Task 13: Create action_evidence table
-- Records evidence for action status determination (used in reconciliation)
CREATE TABLE IF NOT EXISTS action_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id UUID NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
  source VARCHAR(100) NOT NULL,
  evidence_type VARCHAR(100) NOT NULL,
  external_reference VARCHAR(255),
  payload JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Index on action_id for finding evidence for an action
CREATE INDEX IF NOT EXISTS idx_action_evidence_action_id ON action_evidence(action_id);

-- Index on evidence type for filtering
CREATE INDEX IF NOT EXISTS idx_action_evidence_type ON action_evidence(evidence_type);
