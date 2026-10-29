-- ============================================================================
-- AGENT SAFETY MCP — Complete Supabase/PostgreSQL Schema Setup
-- ============================================================================
-- Run these SQL queries in order in your Supabase SQL Editor
-- This creates all required tables for the Agent Safety MCP project
-- ============================================================================

-- ============================================================================
-- STEP 1: Enable pgvector Extension
-- ============================================================================
-- Must run first to support vector embeddings

CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================================
-- STEP 2: Create Core Tables
-- ============================================================================

-- AGENTS TABLE
-- Stores agent metadata unified for Anchor and Interlock
CREATE TABLE IF NOT EXISTS agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agents_key ON agents(key);

-- TASKS TABLE
-- Stores task metadata for tracking work across Anchor and Interlock
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  task_key VARCHAR(255) NOT NULL,
  description TEXT,
  status VARCHAR(50) NOT NULL,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_agent_id ON tasks(agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_agent_status ON tasks(agent_id, status);

-- RESOURCES TABLE
-- Stores external resource metadata with optimistic versioning for conflict detection
CREATE TABLE IF NOT EXISTS resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_key VARCHAR(255) NOT NULL,
  resource_type VARCHAR(100) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  state JSONB,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_resources_key_type ON resources(resource_key, resource_type);
CREATE INDEX IF NOT EXISTS idx_resources_key ON resources(resource_key);

-- ============================================================================
-- STEP 3: Intent-Related Tables (with pgvector)
-- ============================================================================

-- INTENTS TABLE
-- Stores Interlock intent model with embeddings for semantic search
CREATE TABLE IF NOT EXISTS intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  intent_statement TEXT NOT NULL,
  embedding vector(1536),
  status VARCHAR(50) NOT NULL,
  expiration_at TIMESTAMP WITH TIME ZONE,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_intents_agent_id ON intents(agent_id);
CREATE INDEX IF NOT EXISTS idx_intents_task_id ON intents(task_id);
CREATE INDEX IF NOT EXISTS idx_intents_status ON intents(status);

-- IVFFlat index for vector similarity search (cosine distance)
CREATE INDEX IF NOT EXISTS idx_intents_embedding ON intents 
  USING ivfflat (embedding vector_cosine_ops) 
  WITH (lists = 100);

-- INTENT_READS TABLE
-- Tracks which resources an intent observed at which version for conflict detection
CREATE TABLE IF NOT EXISTS intent_reads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id UUID NOT NULL REFERENCES intents(id) ON DELETE CASCADE,
  resource_id UUID NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  observed_version INTEGER NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  
  UNIQUE(intent_id, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_intent_reads_intent_id ON intent_reads(intent_id);
CREATE INDEX IF NOT EXISTS idx_intent_reads_resource_id ON intent_reads(resource_id);

-- INTENT_STEPS TABLE
-- Tracks individual steps of an intent with dependencies for selective invalidation
CREATE TABLE IF NOT EXISTS intent_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id UUID NOT NULL REFERENCES intents(id) ON DELETE CASCADE,
  step_number INTEGER NOT NULL,
  description TEXT,
  dependencies JSONB,
  status VARCHAR(50) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_intent_steps_intent_id ON intent_steps(intent_id);
CREATE INDEX IF NOT EXISTS idx_intent_steps_intent_number ON intent_steps(intent_id, step_number);
CREATE INDEX IF NOT EXISTS idx_intent_steps_status ON intent_steps(status);

-- ============================================================================
-- STEP 4: Conflict Detection Tables
-- ============================================================================

-- CONFLICTS TABLE
-- Records detected conflicts between intents with resolution metadata
CREATE TABLE IF NOT EXISTS conflicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id UUID NOT NULL REFERENCES intents(id) ON DELETE CASCADE,
  conflicting_intent_id UUID NOT NULL REFERENCES intents(id) ON DELETE CASCADE,
  conflict_type VARCHAR(50) NOT NULL,
  severity VARCHAR(50) NOT NULL,
  reason TEXT,
  decision VARCHAR(50),
  affected_steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  preserved_steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conflicts_intent_id ON conflicts(intent_id);
CREATE INDEX IF NOT EXISTS idx_conflicts_conflicting_intent_id ON conflicts(conflicting_intent_id);
CREATE INDEX IF NOT EXISTS idx_conflicts_severity ON conflicts(severity);
CREATE INDEX IF NOT EXISTS idx_conflicts_intent_decision ON conflicts(intent_id, decision);

-- ============================================================================
-- STEP 5: Action Protocol Tables (Anchor)
-- ============================================================================

-- ACTIONS TABLE
-- Stores Anchor action state machine with crash-safe semantics
CREATE TABLE IF NOT EXISTS actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  action_type VARCHAR(100) NOT NULL,
  arguments JSONB NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL UNIQUE,
  status VARCHAR(50) NOT NULL,
  external_reference VARCHAR(255),
  lease_acquired_at TIMESTAMP WITH TIME ZONE,
  lease_expires_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_actions_idempotency_key ON actions(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_actions_agent_status ON actions(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status);
CREATE INDEX IF NOT EXISTS idx_actions_lease_expires_at ON actions(lease_expires_at);

-- ACTION_EVIDENCE TABLE
-- Records evidence for action status determination (used in reconciliation)
CREATE TABLE IF NOT EXISTS action_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id UUID NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
  source VARCHAR(100) NOT NULL,
  evidence_type VARCHAR(100) NOT NULL,
  external_reference VARCHAR(255),
  payload JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_action_evidence_action_id ON action_evidence(action_id);
CREATE INDEX IF NOT EXISTS idx_action_evidence_type ON action_evidence(evidence_type);

-- ============================================================================
-- STEP 6: Phase 5 Extensions (Episodes, Managed Clusters)
-- ============================================================================

-- EPISODES TABLE
-- Stores recovery narratives with embeddings for semantic search
-- Used in Anchor crash recovery and memory persistence
CREATE TABLE IF NOT EXISTS episodes (
  episode_id VARCHAR(255) PRIMARY KEY,
  narrative TEXT NOT NULL,
  outcome VARCHAR(50) NOT NULL,
  embedding vector(1536),
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  expires_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_episodes_status ON episodes(status);
CREATE INDEX IF NOT EXISTS idx_episodes_expires_at ON episodes(expires_at);

-- IVFFlat index for vector similarity search (cosine distance)
CREATE INDEX IF NOT EXISTS idx_episodes_embedding ON episodes 
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- MANAGED_CLUSTERS TABLE
-- Stores cluster state mutations with optimistic versioning
-- Used for world-state tracking in Anchor Phase 3
CREATE TABLE IF NOT EXISTS managed_clusters (
  cluster_id VARCHAR(255) PRIMARY KEY,
  scope_key VARCHAR(255) NOT NULL,
  desired_nodes INT NOT NULL DEFAULT 0,
  last_action VARCHAR(255),
  version INT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_managed_clusters_version ON managed_clusters(version);
CREATE INDEX IF NOT EXISTS idx_managed_clusters_scope_key ON managed_clusters(scope_key);

-- ============================================================================
-- STEP 7: pgvector Dimension Fix
-- ============================================================================
-- Apply these ALTER statements to fix embedding dimensions from 1536 to 1024
-- (Required: pgvector must be enabled first)

ALTER TABLE IF EXISTS intents
  ALTER COLUMN embedding TYPE vector(1024);

ALTER TABLE IF EXISTS episodes
  ALTER COLUMN embedding TYPE vector(1024);

-- Recreate episodes embedding index after dimension fix
DROP INDEX IF EXISTS idx_episodes_embedding;

CREATE INDEX IF NOT EXISTS idx_episodes_embedding ON episodes 
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- ============================================================================
-- ============================================================================
-- SETUP COMPLETE
-- ============================================================================
-- All required tables and indexes are now created
-- Ready to run Agent Safety MCP application
-- ============================================================================
