-- Task 10: Create intent_steps table
-- Tracks individual steps of an intent with dependencies for selective invalidation
CREATE TABLE IF NOT EXISTS intent_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id UUID NOT NULL REFERENCES intents(id) ON DELETE CASCADE,
  step_number INTEGER NOT NULL,
  description TEXT,
  dependencies JSONB,
  status VARCHAR(50) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Index on intent_id for finding steps for an intent
CREATE INDEX IF NOT EXISTS idx_intent_steps_intent_id ON intent_steps(intent_id);

-- Composite index for step ordering within an intent
CREATE INDEX IF NOT EXISTS idx_intent_steps_intent_number ON intent_steps(intent_id, step_number);

-- Index on step status for filtering
CREATE INDEX IF NOT EXISTS idx_intent_steps_status ON intent_steps(status);
