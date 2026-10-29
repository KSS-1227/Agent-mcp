-- Task 11: Create conflicts table
-- Records detected conflicts between intents with resolution metadata
CREATE TABLE IF NOT EXISTS conflicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id UUID NOT NULL REFERENCES intents(id) ON DELETE CASCADE,
  conflicting_intent_id UUID NOT NULL REFERENCES intents(id) ON DELETE CASCADE,
  conflict_type VARCHAR(50) NOT NULL,
  severity VARCHAR(50) NOT NULL,
  reason TEXT,
  decision VARCHAR(50),
  affected_steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  preserved_steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Index on intent_id for finding conflicts for an intent
CREATE INDEX IF NOT EXISTS idx_conflicts_intent_id ON conflicts(intent_id);

-- Index on conflicting_intent_id for reverse lookups
CREATE INDEX IF NOT EXISTS idx_conflicts_conflicting_intent_id ON conflicts(conflicting_intent_id);

-- Index on severity for prioritizing critical conflicts
CREATE INDEX IF NOT EXISTS idx_conflicts_severity ON conflicts(severity);

-- Composite index for finding unresolved conflicts
CREATE INDEX IF NOT EXISTS idx_conflicts_intent_decision ON conflicts(intent_id, decision);
