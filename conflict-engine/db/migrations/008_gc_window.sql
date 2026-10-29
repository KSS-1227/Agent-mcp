-- =============================================================================
-- INTERLOCK -- widen the garbage-collection window on the decision tables
--
-- WHY THIS IS PART OF THE MECHANISM, NOT HOUSEKEEPING
-- Step 3 replays the exact snapshot an agent read, using AS OF SYSTEM TIME.
-- How far back that can reach is bounded by gc.ttlseconds: older MVCC versions
-- are collected and the read fails.
--
-- The cluster default here is 4500 seconds -- 75 minutes. That is why the
-- continuity probe kept reporting a time-travel reach of about an hour, a
-- number we had been attributing vaguely to "table age".
--
-- 75 minutes is comfortably longer than any agent's thinking time, so the
-- mechanism works. But it is short for the OTHER thing point-in-time reads buy
-- us: reconstructing what an agent believed during an incident review, which
-- happens hours or days later, not minutes.
--
-- So the tables holding decisions get 24 hours, and the tables holding hot
-- contended state keep the default. Retaining old versions costs storage, and
-- there is no reason to pay it for rows nobody will ever ask about historically.
--
-- This is the trade being made explicitly rather than inherited by accident.
-- =============================================================================

SET database = interlock;

-- Decision records: worth reconstructing long after the fact.
ALTER TABLE intent          CONFIGURE ZONE USING gc.ttlseconds = 86400;
ALTER TABLE intent_read     CONFIGURE ZONE USING gc.ttlseconds = 86400;
ALTER TABLE plan_step       CONFIGURE ZONE USING gc.ttlseconds = 86400;
ALTER TABLE provenance_edge CONFIGURE ZONE USING gc.ttlseconds = 86400;
ALTER TABLE commit_log      CONFIGURE ZONE USING gc.ttlseconds = 86400;
ALTER TABLE adjudication    CONFIGURE ZONE USING gc.ttlseconds = 86400;

-- `resource` is the hot contended state. Agents diff against it within seconds
-- of reading it, so the default window is already generous, and history here is
-- the largest and least useful to keep.
ALTER TABLE resource CONFIGURE ZONE USING gc.ttlseconds = 4500;
