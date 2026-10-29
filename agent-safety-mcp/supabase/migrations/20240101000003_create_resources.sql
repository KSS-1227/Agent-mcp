-- Task 7: Create resources table
-- Stores external resource metadata with optimistic versioning for conflict detection
CREATE TABLE IF NOT EXISTS resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_key VARCHAR(255) NOT NULL,
  resource_type VARCHAR(100) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  state JSONB,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Composite index for resource lookups by key and type
CREATE INDEX IF NOT EXISTS idx_resources_key_type ON resources(resource_key, resource_type);

-- Index on resource_key for fast single-key lookups
CREATE INDEX IF NOT EXISTS idx_resources_key ON resources(resource_key);
