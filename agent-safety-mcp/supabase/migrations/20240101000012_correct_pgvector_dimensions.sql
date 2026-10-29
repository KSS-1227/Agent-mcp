-- Correct pgvector integration: Fix embedding dimensions and indexes
-- Issue: embeddings created with 1536 dims but Titan V2 produces 1024 dims
--
-- Changes:
-- 1. Alter intents.embedding from vector(1536) ? vector(1024)
-- 2. Alter episodes.embedding from vector(1536) ? vector(1024)
-- 3. Drop old single-column episodes embedding index
-- 4. Recreate episodes embedding index with ivfflat for cosine distance
--
-- Rationale:
-- - Amazon Titan Text Embeddings V2 outputs exactly 1024 dimensions (verified in Anchor)
-- - Application code validates embedding.length === 1024 before write
-- - All semantic search queries use cosine distance operator (<=>)
-- - pgvector ivfflat indexes match Anchor performance characteristics
--
-- Safety:
-- - ALTER COLUMN TYPE safe for vector columns (no data loss)
-- - Index recreation is idempotent with IF NOT EXISTS
-- - No application code changes required
-- - PostgreSQL/Supabase compatible SQL only

-- Fix intents embedding dimension from vector(1536) to vector(1024)
-- (from migration 20240101000004)
ALTER TABLE IF EXISTS intents
  ALTER COLUMN embedding TYPE vector(1024);

-- Fix episodes embedding dimension from vector(1536) to vector(1024)
-- (from migration 20240101000010)
ALTER TABLE IF EXISTS episodes
  ALTER COLUMN embedding TYPE vector(1024);

-- Drop old single-column episodes embedding index
DROP INDEX IF EXISTS idx_episodes_embedding;

-- Create ivfflat index on episodes.embedding for cosine distance similarity search
-- Used by findSimilarIntents() in semantic conflict detection (5-step pipeline)
-- Queries: ORDER BY embedding <=> $1::vector LIMIT $n
-- Operator class vector_cosine_ops matches application cosine distance usage
CREATE INDEX IF NOT EXISTS idx_episodes_embedding ON episodes 
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Verify the indexes exist for other access patterns
CREATE INDEX IF NOT EXISTS idx_episodes_status ON episodes(status);
CREATE INDEX IF NOT EXISTS idx_episodes_expires_at ON episodes(expires_at);
