-- =============================================================================
-- INTERLOCK -- exactly-once adjudication, enforced by the database
--
-- The chaos drill claims that killing a region mid-adjudication loses no
-- decision and applies none twice. The first half of that is what SURVIVE
-- REGION FAILURE gives us. The second half was, until this migration, merely a
-- convention: `resolve()` inserted an adjudication row and nothing stopped a
-- retry after a partial failure from inserting a second one.
--
-- A retry is exactly what happens when a connection dies mid-write, so
-- "we retry on failure" and "we never double-apply" were in direct tension.
--
-- This makes the invariant structural. One ruling per (commit, intent), decided
-- by a UNIQUE constraint rather than by the application remembering to check.
-- The drill can then falsify it: if a duplicate ever appears, the insert fails
-- loudly instead of quietly recording two verdicts for one conflict.
-- =============================================================================

SET database = interlock;

-- Retire any duplicates from runs that predate the constraint, keeping the
-- earliest ruling for each pair.
DELETE FROM repair
WHERE adjudication_id IN (
  SELECT id FROM (
    SELECT id,
           row_number() OVER (
             PARTITION BY commit_id, intent_id ORDER BY decided_at
           ) AS rn
    FROM adjudication
  ) ranked
  WHERE rn > 1
);

DELETE FROM adjudication
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           row_number() OVER (
             PARTITION BY commit_id, intent_id ORDER BY decided_at
           ) AS rn
    FROM adjudication
  ) ranked
  WHERE rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS adjudication_once_idx
  ON adjudication (commit_id, intent_id);
