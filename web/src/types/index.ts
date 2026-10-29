/**
 * Agent Safety MCP Domain Types
 * Matches the actual backend schema in agent-safety-mcp
 */

export interface Agent {
  id: string; // UUID
  key: string;
  name: string;
  metadata?: {
    systemAgent?: boolean;
    purpose?: string;
    role?: string;
    permissions?: string[];
    [key: string]: any;
  };
  createdAt: string;
  updatedAt: string;
}

export interface Resource {
  id: string; // UUID
  key: string;
  type: string;
  version: number;
  state: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string; // UUID
  agentId: string;
  taskKey?: string;
  description?: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export type IntentStatus = "open" | "threatened" | "repairing" | "committed" | "aborted";

export interface PlanStep {
  id: string;
  intentId: string;
  seq: number;
  description: string;
  embedding?: number[];
  status: "pending" | "done" | "invalidated" | "repaired";
  dependsOn?: string[];
  createdAt: string;
}

export interface IntentRead {
  intentId: string;
  resourceId: string;
  resourceKey?: string;
  observedVersion: number;
  currentVersion?: number;
}

export interface Intent {
  id: string;
  agentId: string;
  agentKey?: string;
  agentName?: string;
  taskId?: string | null;
  statement: string;
  status: IntentStatus;
  /** intents.expiration_at — the only expiry the unified schema stores. */
  expirationAt?: string | null;
  /** intents.created_at, aliased to the dashboard vocabulary. */
  recordedAt: string;
  updatedAt?: string;
  reads?: IntentRead[];
  steps?: PlanStep[];
}

export type ConflictVerdict = "irrelevant" | "invalidating" | "fatal";

export interface AdjudicationResult {
  verdict: ConflictVerdict;
  rationale: string;
  affectedSteps: number[];
  stepsTotal: number;
  model: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  providerError?: string;
}

/**
 * Conflict adjudications are NOT persisted by the unified backend today.
 * This shape is only used by demo fixtures and the read-only provenance graph.
 */
export interface Conflict {
  id: string;
  commitId?: string;
  intentId: string;
  intentStatement?: string;
  agentId?: string;
  agentKey?: string;
  resourceId?: string;
  resourceKey?: string;
  detectedBy: "exact" | "graph" | "vector" | string;
  distance?: number;
  verdict: ConflictVerdict;
  rationale?: string;
  affectedSteps?: number[];
  stepsTotal?: number;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  latencyMs?: number;
  createdAt: string;
}

export type ActionStatus = "PENDING" | "COMMITTED" | "FAILED" | "ESCALATED";
export type EffectState = "NOT_STARTED" | "IN_PROGRESS" | "APPLIED" | "NOT_APPLIED" | "UNKNOWN";
export type ActionDisposition = "OWNED" | "ALREADY_COMMITTED" | "BUSY" | "ORPHANED" | "FAILED";
export type VerdictDisposition = "APPLIED" | "NOT_APPLIED" | "UNKNOWN" | number;

export interface Action {
  idemKey: string; // SHA-256
  episodeId: string;
  agentId: string;
  agentKey?: string;
  actionType: string;
  actionArgs: Record<string, any>;
  status: ActionStatus;
  leaseOwner?: string;
  leaseExpires?: string;
  externalRef?: string;
  outcome?: Record<string, any>;
  attempts: number;
  createdAt: string;
  resolvedAt?: string;
  effectState: EffectState;
  effectStartedAt?: string;
  effectCompletedAt?: string;
  verifierResponse?: VerdictDisposition | null;
  verifiedAt?: string | null;
  resourceVersions?: Array<{
    resourceId: string;
    resourceKey?: string;
    observedVersion: number;
  }>;
}

export interface ActionEvidence {
  id: string;
  actionKey: string;
  evidenceType: string;
  payload: Record<string, any>;
  verifiedAt: string;
}

export interface Episode {
  /** episodes.episode_id in the unified schema. */
  id: string;
  narrative: string;
  /** episodes.outcome is VARCHAR(50) in the unified schema. */
  outcome: string | Record<string, any>;
  status?: string;
  hasEmbedding?: boolean;
  createdAt: string;
  /** Demo fixtures only — the unified episodes table has no agent/task columns. */
  agentId?: string;
  agentKey?: string;
  taskId?: string;
}

export interface ProvenanceNode {
  id: string;
  label: string;
  type: "agent" | "intent" | "resource" | "conflict";
  status?: string;
  metadata?: Record<string, any>;
}

export interface ProvenanceEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  style?: "solid" | "dashed";
  status?: "safe" | "threatened" | "invalidated";
}

/**
 * Outcome of one health-daemon request, as observed by this server process.
 * Codes and details are authored by the web tier: they never carry the configured
 * origin, a credential or a raw driver message.
 */
export interface HealthEndpointProbe {
  ok: boolean;
  httpStatus?: number;
  latencyMs: number;
  /** Client-side budget this probe was allowed to use. */
  timeoutMs: number;
  /** TIMEOUT, CONNECTION_REFUSED, HOST_NOT_FOUND, UNREACHABLE, INVALID_RESPONSE or HTTP_<status>. */
  errorCode?: string;
  /** Public-safe sentence explaining `errorCode`. */
  errorDetail?: string;
}

/**
 * Only facts the dashboard process can actually verify are reported here.
 * Provider health, tool counts and lease TTLs live inside the MCP backend process
 * and are NOT observable from the web tier, so they are intentionally absent.
 */
export interface SystemHealth {
  status: "healthy" | "unhealthy" | "disconnected";
  mode: "live";
  database: {
    configured: boolean;
    reachable: boolean;
    latencyMs?: number;
    errorCode?: string;
  };
  backend: {
    configured: boolean;
    /** True when either endpoint returned any HTTP status. */
    reachable: boolean;
    liveness: boolean;
    readiness: boolean;
    errorCode?: string;
    errorDetail?: string;
    /** Absent when BACKEND_HEALTH_URL is unset or invalid, because nothing was probed. */
    endpoints?: { live: HealthEndpointProbe; ready: HealthEndpointProbe };
    recovery?: RecoveryRuntimeHealth | null;
  };
  provider: {
    /** Always false: the backend exposes no adjudicator health endpoint. */
    verified: false;
    note: string;
  };
  checkedAt: string;
}

export interface RecoveryRuntimeHealth {
  state: "disabled" | "starting" | "running" | "idle" | "error";
  enabled: boolean;
  productionVerifierCount: number;
  lastPassAt: string | null;
  lastPass: { claimed: number; committed: number; failed: number; escalated: number } | null;
  failure: boolean;
  observedAt: string;
}

export interface OverviewMetrics {
  registeredAgents: number;
  activeActions: number;
  /** null = the backend never persists conflict adjudications. */
  detectedConflicts: number | null;
  pendingRecoveries: number;
  totalCommitted: number;
  totalFailed: number;
  /** null = no committed/failed outcomes recorded yet (not 100%). */
  commitSuccessRate: number | null;
  recentActivity: Array<{
    id: string;
    type: "conflict" | "action" | "intent" | "recovery";
    title: string;
    description: string;
    timestamp: string;
    status: "success" | "warning" | "danger" | "neutral";
  }>;
}
