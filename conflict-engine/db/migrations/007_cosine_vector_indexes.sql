-- =============================================================================
-- INTERLOCK -- rebuild the vector indexes for the metric we actually query
--
-- THE BUG
-- `CREATE VECTOR INDEX ... ON intent (embedding)` defaults to vector_l2_ops.
-- Every query in this system orders by `<=>`, which is cosine. CockroachDB
-- correctly refuses to serve a cosine ordering from an L2 index, so the index
-- was never once used -- forcing it returned:
--
--     index "intent_embedding_idx" cannot be used for this query
--
-- Nothing appeared broken. Detection returned correct results the whole time,
-- because a full scan computes the same distances; it just does so without an
-- index. The system was quietly paying O(n) for something it had built an index
-- to avoid, and the "distributed vector index" claim was true of the schema and
-- false of every query that ran.
--
-- This is the SECOND time the L2/cosine distinction has caused a silent
-- failure. The first disabled semantic detection entirely, because a threshold
-- calibrated for cosine never matched L2 distances. Same root cause: the
-- operator and the thing configured for it drifted apart, and neither drift
-- raised an error.
--
-- The lesson worth carrying: with vector search, the distance metric is part of
-- the contract in three places -- the index, the query operator, and any
-- threshold compared against the result. All three have to agree, and nothing
-- checks that for you.
-- =============================================================================

SET database = interlock;

DROP INDEX IF EXISTS intent_embedding_idx;
DROP INDEX IF EXISTS commit_embedding_idx;
DROP INDEX IF EXISTS plan_step_embedding_idx;

-- Rebuilt with the cosine opclass, matching the `<=>` used everywhere.
CREATE VECTOR INDEX IF NOT EXISTS intent_embedding_cos_idx
  ON intent (embedding vector_cosine_ops);

CREATE VECTOR INDEX IF NOT EXISTS commit_embedding_cos_idx
  ON commit_log (embedding vector_cosine_ops);

CREATE VECTOR INDEX IF NOT EXISTS plan_step_embedding_cos_idx
  ON plan_step (embedding vector_cosine_ops);

-- The planner needs current statistics to prefer the index over a scan.
ANALYZE intent;
ANALYZE commit_log;
