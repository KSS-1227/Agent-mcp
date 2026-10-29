"use client";

import React, { useEffect, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Table } from "@/components/ui/Table";
import { EmptyState } from "@/components/ui/EmptyState";
import { TableSkeleton } from "@/components/ui/LoadingSkeleton";
import { useDashboard } from "@/lib/dashboard-context";
import { OverviewMetrics } from "@/types";
import {
  Users,
  Activity,
  ShieldAlert,
  LifeBuoy,
  CheckCircle,
  Database,
  Cpu,
  ArrowUpRight,
  TrendingUp,
} from "lucide-react";
import Link from "next/link";

export default function OverviewPage() {
  const { mode, refreshKey, health } = useDashboard();
  const [metrics, setMetrics] = useState<OverviewMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    setLoading(true);
    fetch(`/api/overview?mode=${mode}`)
      .then(async (res) => {
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || "Failed to load overview telemetry");
        }
        return res.json();
      })
      .then((data) => {
        if (isMounted) {
          setMetrics(data.data);
          setError(null);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (isMounted) {
          setError(err.message);
          setMetrics(null);
          setLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [mode, refreshKey]);

  return (
    <AppLayout title="System Overview">
      {/* Top Banner Explaining Telemetry Source */}
      <div className="bg-white border border-[#E5E4DE] rounded-md px-4 py-3 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-[#777A73]">
            Safety Protocol Status
          </h2>
          <p className="text-sm font-semibold text-[#252722] mt-0.5">
            Unified Agent Orchestration & Crash-Safe Action Recovery
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-[#777A73]">Telemetry Source:</span>
          <span className="font-mono bg-[#F3F4F6] px-2 py-0.5 rounded text-[#252722] border border-[#E5E7EB]">
            {mode === "demo" ? "demo-fixtures (static)" : "postgresql (live cluster)"}
          </span>
        </div>
      </div>

      {loading ? (
        <TableSkeleton rows={4} />
      ) : error ? (
        <EmptyState
          title="Backend Telemetry Unavailable"
          description={error}
          action={
            <Link
              href="/settings"
              className="px-3 py-1.5 text-xs bg-[#52745B] text-white rounded font-medium hover:bg-[#44624C]"
            >
              Inspect Backend Settings
            </Link>
          }
        />
      ) : metrics ? (
        <>
          {/* Key Metric Tiles */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Metric 1 */}
            <Card className="p-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-[#777A73]">Registered Agents</span>
                <Users className="w-4 h-4 text-[#777A73]" />
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-2xl font-bold font-mono text-[#252722]">
                  {metrics.registeredAgents}
                </span>
                <span className="text-[11px] text-[#777A73]">verified actors</span>
              </div>
              <div className="mt-3 pt-2 border-t border-[#E5E4DE] flex items-center justify-between text-[11px] text-[#777A73]">
                <span>Source: table `agents`</span>
                <Link href="/agents" className="text-[#52745B] hover:underline flex items-center">
                  View <ArrowUpRight className="w-3 h-3 ml-0.5" />
                </Link>
              </div>
            </Card>

            {/* Metric 2 */}
            <Card className="p-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-[#777A73]">Active Actions</span>
                <Activity className="w-4 h-4 text-[#B58533]" />
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-2xl font-bold font-mono text-[#252722]">
                  {metrics.activeActions}
                </span>
                <span className="text-[11px] text-[#8C631B]">status = PENDING</span>
              </div>
              <div className="mt-3 pt-2 border-t border-[#E5E4DE] flex items-center justify-between text-[11px] text-[#777A73]">
                <span>Source: table `actions`</span>
                <Link href="/actions" className="text-[#52745B] hover:underline flex items-center">
                  Lifecycle <ArrowUpRight className="w-3 h-3 ml-0.5" />
                </Link>
              </div>
            </Card>

            {/* Metric 3 */}
            <Card className="p-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-[#777A73]">Detected Conflicts</span>
                <ShieldAlert className="w-4 h-4 text-[#A8423F]" />
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-2xl font-bold font-mono text-[#252722]">
                  {metrics.detectedConflicts === null ? "—" : metrics.detectedConflicts}
                </span>
                <span className="text-[11px] text-[#777A73]">not persisted</span>
              </div>
              <div className="mt-3 pt-2 border-t border-[#E5E4DE] flex items-center justify-between text-[11px] text-[#777A73]">
                <span>Source: no `conflicts` writer</span>
                <Link href="/conflicts" className="text-[#52745B] hover:underline flex items-center">
                  Monitor <ArrowUpRight className="w-3 h-3 ml-0.5" />
                </Link>
              </div>
            </Card>

            {/* Metric 4 */}
            <Card className="p-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-[#777A73]">Pending Recoveries</span>
                <LifeBuoy className="w-4 h-4 text-[#B58533]" />
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-2xl font-bold font-mono text-[#252722]">
                  {metrics.pendingRecoveries}
                </span>
                <span className="text-[11px] text-[#8C631B]">orphaned / expired</span>
              </div>
              <div className="mt-3 pt-2 border-t border-[#E5E4DE] flex items-center justify-between text-[11px] text-[#777A73]">
                <span>Source: expired leases</span>
                <Link href="/recovery" className="text-[#52745B] hover:underline flex items-center">
                  Reconcile <ArrowUpRight className="w-3 h-3 ml-0.5" />
                </Link>
              </div>
            </Card>
          </div>

          {/* Action Outcomes Breakdown & Component Health */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Outcome Stats Card */}
            <Card
              title="Action Execution Outcomes"
              description="Historical external-action commit versus rejection totals"
              className="lg:col-span-1"
            >
              <div className="space-y-4">
                <div className="flex items-center justify-between py-2 border-b border-[#E5E4DE]">
                  <span className="text-xs text-[#777A73]">Atomic Commits (COMMITTED)</span>
                  <Badge variant="success" dot>
                    {metrics.totalCommitted} Succeeded
                  </Badge>
                </div>
                <div className="flex items-center justify-between py-2 border-b border-[#E5E4DE]">
                  <span className="text-xs text-[#777A73]">Verified Failures (FAILED)</span>
                  <Badge variant="danger" dot>
                    {metrics.totalFailed} Rejected
                  </Badge>
                </div>
                <div className="flex items-center justify-between py-2 border-b border-[#E5E4DE]">
                  <span className="text-xs text-[#777A73]">Commit Reliability Rate</span>
                  <span className="font-mono font-bold text-[#52745B]">
                    {metrics.commitSuccessRate === null
                      ? "—"
                      : `${metrics.commitSuccessRate}%`}
                  </span>
                </div>
                {metrics.commitSuccessRate === null && (
                  <p className="text-[11px] text-[#777A73]">
                    No COMMITTED or FAILED actions recorded yet, so no reliability rate exists.
                  </p>
                )}

                <div className="pt-2 text-[11px] text-[#777A73] leading-relaxed">
                  <p>
                    <strong>Invariant:</strong> Phase 3 commits intent resolution, world state,
                    and episode embeddings inside a single serializable PostgreSQL transaction.
                  </p>
                </div>
              </div>
            </Card>

            {/* Core Component Health Status Card — every tile reflects a real probe */}
            <Card
              title="System Component Status"
              description="Only subsystems the dashboard can actually probe are asserted here"
              className="lg:col-span-2"
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="p-3 border border-[#E5E4DE] rounded bg-[#F9F8F5]">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-[#252722]">PostgreSQL Storage</span>
                    <Badge
                      variant={
                        !health?.database.configured
                          ? "neutral"
                          : health.database.reachable
                            ? "success"
                            : "danger"
                      }
                      dot
                    >
                      {!health
                        ? "Checking"
                        : !health.database.configured
                          ? "Not Configured"
                          : health.database.reachable
                            ? "Reachable"
                            : "Unreachable"}
                    </Badge>
                  </div>
                  <p className="text-[11px] text-[#777A73] mt-1.5">
                    {health?.database.reachable && health.database.latencyMs !== undefined
                      ? `SELECT 1 round-trip ${health.database.latencyMs}ms.`
                      : health?.database.errorCode
                        ? `Probe code: ${health.database.errorCode}.`
                        : "No database probe recorded yet."}
                  </p>
                </div>

                <div className="p-3 border border-[#E5E4DE] rounded bg-[#F9F8F5]">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-[#252722]">MCP Health Daemon</span>
                    <Badge
                      variant={
                        !health?.backend.configured
                          ? "neutral"
                          : health.backend.readiness
                            ? "success"
                            : health.backend.reachable
                              ? "warning"
                              : "danger"
                      }
                      dot
                    >
                      {!health
                        ? "Checking"
                        : !health.backend.configured
                          ? "Not Configured"
                          : health.backend.readiness
                            ? "Ready"
                            : health.backend.reachable
                              ? "Not Ready"
                              : "Unreachable"}
                    </Badge>
                  </div>
                  <p className="text-[11px] text-[#777A73] mt-1.5">
                    {!health
                      ? "No health probe recorded yet."
                      : !health.backend.configured
                        ? "BACKEND_HEALTH_URL is not set, so the daemon is not probed."
                        : health.backend.readiness
                          ? `/health/ready answered 200 in ${health.backend.endpoints?.ready.latencyMs ?? "?"}ms.`
                          : health.backend.errorDetail ??
                            `Probe code: ${health.backend.errorCode ?? "NOT_READY"}.`}
                  </p>
                </div>

                <div className="p-3 border border-[#E5E4DE] rounded bg-[#F9F8F5]">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-[#252722]">Conflict Gate</span>
                    <Badge variant="neutral" dot>
                      NOT VERIFIED
                    </Badge>
                  </div>
                  <p className="text-[11px] text-[#777A73] mt-1.5">
                    Verdicts are returned to the calling agent in-process and never persisted, so
                    no history or telemetry can be verified here.
                  </p>
                </div>

                <div className="p-3 border border-[#E5E4DE] rounded bg-[#F9F8F5]">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-[#252722]">Action Reconciler</span>
                    <Badge variant="neutral" dot>
                      NOT VERIFIED
                    </Badge>
                  </div>
                  <p className="text-[11px] text-[#777A73] mt-1.5">
                    The reconciler runs inside the MCP backend process; its liveness and lease TTL
                    are not exposed to the dashboard.
                  </p>
                </div>
              </div>
              <div className="mt-3 text-[11px] text-[#777A73]">
                Provider and tool-registration details: see{" "}
                <Link href="/settings" className="text-[#52745B] hover:underline">
                  Settings
                </Link>
                .
              </div>
            </Card>
          </div>

          {/* Recent Operational Activity Feed */}
          <Card
            title="Recent Activity Feed"
            description="Chronological log of coordination, conflict detection, and reconciliation events"
          >
            <div className="divide-y divide-[#E5E4DE]">
              {metrics.recentActivity.length === 0 ? (
                <div className="py-6 text-center text-xs text-[#777A73]">
                  No action records exist yet, so there is no activity to report.
                </div>
              ) : (
                metrics.recentActivity.map((act) => (
                <div key={act.id} className="py-3 flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-[#252722]">{act.title}</span>
                      <Badge
                        variant={
                          act.status === "danger"
                            ? "danger"
                            : act.status === "warning"
                            ? "warning"
                            : act.status === "success"
                            ? "success"
                            : "neutral"
                        }
                      >
                        {act.type.toUpperCase()}
                      </Badge>
                    </div>
                    <p className="text-xs text-[#777A73]">{act.description}</p>
                  </div>
                  <span className="text-[11px] font-mono text-[#9B9E96] shrink-0">
                    {act.timestamp}
                  </span>
                </div>
                ))
              )}
            </div>
          </Card>
        </>
      ) : null}
    </AppLayout>
  );
}

