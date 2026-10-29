"use client";

import React, { useEffect, useState, useMemo } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Table } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Drawer } from "@/components/ui/Drawer";
import { TableSkeleton } from "@/components/ui/LoadingSkeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { useDashboard } from "@/lib/dashboard-context";
import { Intent, Resource } from "@/types";
import {
  Layers,
  Search,
  AlertTriangle,
  CheckCircle,
  FileText,
  Clock,
  ArrowRight,
  GitBranch,
} from "lucide-react";
import clsx from "clsx";

export default function IntentsAndResourcesPage() {
  const { mode, refreshKey } = useDashboard();
  const [activeTab, setActiveTab] = useState<"intents" | "resources">("intents");
  const [intents, setIntents] = useState<Intent[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedIntent, setSelectedIntent] = useState<Intent | null>(null);
  const [selectedResource, setSelectedResource] = useState<Resource | null>(null);

  useEffect(() => {
    let isMounted = true;
    setLoading(true);
    Promise.all([
      fetch(`/api/intents?mode=${mode}`).then(async (res) => {
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `Intents request failed (HTTP ${res.status})`);
        }
        return res.json();
      }),
      fetch(`/api/resources?mode=${mode}`).then(async (res) => {
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `Resources request failed (HTTP ${res.status})`);
        }
        return res.json();
      }),
    ])
      .then(([intentsRes, resourcesRes]) => {
        if (isMounted) {
          setIntents(intentsRes.data || []);
          setResources(resourcesRes.data || []);
          setError(null);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (isMounted) {
          setError(err.message || "Failed to load intents and resources");
          setIntents([]);
          setResources([]);
          setLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [mode, refreshKey]);

  const filteredIntents = useMemo(() => {
    return intents.filter(
      (i) =>
        i.statement.toLowerCase().includes(search.toLowerCase()) ||
        i.agentKey?.toLowerCase().includes(search.toLowerCase()) ||
        i.id.toLowerCase().includes(search.toLowerCase())
    );
  }, [intents, search]);

  const filteredResources = useMemo(() => {
    return resources.filter(
      (r) =>
        r.key.toLowerCase().includes(search.toLowerCase()) ||
        r.type.toLowerCase().includes(search.toLowerCase())
    );
  }, [resources, search]);

  const intentColumns = [
    {
      header: "Intent & Statement",
      cell: (intent: Intent) => (
        <div className="max-w-md">
          <div className="font-medium text-[#252722] line-clamp-2">{intent.statement}</div>
          <div className="text-[11px] font-mono text-[#777A73] mt-0.5">
            id: {intent.id.slice(0, 8)}... · task: {intent.taskId?.slice(0, 8) || "none"}
          </div>
        </div>
      ),
    },
    {
      header: "Agent",
      cell: (intent: Intent) => (
        <span className="font-mono text-xs text-[#252722]">
          {intent.agentKey || intent.agentId.slice(0, 8)}
        </span>
      ),
    },
    {
      header: "Status",
      cell: (intent: Intent) => {
        const variant =
          intent.status === "committed"
            ? "success"
            : intent.status === "threatened"
            ? "warning"
            : intent.status === "aborted"
            ? "danger"
            : "neutral";
        return (
          <Badge variant={variant} dot>
            {intent.status.toUpperCase()}
          </Badge>
        );
      },
    },
    {
      header: "Observed Reads",
      cell: (intent: Intent) => {
        const reads = intent.reads || [];
        if (reads.length === 0) {
          return <span className="text-[11px] text-[#777A73]">None</span>;
        }
        return (
          <div className="space-y-1">
            {reads.map((r, idx) => {
              const isDrifted = r.currentVersion && r.observedVersion !== r.currentVersion;
              return (
                <div key={idx} className="flex items-center gap-1.5 text-[11px]">
                  <span className="font-mono text-[#252722]">{r.resourceKey || r.resourceId.slice(0, 8)}</span>
                  <span
                    className={clsx(
                      "px-1 py-0.2 rounded font-mono text-[10px]",
                      isDrifted
                        ? "bg-[#FAF4E8] text-[#8C631B] border border-[#E9D8B4] font-semibold"
                        : "bg-[#F3F4F6] text-[#777A73]"
                    )}
                  >
                    obs: v{r.observedVersion} {isDrifted ? `(cur: v${r.currentVersion})` : ""}
                  </span>
                </div>
              );
            })}
          </div>
        );
      },
    },
    {
      header: "Inspect",
      align: "right" as const,
      cell: (intent: Intent) => (
        <Button variant="outline" size="sm" onClick={() => setSelectedIntent(intent)}>
          Plan Steps ({intent.steps?.length || 0})
        </Button>
      ),
    },
  ];

  const resourceColumns = [
    {
      header: "Resource Key",
      cell: (res: Resource) => (
        <div>
          <span className="font-mono font-medium text-xs text-[#252722]">{res.key}</span>
          <div className="text-[10.5px] font-mono text-[#777A73]">{res.id}</div>
        </div>
      ),
    },
    {
      header: "Type",
      cell: (res: Resource) => (
        <span className="text-xs bg-[#F3F4F6] px-2 py-0.5 rounded border border-[#E5E7EB] text-[#4B5563]">
          {res.type}
        </span>
      ),
    },
    {
      header: "Current Version",
      cell: (res: Resource) => (
        <Badge variant="olive" size="sm">
          v{res.version}
        </Badge>
      ),
    },
    {
      header: "Last Updated",
      cell: (res: Resource) => (
        <span className="font-mono text-[11px] text-[#777A73]">
          {new Date(res.updatedAt).toLocaleString()}
        </span>
      ),
    },
    {
      header: "State Payload",
      align: "right" as const,
      cell: (res: Resource) => (
        <Button variant="outline" size="sm" onClick={() => setSelectedResource(res)}>
          Inspect State
        </Button>
      ),
    },
  ];

  return (
    <AppLayout title="Intents & Resources">
      {/* Tabs & Search */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 bg-white p-3 border border-[#E5E4DE] rounded-md">
        <div className="flex items-center bg-[#F6F5F1] p-0.5 rounded border border-[#E5E4DE]">
          <button
            onClick={() => setActiveTab("intents")}
            className={clsx(
              "px-3 py-1.5 text-xs font-medium rounded transition-all",
              activeTab === "intents"
                ? "bg-white text-[#252722] shadow-2xs font-semibold"
                : "text-[#777A73] hover:text-[#252722]"
            )}
          >
            Declared Intents ({intents.length})
          </button>
          <button
            onClick={() => setActiveTab("resources")}
            className={clsx(
              "px-3 py-1.5 text-xs font-medium rounded transition-all",
              activeTab === "resources"
                ? "bg-white text-[#252722] shadow-2xs font-semibold"
                : "text-[#777A73] hover:text-[#252722]"
            )}
          >
            Protected Resources ({resources.length})
          </button>
        </div>

        <div className="relative flex-1 max-w-sm">
          <Search className="w-4 h-4 text-[#777A73] absolute left-2.5 top-2.5" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={
              activeTab === "intents"
                ? "Filter by statement or agent..."
                : "Filter by resource key or type..."
            }
            className="w-full text-xs bg-[#F9F8F5] border border-[#E5E4DE] rounded pl-8 pr-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-[#52745B] focus:border-[#52745B]"
          />
        </div>
      </div>

      {loading ? (
        <TableSkeleton rows={5} />
      ) : error ? (
        <EmptyState title="Telemetry Load Failed" description={error} />
      ) : activeTab === "intents" ? (
        <Table
          columns={intentColumns}
          data={filteredIntents}
          keyExtractor={(i) => i.id}
          onRowClick={(intent) => setSelectedIntent(intent)}
          emptyMessage="No declared intents found."
        />
      ) : (
        <Table
          columns={resourceColumns}
          data={filteredResources}
          keyExtractor={(r) => r.id}
          onRowClick={(res) => setSelectedResource(res)}
          emptyMessage="No protected resources registered."
        />
      )}

      {/* Plan Step Breakdown Drawer */}
      <Drawer
        isOpen={Boolean(selectedIntent)}
        onClose={() => setSelectedIntent(null)}
        title="Intent Plan & Provenance"
        subtitle={`Agent: ${selectedIntent?.agentKey || selectedIntent?.agentId}`}
        badge={
          <Badge
            variant={
              selectedIntent?.status === "committed"
                ? "success"
                : selectedIntent?.status === "threatened"
                ? "warning"
                : "neutral"
            }
            dot
          >
            {selectedIntent?.status?.toUpperCase()}
          </Badge>
        }
      >
        {selectedIntent && (
          <div className="space-y-4">
            <div className="bg-[#F9F8F5] p-3 rounded border border-[#E5E4DE] space-y-2">
              <span className="text-[11px] font-semibold text-[#777A73] uppercase tracking-wider">
                Statement of Intent
              </span>
              <p className="text-xs font-medium text-[#252722]">{selectedIntent.statement}</p>
              <div className="text-[10.5px] font-mono text-[#777A73]">
                Recorded: {new Date(selectedIntent.recordedAt).toLocaleString()}
                {selectedIntent.expirationAt
                  ? ` · Expires: ${new Date(selectedIntent.expirationAt).toLocaleString()}`
                  : " · Expires: no expiry recorded"}
              </div>
            </div>

            {/* Version Drift Comparison */}
            <div>
              <h4 className="text-xs font-semibold text-[#252722] mb-2">
                Resource Version Observations
              </h4>
              {!selectedIntent.reads || selectedIntent.reads.length === 0 ? (
                <div className="p-3 text-xs text-[#777A73] border border-[#E5E4DE] rounded bg-white">
                  No prior reads declared for this intent.
                </div>
              ) : (
                <div className="space-y-2">
                  {selectedIntent.reads.map((r, idx) => {
                    const isDrifted = r.currentVersion && r.observedVersion !== r.currentVersion;
                    return (
                      <div
                        key={idx}
                        className={clsx(
                          "p-3 rounded border text-xs flex items-center justify-between",
                          isDrifted
                            ? "bg-[#FAF4E8] border-[#E9D8B4]"
                            : "bg-white border-[#E5E4DE]"
                        )}
                      >
                        <div>
                          <div className="font-mono font-medium text-[#252722]">
                            {r.resourceKey || r.resourceId}
                          </div>
                          <div className="text-[11px] text-[#777A73] mt-0.5">
                            Observed: v{r.observedVersion} · Current: v{r.currentVersion || r.observedVersion}
                          </div>
                        </div>
                        {isDrifted ? (
                          <Badge variant="warning" dot>
                            VERSION THREATENED (v{r.observedVersion} != v{r.currentVersion})
                          </Badge>
                        ) : (
                          <Badge variant="success" dot>
                            VERSION ALIGNED
                          </Badge>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Discrete Plan Steps */}
            <div>
              <h4 className="text-xs font-semibold text-[#252722] mb-2">
                Discrete Plan Steps ({selectedIntent.steps?.length || 0})
              </h4>
              {!selectedIntent.steps || selectedIntent.steps.length === 0 ? (
                <div className="p-3 text-xs text-[#777A73] border border-[#E5E4DE] rounded bg-white">
                  No discrete steps recorded.
                </div>
              ) : (
                <div className="space-y-2">
                  {selectedIntent.steps.map((step) => (
                    <div
                      key={step.id}
                      className={clsx(
                        "p-3 border rounded text-xs space-y-1",
                        step.status === "invalidated"
                          ? "bg-[#F9ECEB] border-[#E5BCB9]"
                          : step.status === "done"
                          ? "bg-[#EEF3EE] border-[#C8D7CA]"
                          : "bg-white border-[#E5E4DE]"
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono font-semibold text-[11px] text-[#252722]">
                          Step {step.seq}
                        </span>
                        <Badge
                          variant={
                            step.status === "invalidated"
                              ? "danger"
                              : step.status === "done"
                              ? "success"
                              : "neutral"
                          }
                        >
                          {step.status.toUpperCase()}
                        </Badge>
                      </div>
                      <p className="text-xs text-[#252722]">{step.description}</p>
                      {step.dependsOn && step.dependsOn.length > 0 && (
                        <div className="text-[10px] font-mono text-[#777A73]">
                          Depends on resource: {step.dependsOn.join(", ")}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Drawer>

      {/* Resource Detail Drawer */}
      <Drawer
        isOpen={Boolean(selectedResource)}
        onClose={() => setSelectedResource(null)}
        title={selectedResource?.key || "Resource"}
        subtitle={`Type: ${selectedResource?.type}`}
        badge={
          <Badge variant="olive" size="sm">
            VERSION {selectedResource?.version}
          </Badge>
        }
      >
        {selectedResource && (
          <div className="space-y-4">
            <div className="bg-[#F9F8F5] p-3 rounded border border-[#E5E4DE] space-y-1 text-xs">
              <div>
                <span className="text-[#777A73]">Resource UUID:</span>{" "}
                <span className="font-mono">{selectedResource.id}</span>
              </div>
              <div>
                <span className="text-[#777A73]">Current Version:</span>{" "}
                <span className="font-mono font-bold">v{selectedResource.version}</span>
              </div>
              <div>
                <span className="text-[#777A73]">Last Mutated:</span>{" "}
                <span className="font-mono">
                  {new Date(selectedResource.updatedAt).toLocaleString()}
                </span>
              </div>
            </div>

            <div>
              <span className="text-xs font-semibold text-[#252722] block mb-2">
                Persisted State Payload (JSON)
              </span>
              <pre className="text-[11px] font-mono bg-white p-3 rounded border border-[#E5E4DE] overflow-x-auto text-[#252722] leading-relaxed">
                {JSON.stringify(selectedResource.state, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </Drawer>
    </AppLayout>
  );
}

