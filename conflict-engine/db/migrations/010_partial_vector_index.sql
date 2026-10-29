-- Index the working set, not the archive.
--
-- 007 fixed the metric: the vector indexes were built for L2 while every query
-- asks in cosine, so they could not be used at all. That was necessary and not
-- sufficient. A cosine index on `intent (embedding)` still cannot serve the
-- query this system actually issues, because that query filters:
--
--   WHERE status IN ('open','threatened') AND embedding IS NOT NULL
--     AND tenant_id IS NOT DISTINCT FROM <caller>
--   ORDER BY embedding <=> <commit vector>
--
-- Measured on the live cluster, any WHERE clause at all sent that query to a
-- full scan. Removing every filter selected the index -- which is to say the
-- index was serving a query nobody runs.
--
-- Three shapes were tried before this one:
--
--   (embedding)                     index used only with no filter at all
--   (tenant_id, embedding)          index used, including with IS NOT DISTINCT
--                                   FROM -- but `status` still forced a scan
--   (tenant_id, status, embedding)  worse: scan even for status equality
--
-- Post-filtering was the obvious escape and the wrong one. Over-fetching k
-- neighbours and then discarding the resolved ones works until a tenant has a
-- long history and few live plans, at which point the over-fetch returns
-- nothing open and semantic detection stops finding anything -- silently, which
-- is the exact failure mode this project keeps digging out of itself.
--
-- A partial index puts the filter in the index instead. The predicate matches
-- the query exactly, so there is no recall loss, and the index holds only plans
-- currently in flight: 9 rows today against 1,752 intents total. That ratio is
-- the point. Semantic conflict detection only ever asks about live plans, and
-- an intent that has been resolved is dead weight in a structure that is
-- rebalanced on every insert.
--
-- HONEST CAVEAT
-- At 9 in-flight intents the planner still prefers a scan, and it is right to:
-- scanning 9 rows beats descending a tree. Forcing the index proves it serves
-- the query rather than merely existing (`npm run db:verify` does exactly this).
-- The crossover is a volume question, not a correctness one.

SET database = interlock;

CREATE VECTOR INDEX IF NOT EXISTS intent_live_embedding_idx
  ON intent (tenant_id, embedding vector_cosine_ops)
  WHERE status IN ('open', 'threatened') AND embedding IS NOT NULL;

-- The full-table cosine index is now redundant: no query in this system runs an
-- unfiltered nearest-neighbour search over intents, so it was costing a tree
-- rebalance on every intent insert to serve nothing.
DROP INDEX IF EXISTS intent_embedding_cos_idx CASCADE;

-- Same reasoning, more bluntly. Nothing has ever issued a nearest-neighbour
-- query against commit_log or plan_step -- the threat detector searches intents
-- and only intents. These two were built because the tables have embedding
-- columns, which is not a reason. Three vector indexes of which one is read is
-- a worse story than one that is.
DROP INDEX IF EXISTS commit_embedding_cos_idx CASCADE;
DROP INDEX IF EXISTS plan_step_embedding_cos_idx CASCADE;
