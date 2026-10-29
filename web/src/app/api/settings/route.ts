import { NextResponse } from "next/server";
import { checkBackendHealth, fetchDatabaseCapabilities, isDatabaseConfigured } from "@/lib/server-db";
import { SESSION_TTL_SECONDS, requireSession } from "@/lib/auth";

/**
 * Configuration/health report.
 *
 * Every value below is either (a) measured by this process right now, or
 * (b) a static architectural fact about this build. Nothing is inferred from the
 * dashboard's own environment on behalf of the backend, and no host, credential
 * or raw driver message is ever returned to the browser.
 */
export async function GET(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("mode");
  const health = await checkBackendHealth();

  const capabilities = isDatabaseConfigured() ? await fetchDatabaseCapabilities() : null;

  const safeConfig = {
    serviceName: "Agent Safety MCP Dashboard",
    version: "0.1.0",
    mode: mode === "demo" ? "demo" : "live",
    source: "web-tier observations",
    checkedAt: health.checkedAt,
    auth: {
      mode: "operator-token-session",
      sessionTtlSeconds: SESSION_TTL_SECONDS,
      multiUser: false,
      note: "Single operator access gate. There is no per-user identity or role model in this dashboard.",
    },
    database: {
      configured: health.database.configured,
      reachable: health.database.reachable,
      latencyMs: health.database.latencyMs ?? null,
      errorCode: health.database.errorCode ?? null,
      pgvector: capabilities && capabilities.ok
        ? {
            verified: true,
            installed: capabilities.data.pgvectorInstalled,
            version: capabilities.data.pgvectorVersion,
          }
        : {
            verified: false,
            installed: null,
            version: null,
          },
    },
    backend: {
      configured: health.backend.configured,
      reachable: health.backend.reachable,
      liveness: health.backend.liveness,
      readiness: health.backend.readiness,
      errorCode: health.backend.errorCode ?? null,
      // Already sanitized in the probe: endpoint, code, latency and budget only.
      errorDetail: health.backend.errorDetail ?? null,
      endpoints: health.backend.endpoints ?? null,
    },
    provider: {
      verified: false,
      name: null,
      model: null,
      note: "The Agent Safety MCP backend exposes no adjudicator/provider health endpoint, so provider name, model and availability are not verified by the dashboard.",
    },
    backendRuntime: {
      verified: false,
      registeredToolCount: null,
      leaseDurationSeconds: null,
      semanticThreshold: null,
      reconcilerActive: null,
      note: "Tool registration, lease TTL, semantic threshold and the reconciler daemon live inside the MCP backend process. The web tier cannot observe them, so they are reported as unverified rather than inferred from unrelated environment variables.",
    },
    /**
     * Static facts about the unified backend, verified against
     * agent-safety-mcp/src: which tables it writes and which the dashboard reads.
     */
    dataSources: [
      { table: "agents", writtenByBackend: true, dashboardRead: true },
      { table: "tasks", writtenByBackend: true, dashboardRead: false },
      { table: "intents", writtenByBackend: true, dashboardRead: true },
      { table: "intent_reads", writtenByBackend: true, dashboardRead: true },
      { table: "intent_steps", writtenByBackend: true, dashboardRead: true },
      { table: "resources", writtenByBackend: true, dashboardRead: true },
      { table: "actions", writtenByBackend: true, dashboardRead: true },
      { table: "action_resource_versions", writtenByBackend: true, dashboardRead: true },
      { table: "episodes", writtenByBackend: true, dashboardRead: true },
      { table: "managed_clusters", writtenByBackend: true, dashboardRead: false },
      { table: "conflicts", writtenByBackend: false, dashboardRead: false },
      { table: "action_evidence", writtenByBackend: false, dashboardRead: false },
    ],
  };

  return NextResponse.json({ config: safeConfig });
}
