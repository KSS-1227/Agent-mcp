-- Create managed_clusters table for tracking world state of clusters
-- Task 16: Store cluster state mutations and versioning
--
-- managed_clusters represents the current state of infrastructure clusters being managed.
-- When an action successfully mutates cluster state (e.g., scales nodes), a record is
-- created or updated here. This table participates in the atomic commit phase (Phase 3).
--
-- The version column implements optimistic locking: it increments on every successful
-- mutation. This prevents lost updates when multiple agents attempt simultaneous actions
-- on the same cluster.
--
-- MUTATE_CLUSTER updates this table atomically alongside action_intents and episodes
-- in the Phase 3 commit transaction.

CREATE TABLE IF NOT EXISTS managed_clusters (
  -- Primary identifier for this cluster
  cluster_id VARCHAR(255) PRIMARY KEY,

  -- Scope key: tenant/project identifier
  -- Used by Anchor for multi-tenant isolation; required by schema
  scope_key VARCHAR(255) NOT NULL,

  -- Current desired node count for this cluster
  -- NULL means no scaling action has been applied yet
  desired_nodes INT NOT NULL DEFAULT 0,

  -- Last action that successfully mutated this cluster
  -- Used for audit trail and conflict resolution
  last_action VARCHAR(255),

  -- Optimistic lock version counter
  -- Increments on every successful mutation via MUTATE_CLUSTER
  -- Prevents lost updates under concurrent access
  version INT NOT NULL DEFAULT 0
);

-- Index on version for optimistic locking verification
CREATE INDEX IF NOT EXISTS idx_managed_clusters_version ON managed_clusters(version);

-- Index on scope_key for multi-tenant queries (if needed by Anchor domain)
CREATE INDEX IF NOT EXISTS idx_managed_clusters_scope_key ON managed_clusters(scope_key);
