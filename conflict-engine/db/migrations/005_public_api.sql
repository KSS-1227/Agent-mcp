-- =============================================================================
-- INTERLOCK -- public API quota and abuse control
--
-- Exposing adjudication over an unauthenticated HTTP endpoint means strangers
-- can spend our inference budget. Rate limiting in Lambda memory is not enough:
-- instances are ephemeral and concurrent, so per-instance counters undercount
-- by exactly the factor that matters during an actual flood.
--
-- The ceiling therefore lives in the database, where SERIALIZABLE makes the
-- check-and-increment atomic across every concurrent invocation. This is the
-- same guarantee the product is about, applied to its own operating costs.
-- =============================================================================

SET database = interlock;

CREATE TABLE IF NOT EXISTS api_quota (
  -- One row per (day, bucket). bucket is 'global' or a hashed client id.
  day        DATE NOT NULL,
  bucket     STRING NOT NULL,
  calls      INT8 NOT NULL DEFAULT 0,
  tokens     INT8 NOT NULL DEFAULT 0,
  usd_micros INT8 NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (day, bucket)
);

-- Quota rows have no value after the day they describe. Row-level TTL retires
-- them without a cron job, a cleanup script, or anyone remembering.
ALTER TABLE api_quota SET (ttl_expiration_expression = $$ (day + INTERVAL '8 days')::TIMESTAMPTZ $$);

ALTER TABLE api_quota SET LOCALITY REGIONAL BY TABLE IN PRIMARY REGION;

-- Every public request, for the audit trail and for showing judges the service
-- is genuinely being exercised rather than mocked.
CREATE TABLE IF NOT EXISTS api_request (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route       STRING NOT NULL,
  client_hash STRING,
  status      INT4 NOT NULL,
  duration_ms INT8 NOT NULL DEFAULT 0,
  tokens      INT8 NOT NULL DEFAULT 0,
  detail      JSONB NOT NULL DEFAULT '{}'::JSONB,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX api_request_recent_idx (at DESC)
);

ALTER TABLE api_request SET (ttl_expiration_expression = $$ (at + INTERVAL '30 days')::TIMESTAMPTZ $$);
ALTER TABLE api_request SET LOCALITY REGIONAL BY TABLE IN PRIMARY REGION;
