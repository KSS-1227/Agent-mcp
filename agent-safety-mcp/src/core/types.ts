/**
 * Core Unified Types - Shared between Anchor and Interlock
 *
 * These types define the common abstractions that both systems use:
 * - Agent: an autonomous actor with a persistent ID
 * - Resource: a versioned piece of shared state
 * - Task: a unit of work performed by an agent
 */

/**
 * Agent interface: represents an autonomous actor in the system.
 * Both Anchor and Interlock use this same abstraction.
 */
export interface Agent {
  id: string; // UUID
  key: string; // External key for identification
  name: string;
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Resource interface: represents versioned shared state.
 * Version increments on every write, enabling optimistic concurrency.
 */
export interface Resource {
  id: string; // UUID
  key: string; // External key
  type: string; // e.g., "document", "config", "user"
  version: number; // Increments on write
  state: Record<string, any>; // The actual data
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Task interface: represents a unit of work.
 * Shared across both Anchor and Interlock.
 */
export interface Task {
  id: string;
  agentId: string; // Links to Agent
  taskKey?: string; // External task identifier
  description?: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Plan step: a single action within a task's plan.
 * Used by Interlock for provenance tracking.
 */
export interface PlanStep {
  id: string;
  intentId: string;
  seq: number; // Sequence number within the plan
  description: string;
  embedding?: number[]; // Vector embedding for semantic matching
  status: "pending" | "done" | "invalidated" | "repaired";
  dependsOn?: string[]; // Resource IDs this step depends on
  createdAt: Date;
}

/**
 * Intent: a declared plan before execution (Interlock).
 * Combines agent intent with resource reads and plan steps.
 */
export interface Intent {
  id: string;
  agentId: string;
  taskId: string;
  statement: string; // Natural language description
  embedding?: number[]; // Vector embedding for conflict detection
  readHlc?: string; // Hybrid logical clock snapshot time
  status: "open" | "threatened" | "repairing" | "committed" | "aborted";
  recordedAt: Date;
  resolvedAt?: Date;
  validTo?: Date;
}

/**
 * Intent read: records which resources an intent read and at what version.
 */
export interface IntentRead {
  intentId: string;
  resourceId: string;
  observedVersion: number;
}

/**
 * Commit log entry: records every write to a resource.
 */
export interface CommitLog {
  id: string;
  agentId: string;
  intentId?: string;
  resourceId: string;
  prevVersion: number;
  newVersion: number;
  statement: string; // What the agent was doing
  embedding?: number[]; // For semantic conflict detection
  commitHlc?: string;
  committedAt: Date;
}

/**
 * Adjudication verdict: the conflict resolver's ruling.
 */
export type Verdict = "irrelevant" | "invalidating" | "fatal";

/**
 * Adjudication result: complete ruling on a conflict.
 */
export interface AdjudicationResult {
  verdict: Verdict;
  rationale: string;
  affectedSteps: number[]; // Sequence numbers of invalidated steps
  stepsTotal: number;
  model: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  providerError?: string;
}

/**
 * Provenance edge: tracks dependencies between resources and steps.
 */
export interface ProvenanceEdge {
  fromKind: "resource" | "step";
  fromId: string;
  toKind: "resource" | "step";
  toId: string;
}

/**
 * Conflict: detected when a commit threatens an open intent.
 */
export interface Conflict {
  commitId: string;
  intentId: string;
  detectedBy: "exact" | "graph" | "vector" | string; // Detection method
  distance?: number; // Semantic distance (if vector detected)
  adjudication?: AdjudicationResult;
}

/**
 * Usage tracking: records resource consumption (tokens, cost, energy).
 */
export interface Usage {
  label: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  tokensTotal: number;
  embedTokens: number;
  completionTokens: number;
  tokensWasted: number;
  wastedPct: number;
  usd: number;
  energy: {
    wh: number;
    kwh: number;
    gCO2e: number;
    whWasted: number;
    gCO2eWasted: number;
    assumption: string;
  };
  byModel: Record<string, { calls: number; tokensIn: number; tokensOut: number; usd: number }>;
}
