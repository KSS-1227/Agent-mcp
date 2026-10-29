/**
 * Interlock Conflict Detection Types
 *
 * Types for the 5-step conflict detection and resolution pipeline:
 * 1. DECLARE - intent with reads and plan steps
 * 2. WATCH - detect threatened intents
 * 3. DIFF - replay snapshot and show changes
 * 4. ADJUDICATE - decide if conflict is irrelevant/invalidating/fatal
 * 5. RESOLVE - repair affected steps or abort
 */

import { Intent, IntentRead, PlanStep, CommitLog, Verdict, AdjudicationResult } from "../core/types";

/**
 * Intent status enum
 */
export enum IntentStatus {
  OPEN = "open",
  THREATENED = "threatened",
  REPAIRING = "repairing",
  COMMITTED = "committed",
  ABORTED = "aborted",
}

/**
 * Plan step status enum
 */
export enum StepStatus {
  PENDING = "pending",
  DONE = "done",
  INVALIDATED = "invalidated",
  REPAIRED = "repaired",
}

/**
 * Detection method enum
 */
export enum DetectionMethod {
  EXACT = "exact", // Read this row at older version
  GRAPH = "graph", // Provenance graph found dependency
  VECTOR = "vector", // Semantic similarity detected
}

/**
 * Declare step: agent declares intent with reads and plan
 */
export interface DeclareIntentRequest {
  agentId: string;
  taskId: string;
  statement: string; // Natural language description
  reads: Array<{ resourceId: string; observedVersion: number }>;
  steps: Array<{
    description: string;
    dependsOn?: string[]; // Resource IDs
    tokensUsed?: number;
  }>;
  embedSteps?: boolean;
  usage?: any;
}

/**
 * Watch step: found threatened intents
 */
export interface ThreadenedIntent {
  intentId: string;
  detectedBy: string; // "exact", "graph", "vector", or combined like "exact+graph"
  distance?: number; // Semantic distance if vector detected
  agentName: string;
  statement: string;
  readHlc?: string;
  agentId: string;
}

/**
 * Diff step: changes since snapshot
 */
export interface ResourceChange {
  resourceId: string;
  kind: string;
  key: string;
  thenVersion: number;
  nowVersion: number;
  thenBody?: Record<string, any>;
  nowBody?: Record<string, any>;
}

export interface DiffResult {
  source: "as_of_system_time" | "bitemporal_fallback" | "version_tracking" | "none" | "graph_prefilter";
  hlc?: string;
  changes: ResourceChange[];
}

/**
 * Adjudicate step: decide on conflict
 */
export interface AdjudicateRequest {
  commitId: string;
  intentId: string;
  tier?: "bulk" | "adjudicator" | "escalate";
  usage?: any;
}

export interface AdjudicateResponse extends AdjudicationResult {
  diff: DiffResult;
}

/**
 * Resolve step: record ruling and take action
 */
export interface ResolveRequest {
  commitId: string;
  intentId: string;
  adjudication: AdjudicationResult;
  detectedBy: string;
  distance?: number;
}

export interface ResolveResponse {
  adjudicationId: string;
  verdict: Verdict;
  repaired: boolean;
  affectedSteps?: number[];
  providerError?: string;
}

/**
 * Threatened intent result
 */
export interface ThreateneResult {
  intentId: string;
  how: string;
  distance: number | null;
}

/**
 * Conflict detection configuration
 */
export interface ConflictDetectionConfig {
  semanticThreshold?: number; // 0.58 default
  semanticK?: number; // 10 default
  investigationEnabled?: boolean;
  adjudicatorTier?: "bulk" | "adjudicator" | "escalate";
}

/**
 * Investigation request/response for adjudicator
 */
export interface InvestigationResult {
  name: string;
  rows: Record<string, any>[];
  error?: string;
}

/**
 * Evidence for adjudication
 */
export interface AdjudicationEvidence {
  intentStatement: string;
  commitStatement: string;
  resourceKind: string;
  resourceKey: string;
  resourceId: string;
  committingAgentId: string;
  changes: ResourceChange[];
  dependentSteps: number[];
  allSteps: Array<{ seq: number; description: string; tokensUsed: number }>;
}

