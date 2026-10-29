-- Phase 10F Migration: Durable External-Effect Protocol
-- Adds effect-state tracking separate from action status
-- Enables precise crash-window recovery and UNKNOWN outcome handling

-- Add effect-state tracking columns to actions table
ALTER TABLE actions ADD COLUMN IF NOT EXISTS effect_state VARCHAR(50) 
  DEFAULT 'NOT_STARTED' CHECK (effect_state IN ('NOT_STARTED', 'IN_PROGRESS', 'APPLIED', 'NOT_APPLIED', 'UNKNOWN'));

ALTER TABLE actions ADD COLUMN IF NOT EXISTS effect_started_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE actions ADD COLUMN IF NOT EXISTS effect_completed_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE actions ADD COLUMN IF NOT EXISTS verifier_response VARCHAR(50) 
  CHECK (verifier_response IN ('APPLIED', 'NOT_APPLIED', 'UNKNOWN') OR verifier_response IS NULL);

ALTER TABLE actions ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP WITH TIME ZONE;

-- Constraint: verifier_response and verified_at must both be set or both be null
ALTER TABLE actions ADD CONSTRAINT verifier_response_verified_at_consistency 
  CHECK ((verifier_response IS NOT NULL AND verified_at IS NOT NULL) OR (verifier_response IS NULL AND verified_at IS NULL));

-- Backward compatibility: pre-existing COMMITTED actions map to effect_state=APPLIED
-- (assumption: COMMITTED status means the action completed successfully and was verified)
UPDATE actions SET effect_state='APPLIED' WHERE effect_state='NOT_STARTED' AND status='COMMITTED';

-- Pre-existing FAILED actions map to effect_state=UNKNOWN (conservative)
-- Reason: FAILED status does not tell us whether the external effect actually happened.
-- A coordinator may have crashed before calling the verifier, leaving the external outcome uncertain.
-- Only the reconciler's verifier can establish authoritative outcome; leave UNKNOWN for reconciler to resolve.
UPDATE actions SET effect_state='UNKNOWN'
  WHERE effect_state='NOT_STARTED' AND status='FAILED' AND resolved_at IS NULL;
-- Leave verified_at=NULL and verifier_response=NULL: no actual verifier result was recorded;
-- reconciler will call verifier to establish authoritative outcome.

-- Indexes for efficiency
CREATE INDEX IF NOT EXISTS idx_actions_effect_in_progress 
  ON actions(effect_state) WHERE effect_state='IN_PROGRESS' AND status='PENDING';

CREATE INDEX IF NOT EXISTS idx_actions_effect_unknown 
  ON actions(effect_state) WHERE effect_state='UNKNOWN' AND status='PENDING';
