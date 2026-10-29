-- Create episodes table for Anchor memory/recovery narratives
-- Task 15: Store recovery narratives with embeddings
-- 
-- Episodes represent the persistent memory of action recovery events.
-- When an action crashes mid-execution and is later recovered via reconciliation,
-- a record is created here documenting what happened.
--
-- This table is written to atomically as part of Phase 3 (commitAtomic).
-- The embedding column stores pgvector embeddings for semantic search.

CREATE TABLE IF NOT EXISTS episodes (
  -- Primary identifier for this episode
  episode_id VARCHAR(255) PRIMARY KEY,

  -- Recovery narrative: human-readable description of what happened
  narrative TEXT NOT NULL,

  -- Outcome summary (e.g., "recovered", "failed")
  outcome VARCHAR(50) NOT NULL,

  -- Vector embedding of the narrative for semantic search
  -- Uses pgvector extension (must be enabled before this migration runs)
  embedding vector(1536),

  -- Status: "pending" (still open), "resolved" (completed)
  status VARCHAR(50) NOT NULL DEFAULT 'pending',

  -- When this episode expires (can be used for retention policies)
  expires_at TIMESTAMP WITH TIME ZONE,

  -- Audit timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Index on status for finding open/pending episodes
CREATE INDEX IF NOT EXISTS idx_episodes_status ON episodes(status);

-- Index on expires_at for cleanup queries
CREATE INDEX IF NOT EXISTS idx_episodes_expires_at ON episodes(expires_at);

-- Index on embedding for vector similarity search (if pgvector supports it)
-- Note: pgvector requires ivfflat or hnsw indexes for efficient similarity search
CREATE INDEX IF NOT EXISTS idx_episodes_embedding ON episodes USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
