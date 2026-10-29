-- Make resource keys unique per tenant, not globally.
--
-- 001 declared UNIQUE (kind, ext_key) back when there was one tenant: us. Once
-- /v1/resources let strangers register their own state, that constraint became
-- a leak. Two tenants both naming a queue "support-eu" would collide, and the
-- ON CONFLICT DO UPDATE in the handler would hand the second caller the first
-- caller's row -- its id, its body, its version -- and let them write into it.
--
-- Nothing exploited this: the endpoint shipped and this migration followed
-- within the hour. Recorded plainly because a tenancy bug that gets quietly
-- patched is one nobody learns from.
--
-- NULL tenant_id rows are our own internal ones (the demo, the benchmark).
-- CockroachDB treats NULLs as distinct in a unique index, so those are no
-- longer constrained -- which is correct: they use generated keys and were
-- never the thing at risk.

SET database = interlock;

-- Named plainly rather than as resource@resource_kind_ext_key_key: with the
-- table qualifier this parses but silently does nothing, then leaves the
-- session unable to see the table for the next statement.
DROP INDEX IF EXISTS resource_kind_ext_key_key CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS resource_tenant_key_idx
  ON resource (tenant_id, kind, ext_key);
