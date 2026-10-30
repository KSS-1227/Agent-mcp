-- Phase 10C: Test External Ledger for Crash-Recovery Testing
-- Persists simulated external effects across process restarts
-- Used to verify exactly-once semantics and recovery paths

CREATE TABLE IF NOT EXISTS test_external_effects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id UUID NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
  idempotency_key VARCHAR(255) NOT NULL,
  effect_type VARCHAR(100) NOT NULL,
  effect_payload JSONB,
  verifier_response VARCHAR(50), -- APPLIED, NOT_APPLIED, UNKNOWN
  recorded_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  verified_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Index for fast lookups by action
CREATE INDEX IF NOT EXISTS idx_test_external_effects_action ON test_external_effects(action_id);

-- Index for finding effects by idempotency_key
CREATE INDEX IF NOT EXISTS idx_test_external_effects_key ON test_external_effects(idempotency_key);

-- Index for finding unverified effects
CREATE INDEX IF NOT EXISTS idx_test_external_effects_unverified ON test_external_effects(verified_at) WHERE verified_at IS NULL;
