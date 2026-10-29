-- Task 6: Create tasks table
-- Stores task metadata for tracking work across Anchor and Interlock
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  task_key VARCHAR(255) NOT NULL,
  description TEXT,
  status VARCHAR(50) NOT NULL,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Index on agent_id for finding tasks by agent
CREATE INDEX IF NOT EXISTS idx_tasks_agent_id ON tasks(agent_id);

-- Index on status for filtering by task status
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

-- Composite index for common queries
CREATE INDEX IF NOT EXISTS idx_tasks_agent_status ON tasks(agent_id, status);
