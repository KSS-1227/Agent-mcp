-- =============================================================================
-- INTERLOCK — distributed vector indexes (C-SPANN)
--
-- These are what make step 2 of the mechanism ("Watch") possible.
--
-- When an agent commits, we need to know which in-flight intents it threatens.
-- A provenance walk finds the LITERAL dependents — the ones that read the same
-- row. It misses the paraphrased and derived ones: an intent that says
-- "move the EU queue's backlog to the overnight shift" is threatened by a
-- commit that says "reassign ticket 44 to the EU queue" even though the two
-- share no rows and no keywords.
--
-- Approximate-nearest-neighbour search over the embeddings catches those.
--
-- The reason this belongs in CockroachDB rather than a separate vector store:
-- the similarity query and the graph query run inside the SAME transaction,
-- against the SAME snapshot. A bolt-on vector database would reintroduce
-- exactly the consistency gap this system exists to close.
-- =============================================================================

SET database = interlock;

-- Open intents, searched when a commit lands.
CREATE VECTOR INDEX IF NOT EXISTS intent_embedding_idx
  ON intent (embedding);

-- Committed facts, searched when a new intent is declared (does anything that
-- already happened invalidate this plan before it even starts?).
CREATE VECTOR INDEX IF NOT EXISTS commit_embedding_idx
  ON commit_log (embedding);

-- Individual plan steps, so the blast radius can be computed at step
-- granularity rather than whole-intent granularity. This is what makes
-- "repair only the dependent steps" mean something concrete.
CREATE VECTOR INDEX IF NOT EXISTS plan_step_embedding_idx
  ON plan_step (embedding);
