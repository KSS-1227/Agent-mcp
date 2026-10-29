-- Task 9: Create intent_reads table
-- Tracks which resources an intent observed at which version for conflict detection
CREATE TABLE IF NOT EXISTS intent_reads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id UUID NOT NULL REFERENCES intents(id) ON DELETE CASCADE,
  resource_id UUID NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  observed_version INTEGER NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  
  -- Composite unique constraint: one read per intent per resource
  UNIQUE(intent_id, resource_id)
);

-- Index on intent_id for finding reads for an intent
CREATE INDEX IF NOT EXISTS idx_intent_reads_intent_id ON intent_reads(intent_id);

-- Index on resource_id for finding intents affected by resource changes
CREATE INDEX IF NOT EXISTS idx_intent_reads_resource_id ON intent_reads(resource_id);
