-- Migration: Add Anchor protocol fields to actions table
-- This completes the schema for ActionCoordinator and ActionReconciler

ALTER TABLE actions ADD COLUMN IF NOT EXISTS episode_id VARCHAR(255) REFERENCES episodes(episode_id) ON DELETE SET NULL;
ALTER TABLE actions ADD COLUMN IF NOT EXISTS lease_owner UUID REFERENCES agents(id) ON DELETE SET NULL;
ALTER TABLE actions ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 1;
ALTER TABLE actions ADD COLUMN IF NOT EXISTS outcome JSONB;
ALTER TABLE actions ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP WITH TIME ZONE;

-- Create indexes for reconciliation efficiency
CREATE INDEX IF NOT EXISTS idx_actions_lease_expiry ON actions(lease_expires_at) WHERE status='PENDING';
CREATE INDEX IF NOT EXISTS idx_actions_episode ON actions(episode_id);
CREATE INDEX IF NOT EXISTS idx_actions_lease_owner ON actions(lease_owner);

-- Add check constraint for valid status values
ALTER TABLE actions DROP CONSTRAINT IF EXISTS valid_action_status;
ALTER TABLE actions ADD CONSTRAINT valid_action_status CHECK (status IN ('PENDING', 'COMMITTED', 'FAILED'));
