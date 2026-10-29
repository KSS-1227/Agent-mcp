-- Task 8: Create intents table
-- Stores Interlock intent model with embeddings for semantic search
CREATE TABLE IF NOT EXISTS intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  intent_statement TEXT NOT NULL,
  embedding vector(1536),
  status VARCHAR(50) NOT NULL,
  expiration_at TIMESTAMP WITH TIME ZONE,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Index on agent_id for finding intents by agent
CREATE INDEX IF NOT EXISTS idx_intents_agent_id ON intents(agent_id);

-- Index on task_id for finding intents by task
CREATE INDEX IF NOT EXISTS idx_intents_task_id ON intents(task_id);

-- Index on status for filtering by intent status
CREATE INDEX IF NOT EXISTS idx_intents_status ON intents(status);

-- IVFFlat index for vector similarity search (cosine distance)
CREATE INDEX IF NOT EXISTS idx_intents_embedding ON intents 
  USING ivfflat (embedding vector_cosine_ops) 
  WITH (lists = 100);
