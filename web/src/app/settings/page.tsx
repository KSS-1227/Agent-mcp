"use client";

import React, { useEffect, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { TableSkeleton } from "@/components/ui/LoadingSkeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { useDashboard } from "@/lib/dashboard-context";
import { Lock, HelpCircle, Database, ShieldCheck } from "lucide-react";

interface VerifiedFlag {
  verified: boolean;
}

/** One health-daemon request as measured by the dashboard server. */
interface HealthProbe {
  ok: boolean;
  httpStatus?: number;
  latencyMs: number;
  timeoutMs: number;
  errorCode?: string | null;
  errorDetail?: string | null;
}

interface SettingsConfig {
  serviceName: string;
  version: string;
  mode: string;
  source: string;
  checkedAt: string;
  auth: { mode: string; sessionTtlSeconds: number; multiUser: boolean; note: string };
  database: {
    configured: boolean;
    reachable: boolean;
    latencyMs: number | null;
    errorCode: string | null;
    pgvector: VerifiedFlag & { installed: boolean | null; version: string | null };
  };
  backend: {
    configured: boolean;
    reachable: boolean;
    liveness: boolean;
    readiness: boolean;
    errorCode: string | null;
    errorDetail: string | null;
    endpoints: { live: HealthProbe; ready: HealthProbe } | null;
  };
  provider: VerifiedFlag & { name: string | null; model: string | null; note: string };
  backendRuntime: VerifiedFlag & {
    registeredToolCount: number | null;
    leaseDurationSeconds: number | null;
    semanticThreshold: number | null;
    reconcilerActive: boolean | null;
    note: string;
  };
  dataSources: Array<{ table: string; writtenByBackend: boolean; dashboardRead: boolean }>;
}

function Unverified() {
  return (
    <Badge variant="neutral" size="sm">
      NOT VERIFIED
    </Badge>
  );
}

/** Latency when the probe succeeded, otherwise its sanitized code plus the budget used. */
function probeLabel(name: "live" | "ready", probe: HealthProbe): string {
  if (probe.ok) return `/health/${name} ${probe.latencyMs}ms`;
  return `/health/${name} ${probe.errorCode ?? "FAILED"} · budget ${probe.timeoutMs}ms`;
}

export default function SettingsPage() {
  const { mode, refreshKey } = useDashboard();
  const [config, setConfig] = useState<SettingsConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    setLoading(true);
    fetch(`/api/settings?mode=${mode}`)
      .then(async (res) => {
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `Settings request failed (HTTP ${res.status})`);
        }
        return res.json();
      })
      .then((data) => {
        if (isMounted) {
          setConfig(data.config);
          setError(null);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (isMounted) {
          setError(err.message);
          setConfig(null);
          setLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [mode, refreshKey]);

  return (
    <AppLayout title="System Settings & Operational Health">
      {/* Security Disclaimer Banner */}
      <div className="bg-[#FAF4E8] border border-[#E9D8B4] p-3.5 rounded text-xs text-[#8C631B] flex items-start gap-2.5">
        <Lock className="w-4 h-4 text-[#B58533] shrink-0 mt-0.5" />
        <div className="space-y-0.5">
          <span className="font-semibold text-[#252722]">Security & Fail-Closed Guardrails</span>
          <p className="leading-relaxed">
            Database credentials, service-role keys and model API keys stay inside server
            processes. This page reports only what the web tier can observe; anything owned by the
            backend MCP process is labelled <strong>Not verified</strong> rather than guessed.
          </p>
        </div>
      </div>

      {loading ? (
        <TableSkeleton rows={4} />
      ) : error ? (
        <EmptyState title="Settings Unavailable" description={error} />
      ) : config ? (
        <div className="space-y-6">
          {/* Verified infrastructure state */}
          <Card
            title="Infrastructure Telemetry (measured by this dashboard process)"
            description={`Observed at ${new Date(config.checkedAt).toLocaleString()} · source: ${config.source}`}
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 text-xs">
              <div className="p-3 border border-[#E5E4DE] rounded bg-white space-y-1">
                <span className="text-[#777A73]">PostgreSQL Storage</span>
                <div className="flex items-center gap-2">
                  <Badge
                    variant={
                      !config.database.configured
                        ? "neutral"
                        : config.database.reachable
                          ? "success"
                          : "danger"
                    }
                    dot
                  >
                    {!config.database.configured
                      ? "Not Configured"
                      : config.database.reachable
                        ? "Reachable"
                        : "Unreachable"}
                  </Badge>
                  {config.database.reachable && config.database.latencyMs !== null && (
                    <span className="font-mono text-[10.5px] text-[#777A73]">
                      {config.database.latencyMs}ms
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-[#777A73] mt-1 font-mono">
                  {config.database.errorCode
                    ? `code: ${config.database.errorCode}`
                    : "SELECT 1 succeeded"}
                </div>
              </div>

              <div className="p-3 border border-[#E5E4DE] rounded bg-white space-y-1">
                <span className="text-[#777A73]">pgvector Extension</span>
                <div className="flex items-center gap-2">
                  {config.database.pgvector.verified ? (
                    <Badge
                      variant={config.database.pgvector.installed ? "success" : "warning"}
                      dot
                    >
                      {config.database.pgvector.installed ? "Installed" : "Missing"}
                    </Badge>
                  ) : (
                    <Unverified />
                  )}
                </div>
                <div className="text-[10px] text-[#777A73] mt-1 font-mono">
                  {config.database.pgvector.verified
                    ? `pg_extension${config.database.pgvector.version ? ` · v${config.database.pgvector.version}` : ""}`
                    : "extension catalogue not readable"}
                </div>
              </div>

              <div className="p-3 border border-[#E5E4DE] rounded bg-white space-y-1">
                <span className="text-[#777A73]">MCP Health Daemon</span>
                <div className="flex items-center gap-2">
                  <Badge
                    variant={
                      !config.backend.configured
                        ? "neutral"
                        : config.backend.readiness
                          ? "success"
                          : config.backend.reachable
                            ? "warning"
                            : "danger"
                    }
                    dot
                  >
                    {!config.backend.configured
                      ? "Not Configured"
                      : config.backend.readiness
                        ? "Ready"
                        : config.backend.reachable
                          ? "Not Ready"
                          : "Unreachable"}
                  </Badge>
                </div>
                <div className="text-[10px] text-[#777A73] mt-1 font-mono">
                  {config.backend.configured
                    ? config.backend.errorCode
                      ? `code: ${config.backend.errorCode}`
                      : "BACKEND_HEALTH_URL · /health/ready"
                    : "set BACKEND_HEALTH_URL to probe"}
                </div>
                {config.backend.endpoints && (
                  <div className="text-[10px] text-[#777A73] font-mono">
                    {probeLabel("live", config.backend.endpoints.live)} ·{" "}
                    {probeLabel("ready", config.backend.endpoints.ready)}
                  </div>
                )}
                {config.backend.errorDetail && (
                  <div className="text-[10px] text-[#8C631B] leading-relaxed">
                    {config.backend.errorDetail}
                  </div>
                )}
              </div>
            </div>
          </Card>

          {/* Dashboard session */}
          <Card
            title="Dashboard Access Control"
            description="Server-side session gate applied to every page and API route"
          >
            <div className="flex items-start justify-between gap-4 text-xs">
              <div className="space-y-1">
                <span className="font-medium text-[#252722]">
                  Operator token session ({config.auth.mode})
                </span>
                <p className="text-[11px] text-[#777A73] leading-relaxed max-w-2xl">
                  {config.auth.note} Session lifetime:{" "}
                  <span className="font-mono">{config.auth.sessionTtlSeconds}s</span>.
                </p>
              </div>
              <Badge variant="success" size="sm" dot>
                ENFORCED
              </Badge>
            </div>
          </Card>

          {/* Backend-owned facts that the dashboard cannot observe */}
          <Card
            title="Backend Runtime (not observable from the dashboard)"
            description="Owned by the MCP server process — reported as unverified instead of inferred"
          >
            <div className="divide-y divide-[#E5E4DE] text-xs">
              {[
                { label: "Adjudicator provider & model", value: config.provider.name ?? "unknown" },
                {
                  label: "Registered MCP tools",
                  value:
                    config.backendRuntime.registeredToolCount !== null
                      ? String(config.backendRuntime.registeredToolCount)
                      : "unknown",
                },
                {
                  label: "Action lease TTL",
                  value:
                    config.backendRuntime.leaseDurationSeconds !== null
                      ? `${config.backendRuntime.leaseDurationSeconds}s`
                      : "unknown",
                },
                {
                  label: "Semantic conflict threshold",
                  value:
                    config.backendRuntime.semanticThreshold !== null
                      ? String(config.backendRuntime.semanticThreshold)
                      : "unknown",
                },
                {
                  label: "Reconciler daemon active",
                  value:
                    config.backendRuntime.reconcilerActive !== null
                      ? String(config.backendRuntime.reconcilerActive)
                      : "unknown",
                },
              ].map((row) => (
                <div key={row.label} className="py-2.5 flex items-center justify-between gap-4">
                  <div>
                    <span className="font-medium text-[#252722]">{row.label}</span>
                    <div className="text-[11px] text-[#777A73] font-mono">{row.value}</div>
                  </div>
                  <Unverified />
                </div>
              ))}
            </div>
            <p className="text-[11px] text-[#777A73] leading-relaxed mt-3 flex items-start gap-1.5">
              <HelpCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              {config.backendRuntime.note}
            </p>
            <p className="text-[11px] text-[#777A73] leading-relaxed mt-1.5 flex items-start gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              {config.provider.note}
            </p>
          </Card>

          {/* Data source map */}
          <Card
            title="Data Sources"
            description="Which tables the unified backend writes, and which this dashboard reads"
          >
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider text-[#777A73] border-b border-[#E5E4DE]">
                    <th className="py-2 pr-4 font-semibold">Table</th>
                    <th className="py-2 pr-4 font-semibold">Written by backend</th>
                    <th className="py-2 font-semibold">Read by dashboard</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E5E4DE]">
                  {config.dataSources.map((source) => (
                    <tr key={source.table}>
                      <td className="py-2 pr-4 font-mono text-[11px] text-[#252722] flex items-center gap-1.5">
                        <Database className="w-3 h-3 text-[#777A73]" />
                        {source.table}
                      </td>
                      <td className="py-2 pr-4">
                        <Badge variant={source.writtenByBackend ? "success" : "danger"} size="sm">
                          {source.writtenByBackend ? "YES" : "NO — NOT PERSISTED"}
                        </Badge>
                      </td>
                      <td className="py-2">
                        <Badge variant={source.dashboardRead ? "neutral" : "neutral"} size="sm">
                          {source.dashboardRead ? "READ-ONLY" : "NOT READ"}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-[#777A73] leading-relaxed mt-3">
              <span className="font-mono">conflicts</span> and{" "}
              <span className="font-mono">action_evidence</span> exist in the migrations but no
              backend code path inserts into them. Conflict Monitor and the evidence ledger are
              therefore reported as unavailable rather than rendered as empty histories.
            </p>
          </Card>
        </div>
      ) : null}
    </AppLayout>
  );
}
