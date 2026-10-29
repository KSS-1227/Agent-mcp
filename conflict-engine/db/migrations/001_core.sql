-- =============================================================================
-- INTERLOCK — core schema
--
-- The memory is not a log of what agents said. It is the substrate that makes
-- concurrent agents safe. Four things live here:
--
--   1. INTENTS      what an agent declared it was about to do, and what it read
--   2. PROVENANCE   which plan steps derived from which facts
--   3. COMMITS      what actually landed, and when
--   4. ADJUDICATIONS the ruling on every detected conflict, with its evidence
--
-- Every table that participates in a decision is bitemporal: we record both
-- when a fact was TRUE in the world (valid_from/valid_to) and when the system
-- LEARNED it (recorded_at). That separation is what lets us reconstruct what an
-- agent believed at a past instant, rather than what we now know to have been
-- true — which are different questions, and only the first one is fair.
-- =============================================================================

CREATE DATABASE IF NOT EXISTS interlock;
SET database = interlock;

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

CREATE TYPE IF NOT EXISTS intent_status AS ENUM (
  'open',        -- declared, agent is still thinking
  'threatened',  -- a conflicting commit landed; awaiting adjudication
  'repairing',   -- adjudicator ruled invalidating; dependent steps re-running
  'committed',   -- landed successfully
  'aborted'      -- ruled fatal, or lost its serializable commit
);

CREATE TYPE IF NOT EXISTS verdict AS ENUM (
  'irrelevant',   -- the conflicting write does not affect this plan → proceed
  'invalidating', -- some steps depended on what changed → repair those steps
  'fatal'         -- the plan's premise is gone → abort
);

CREATE TYPE IF NOT EXISTS step_status AS ENUM (
  'pending',
  'done',
  'invalidated',
  'repaired'
);

-- -----------------------------------------------------------------------------
-- Agents — the fleet
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        STRING NOT NULL,
  role        STRING NOT NULL,
  -- Which region this agent's runtime sits in. Used to show that adjudication
  -- survives losing the region an agent is running in.
  home_region STRING NOT NULL DEFAULT 'aws-us-east-1',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Resources — the contended world state
--
-- This is what agents fight over. `version` increments on every write, so a
-- stale read is detectable without relying on the model noticing.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS resource (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        STRING NOT NULL,        -- e.g. 'ticket', 'inventory', 'schedule'
  ext_key     STRING NOT NULL,        -- stable business key
  body        JSONB NOT NULL DEFAULT '{}'::JSONB,
  version     INT8 NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kind, ext_key)
);

-- -----------------------------------------------------------------------------
-- Intents — the heart of the system
--
-- An agent writes one of these BEFORE it acts. `statement` is the plan in
-- natural language; `embedding` is that same statement in vector space, which
-- is what lets us find agents threatened by meaning rather than by row overlap.
--
-- `read_hlc` stores the cluster's logical timestamp at the moment the agent
-- read. That single DECIMAL is what makes `AS OF SYSTEM TIME` usable later:
-- we can replay the exact snapshot the agent saw and diff it against now.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS intent (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     UUID NOT NULL REFERENCES agent (id),
  task_id      UUID NOT NULL,          -- groups the intents of one agent task
  status       intent_status NOT NULL DEFAULT 'open',

  statement    STRING NOT NULL,        -- "reassign ticket 44 to the EU queue"
  embedding    VECTOR(1024),           -- Titan Text Embeddings V2, 1024 dims

  -- The snapshot this intent was formed against.
  read_hlc     DECIMAL NOT NULL,

  -- Bitemporal. valid_* is world time; recorded_* is system time.
  valid_from   TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to     TIMESTAMPTZ,            -- NULL = still believed
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ,

  INDEX intent_open_idx (status) WHERE status IN ('open', 'threatened'),
  INDEX intent_task_idx (task_id, recorded_at)
);

-- The read-set, declared rather than inferred.
-- Classical concurrency control needs this up front and usually cannot get it.
-- An LLM agent can simply say what it is depending on.
CREATE TABLE IF NOT EXISTS intent_read (
  intent_id        UUID NOT NULL REFERENCES intent (id) ON DELETE CASCADE,
  resource_id      UUID NOT NULL REFERENCES resource (id),
  observed_version INT8 NOT NULL,
  PRIMARY KEY (intent_id, resource_id)
);

-- -----------------------------------------------------------------------------
-- Plan steps — the unit of repair
--
-- Repairing "only the dependent steps" is only meaningful if steps are first-
-- class rows with their own provenance. This is the table that turns an abort
-- into a surgical fix.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS plan_step (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id   UUID NOT NULL REFERENCES intent (id) ON DELETE CASCADE,
  seq         INT4 NOT NULL,
  description STRING NOT NULL,
  embedding   VECTOR(1024),
  status      step_status NOT NULL DEFAULT 'pending',
  tokens_used INT8 NOT NULL DEFAULT 0,   -- what a re-run would cost us
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (intent_id, seq)
);

-- -----------------------------------------------------------------------------
-- Provenance — the dependency graph
--
-- Edges are (kind, id) → (kind, id) so the same table can express
-- "step 3 derived from resource X" and "step 5 derived from step 3".
-- A recursive CTE over this table is what computes the blast radius.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS provenance_edge (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_kind  STRING NOT NULL,   -- 'resource' | 'step' | 'intent'
  from_id    UUID NOT NULL,
  to_kind    STRING NOT NULL,
  to_id      UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (from_kind, from_id, to_kind, to_id),
  INDEX provenance_reverse_idx (to_kind, to_id)
);

-- -----------------------------------------------------------------------------
-- Commits — what actually landed
--
-- Each row is a fact that just became true and may have invalidated somebody.
-- It carries its own embedding so the "watch" step can search commits against
-- open intents in vector space.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS commit_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     UUID NOT NULL REFERENCES agent (id),
  intent_id    UUID REFERENCES intent (id),
  resource_id  UUID NOT NULL REFERENCES resource (id),
  prev_version INT8 NOT NULL,
  new_version  INT8 NOT NULL,
  statement    STRING NOT NULL,
  embedding    VECTOR(1024),
  commit_hlc   DECIMAL NOT NULL,
  committed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX commit_recent_idx (committed_at DESC)
);

-- -----------------------------------------------------------------------------
-- Adjudications — the ruling, and its evidence
--
-- This table is the audit trail and the benchmark ledger at once. Token counts
-- and latency live here because the headline claim of the project is a cost and
-- throughput claim, and it has to be reconstructable from stored rows rather
-- than from a spreadsheet.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS adjudication (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commit_id     UUID NOT NULL REFERENCES commit_log (id),
  intent_id     UUID NOT NULL REFERENCES intent (id),

  verdict       verdict NOT NULL,
  rationale     STRING NOT NULL,

  -- How the threat was found: exact provenance walk, vector similarity, or both.
  detected_by   STRING NOT NULL DEFAULT 'graph',  -- 'graph' | 'vector' | 'both'
  similarity    FLOAT8,                            -- cosine distance when vector

  model_id      STRING,
  tokens_in     INT8 NOT NULL DEFAULT 0,
  tokens_out    INT8 NOT NULL DEFAULT 0,
  latency_ms    INT8 NOT NULL DEFAULT 0,

  -- Steps we did NOT have to re-run. This is the number the whole project is
  -- arguing about, so it is stored, not derived at report time.
  steps_total    INT4 NOT NULL DEFAULT 0,
  steps_repaired INT4 NOT NULL DEFAULT 0,

  decided_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX adjudication_intent_idx (intent_id, decided_at DESC)
);

CREATE TABLE IF NOT EXISTS repair (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  adjudication_id UUID NOT NULL REFERENCES adjudication (id) ON DELETE CASCADE,
  plan_step_id    UUID NOT NULL REFERENCES plan_step (id),
  action          STRING NOT NULL,   -- 'rerun' | 'amend' | 'drop'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Benchmark ledger
--
-- One row per run, one row per measured event. Kept in the same database as the
-- workload so a result can never drift from the rows that produced it.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bench_run (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mode         STRING NOT NULL,       -- 'serial' | '2pl' | 'occ' | 'interlock'
  workload     STRING NOT NULL,
  agent_count  INT4 NOT NULL,
  git_sha      STRING,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  notes        STRING
);

CREATE TABLE IF NOT EXISTS bench_event (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       UUID NOT NULL REFERENCES bench_run (id) ON DELETE CASCADE,
  kind         STRING NOT NULL,   -- 'commit'|'abort'|'deadlock'|'anomaly'|'repair'
  agent_id     UUID,
  tokens_in    INT8 NOT NULL DEFAULT 0,
  tokens_out   INT8 NOT NULL DEFAULT 0,
  wasted_tokens INT8 NOT NULL DEFAULT 0,  -- reasoning discarded by an abort
  detail       JSONB NOT NULL DEFAULT '{}'::JSONB,
  at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX bench_event_run_idx (run_id, at)
);
