-- Task 12: Create actions table
-- Stores Anchor action state machine with crash-safe semantics
CREATE TABLE IF NOT EXISTS actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  action_type VARCHAR(100) NOT NULL,
  arguments JSONB NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL UNIQUE,
  status VARCHAR(50) NOT NULL,
  external_reference VARCHAR(255),
  lease_acquired_at TIMESTAMP WITH TIME ZONE,
  lease_expires_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Index on idempotency_key (implicit from UNIQUE constraint, but making explicit)
CREATE INDEX IF NOT EXISTS idx_actions_idempotency_key ON actions(idempotency_key);

-- Composite index for finding actions to reconcile
CREATE INDEX IF NOT EXISTS idx_actions_agent_status ON actions(agent_id, status);

-- Index on status for finding actions in specific states
CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status);

-- Index on lease_expires_at for crash recovery queries
CREATE INDEX IF NOT EXISTS idx_actions_lease_expires_at ON actions(lease_expires_at);
