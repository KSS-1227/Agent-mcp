-- =============================================================================
-- INTERLOCK -- API keys and tenant isolation
--
-- Turning this from a demo into something another team can actually run their
-- fleet against needs two things the demo did not: a way to say who is calling,
-- and a guarantee that one caller's agents can never see or collide with
-- another's.
--
-- WHY ISOLATION IS A COLUMN RATHER THAN A CONVENTION
-- The whole product is about detecting conflicts between agents. If tenant
-- scoping were left to application code, a missed WHERE clause would not just
-- leak data -- it would make Tenant A's commit adjudicate Tenant B's intents,
-- which is a far stranger and more damaging failure than a normal leak. So
-- tenant_id is NOT NULL everywhere it matters, and the detection query filters
-- on it in the same breath as it filters on status.
--
-- KEYS ARE STORED HASHED
-- Only a SHA-256 of the key is persisted, plus a short display prefix. A
-- database dump does not yield working credentials, and we cannot show a
-- customer their own key after issuance -- which is the correct trade.
-- =============================================================================

SET database = interlock;

CREATE TABLE IF NOT EXISTS tenant (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       STRING NOT NULL,
  -- 'public' is the shared bucket every unauthenticated caller lands in.
  slug       STRING NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_key (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenant (id),
  -- SHA-256 of the full key. The key itself is never stored.
  key_hash         STRING NOT NULL UNIQUE,
  -- First 12 characters, so a user can identify a key in a list.
  key_prefix       STRING NOT NULL,
  label            STRING,
  daily_call_limit INT8 NOT NULL DEFAULT 2000,
  daily_usd_limit  DECIMAL NOT NULL DEFAULT 5,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at     TIMESTAMPTZ,
  revoked_at       TIMESTAMPTZ,
  INDEX api_key_tenant_idx (tenant_id)
);

-- The shared tenant for anonymous callers and the public demo.
INSERT INTO tenant (name, slug)
VALUES ('Public demo', 'public')
ON CONFLICT (slug) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Tenant columns on everything that participates in conflict detection.
--
-- Backfilled to the public tenant so existing rows -- the benchmark history and
-- the demo runs -- stay valid and keep telling the truth.
-- -----------------------------------------------------------------------------

ALTER TABLE agent       ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE resource    ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE intent      ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE commit_log  ADD COLUMN IF NOT EXISTS tenant_id UUID;

UPDATE agent      SET tenant_id = (SELECT id FROM tenant WHERE slug='public') WHERE tenant_id IS NULL;
UPDATE resource   SET tenant_id = (SELECT id FROM tenant WHERE slug='public') WHERE tenant_id IS NULL;
UPDATE intent     SET tenant_id = (SELECT id FROM tenant WHERE slug='public') WHERE tenant_id IS NULL;
UPDATE commit_log SET tenant_id = (SELECT id FROM tenant WHERE slug='public') WHERE tenant_id IS NULL;

-- Detection filters on (tenant_id, status) together, so index them together.
CREATE INDEX IF NOT EXISTS intent_tenant_open_idx ON intent (tenant_id, status);
CREATE INDEX IF NOT EXISTS resource_tenant_idx    ON resource (tenant_id, kind, ext_key);
CREATE INDEX IF NOT EXISTS agent_tenant_idx       ON agent (tenant_id, name);

ALTER TABLE tenant  SET LOCALITY GLOBAL;
ALTER TABLE api_key SET LOCALITY REGIONAL BY TABLE IN PRIMARY REGION;
