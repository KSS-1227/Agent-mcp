"use client";

import React, { useEffect, useState, useMemo } from "react";
import clsx from "clsx";
import { AppLayout } from "@/components/layout/AppLayout";
import { Table } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Drawer } from "@/components/ui/Drawer";
import { TableSkeleton } from "@/components/ui/LoadingSkeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { ConflictGraph, GraphNode } from "@/components/conflict/ConflictGraph";
import { useDashboard } from "@/lib/dashboard-context";
import { Conflict } from "@/types";
import {
  ShieldAlert,
  Search,
  Cpu,
  Clock,
  Layers,
  ArrowRight,
  GitBranch,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";

export default function ConflictMonitorPage() {
  const { mode, refreshKey } = useDashboard();
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [graphData, setGraphData] = useState<{
    nodes: GraphNode[];
    edges: any[];
    isDemo: boolean;
    truncated: string[];
  } | null>(null);
  const [provenanceNote, setProvenanceNote] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<{
    code: string;
    message: string;
    detail?: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedConflict, setSelectedConflict] = useState<Conflict | null>(null);
  const [selectedGraphNode, setSelectedGraphNode] = useState<GraphNode | null>(null);

  useEffect(() => {
    let isMounted = true;
    setLoading(true);
    setUnavailable(null);
    setProvenanceNote(null);

    // Live provenance is real and safe to read even though adjudications are not stored.
    const loadProvenance = async () => {
      if (mode !== "live") return;
      try {
        const res = await fetch("/api/provenance?mode=live");
        const body = await res.json().catch(() => ({}));
        if (!isMounted) return;
        if (!res.ok) {
          setGraphData(null);
          setProvenanceNote(body.error || "Live provenance could not be read.");
          return;
        }
        setGraphData(
          body.graph
            ? {
                nodes: body.graph.nodes ?? [],
                edges: body.graph.edges ?? [],
                isDemo: Boolean(body.isDemo),
                truncated: body.truncated ?? [],
              }
            : null
        );
        setProvenanceNote(body.note || null);
      } catch {
        if (isMounted) {
          setGraphData(null);
          setProvenanceNote("Live provenance could not be read.");
        }
      }
    };

    fetch(`/api/conflicts?mode=${mode}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!isMounted) return;

        // 501 = the backend does not persist adjudications. This is not an empty history.
        if (res.status === 501 && body.code === "CONFLICTS_NOT_PERSISTED") {
          setConflicts([]);
          // The provenance graph is loaded independently; leave it untouched here.
          setUnavailable({
            code: body.code,
            message: body.error || "Conflict adjudications are not persisted.",
            detail: body.detail,
          });
          setError(null);
          return;
        }

        if (!res.ok) {
          throw new Error(body.error || `Conflict request failed (HTTP ${res.status})`);
        }

        setConflicts(body.data || []);
        if (mode === "demo") {
          setGraphData(
            body.graph
              ? { nodes: body.graph.nodes ?? [], edges: body.graph.edges ?? [], isDemo: true, truncated: [] }
              : null
          );
        }
        setError(null);
      })
      .catch((err) => {
        if (isMounted) {
          setError(err.message);
          setConflicts([]);
          if (mode === "demo") setGraphData(null);
        }
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    void loadProvenance();

    return () => {
      isMounted = false;
    };
  }, [mode, refreshKey]);

  const graphCounts = useMemo(() => {
    const nodes = graphData?.nodes ?? [];
    const countOf = (type: GraphNode["type"]) => nodes.filter((n) => n.type === type).length;
    return {
      nodes: nodes.length,
      edges: graphData?.edges.length ?? 0,
      agents: countOf("agent"),
      intents: countOf("intent"),
      resources: countOf("resource"),
      conflicts: countOf("conflict"),
    };
  }, [graphData]);

  const columns = [
    {
      header: "Conflict Identifier & Detection",
      cell: (c: Conflict) => (
        <div>
          <span className="font-mono font-semibold text-xs text-[#252722]">
            {c.id.slice(0, 12)}...
          </span>
          <div className="text-[11px] text-[#777A73]">
            Method:{" "}
            <span className="font-mono bg-[#F3F4F6] px-1.5 py-0.2 rounded border border-[#E5E7EB]">
              {c.detectedBy}
            </span>
            {c.distance !== undefined && (
              <span className="ml-1 text-[10.5px] font-mono">dist: {c.distance}</span>
            )}
          </div>
        </div>
      ),
    },
    {
      header: "Involved Agent",
      cell: (c: Conflict) => (
        <span className="font-mono text-xs text-[#252722]">
          {c.agentKey || c.agentId?.slice(0, 8) || "Not recorded"}
        </span>
      ),
    },
    {
      header: "Verdict",
      cell: (c: Conflict) => {
        const variant =
          c.verdict === "fatal" || c.verdict === "invalidating"
            ? "danger"
            : c.verdict === "irrelevant"
            ? "success"
            : "warning";
        return (
          <Badge variant={variant} dot>
            {c.verdict.toUpperCase()}
          </Badge>
        );
      },
    },
    {
      header: "Step Impact",
      cell: (c: Conflict) => {
        const affected = c.affectedSteps || [];
        const total = c.stepsTotal || 0;
        if (c.verdict === "irrelevant") {
          return (
            <span className="text-[11px] text-[#52745B] font-medium">
              All {total} steps preserved
            </span>
          );
        }
        return (
          <div className="text-[11px]">
            <span className="text-[#872B28] font-semibold">
              Invalidated: Steps [{affected.join(", ")}]
            </span>
            <span className="text-[#777A73] block text-[10.5px]">Total plan steps: {total}</span>
          </div>
        );
      },
    },
    {
      header: "Adjudicator",
      cell: (c: Conflict) => (
        <div>
          <span className="font-mono text-[11px] text-[#252722]">{c.model || "graph-heuristic"}</span>
          {c.latencyMs && (
            <div className="text-[10px] text-[#777A73] font-mono">{c.latencyMs}ms latency</div>
          )}
        </div>
      ),
    },
    {
      header: "Timestamp",
      cell: (c: Conflict) => (
        <span className="font-mono text-[11px] text-[#777A73]">
          {new Date(c.createdAt).toLocaleTimeString()}
        </span>
      ),
    },
    {
      header: "Inspect",
      align: "right" as const,
      cell: (c: Conflict) => (
        <Button variant="outline" size="sm" onClick={() => setSelectedConflict(c)}>
          Ruling Rationale
        </Button>
      ),
    },
  ];

  return (
    <AppLayout title="Conflict Monitor & Provenance Graph">
      {/* Overview Banner */}
      <div className="bg-white p-4 border border-[#E5E4DE] rounded-md space-y-1">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[#252722]">
            Deterministic Conflict Gate & Provenance Adjudication
          </h2>
          <Badge variant="olive" size="sm">
            FAIL-CLOSED ADJUDICATION
          </Badge>
        </div>
        <p className="text-xs text-[#777A73] leading-relaxed max-w-4xl">
          When an agent acts, `prepare_action` evaluates the plan against resource mutations. The
          provenance graph adjudicates first; only ambiguous edge cases are escalated to the
          LLM provider configured in the backend (`LLM_PROVIDER`). Actions never proceed past
          invalidated steps.
        </p>
      </div>

      {/* Interactive Relationship Graph */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[#777A73]">
            Interactive Orchestration & Dependency Graph
          </h3>
          <span className="text-[11px] text-[#777A73]">
            Click any node to inspect coordination details
          </span>
        </div>

        {graphData && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-2 text-[11px] text-[#777A73]">
            <span
              className={clsx(
                "font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border",
                graphData.isDemo
                  ? "border-[#E9D8B4] bg-[#FAF4E8] text-[#8C631B]"
                  : "border-[#C7D3C8] bg-[#EEF3EE] text-[#44624C]"
              )}
            >
              {graphData.isDemo ? "Demo fixtures" : "Live PostgreSQL"}
            </span>
            <span className="font-mono">
              {graphCounts.nodes} nodes · {graphCounts.edges} edges
            </span>
            <span>
              agents {graphCounts.agents} · intents {graphCounts.intents} · resources{" "}
              {graphCounts.resources} · conflicts {graphCounts.conflicts}
            </span>
            {graphData.isDemo && (
              <span className="text-[#8C631B]">
                Switch the mode toggle to Live to draw the PostgreSQL graph.
              </span>
            )}
          </div>
        )}

        {graphData && graphData.truncated.length > 0 && (
          <div className="mb-2 flex items-start gap-2 border border-[#E9D8B4] bg-[#FAF4E8] rounded px-2.5 py-1.5 text-[11px] text-[#8C631B]">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>
              The graph stopped reading at the safety valve for:{" "}
              <span className="font-mono">{graphData.truncated.join(", ")}</span>. Some
              nodes are not drawn.
            </span>
          </div>
        )}

        {graphData ? (
          <>
            <ConflictGraph
              nodes={graphData.nodes}
              edges={graphData.edges}
              selectedNodeId={selectedGraphNode?.id}
              onSelectNode={(node) => {
                setSelectedGraphNode(node);
                if (node && node.type === "conflict") {
                  const found = conflicts.find((c) => `conf:${c.id}` === node.id || c.id === node.id);
                  if (found) setSelectedConflict(found);
                }
              }}
            />
            <p className="mt-2 text-[11px] text-[#777A73]">
              {provenanceNote ||
                "Live intent/resource provenance. Conflict adjudications are not persisted by the backend and never appear in this graph."}
            </p>
          </>
        ) : (
          <div className="h-64 border border-[#E5E4DE] rounded bg-white flex flex-col items-center justify-center gap-1 text-xs text-[#777A73] px-6 text-center">
            <span>No provenance graph available.</span>
            <span className="text-[11px]">
              {provenanceNote ||
                (mode === "demo"
                  ? "Demo fixtures provide a sample graph."
                  : "Agents, intents and resource reads are required before a graph can be drawn.")}
            </span>
          </div>
        )}
      </div>

      {/* Conflict Adjudication Records Table */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[#777A73] mb-2">
          Adjudicated Conflict Records ({conflicts.length})
        </h3>
        {loading ? (
          <TableSkeleton rows={4} />
        ) : unavailable ? (
          <div className="border border-[#E5BCB9] bg-[#F9ECEB] rounded-md p-4 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-semibold text-[#872B28] flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4" />
                Adjudication history is not persisted
              </span>
              <span className="text-[10px] font-mono uppercase bg-white/70 px-1.5 py-0.5 rounded border border-[#E5BCB9] text-[#872B28]">
                {unavailable.code}
              </span>
            </div>
            <p className="text-[11px] text-[#252722] leading-relaxed">{unavailable.message}</p>
            {unavailable.detail && (
              <p className="text-[11px] text-[#777A73] leading-relaxed">{unavailable.detail}</p>
            )}
            <p className="text-[11px] text-[#777A73] leading-relaxed">
              An empty table here would be misleading: no verdicts have been stored, and none can
              be reconstructed after the fact.
            </p>
          </div>
        ) : error ? (
          <EmptyState title="Conflict Monitor Unavailable" description={error} />
        ) : (
          <Table
            columns={columns}
            data={conflicts}
            keyExtractor={(c) => c.id}
            onRowClick={(c) => setSelectedConflict(c)}
            emptyMessage="No conflict events detected in the system."
          />
        )}
      </div>

      {/* Conflict Detail Drawer */}
      <Drawer
        isOpen={Boolean(selectedConflict)}
        onClose={() => setSelectedConflict(null)}
        title="Conflict Adjudication Ruling"
        subtitle={`Conflict ID: ${selectedConflict?.id}`}
        badge={
          <Badge
            variant={
              selectedConflict?.verdict === "invalidating" || selectedConflict?.verdict === "fatal"
                ? "danger"
                : "success"
            }
            dot
          >
            {selectedConflict?.verdict.toUpperCase()}
          </Badge>
        }
      >
        {selectedConflict && (
          <div className="space-y-4">
            {/* Rationale explanation */}
            <div className="bg-[#F9F8F5] p-3.5 rounded border border-[#E5E4DE] space-y-2">
              <span className="text-[11px] font-semibold text-[#777A73] uppercase tracking-wider">
                Adjudication Rationale
              </span>
              <p className="text-xs text-[#252722] leading-relaxed">
                {selectedConflict.rationale || "No narrative rationale returned."}
              </p>
            </div>

            {/* Step-Level Granularity */}
            <div className="border border-[#E5E4DE] rounded p-3 bg-white space-y-2">
              <span className="text-xs font-semibold text-[#252722] block">
                Step Granularity Breakdown
              </span>
              <div className="flex items-center justify-between text-xs py-1 border-b border-[#E5E4DE]">
                <span className="text-[#777A73]">Invalidated Steps</span>
                <span className="font-mono font-semibold text-[#872B28]">
                  {selectedConflict.affectedSteps && selectedConflict.affectedSteps.length > 0
                    ? `[${selectedConflict.affectedSteps.join(", ")}]`
                    : "None (All preserved)"}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs py-1">
                <span className="text-[#777A73]">Total Plan Steps</span>
                <span className="font-mono text-[#252722]">{selectedConflict.stepsTotal || 0}</span>
              </div>
            </div>

            {/* Adjudicator Telemetry */}
            <div className="border border-[#E5E4DE] rounded p-3 bg-white space-y-2 text-xs">
              <span className="text-xs font-semibold text-[#252722] block">
                Inference & Adjudicator Telemetry
              </span>
              <div className="grid grid-cols-2 gap-2 text-[11px]">
                <div>
                  <span className="text-[#777A73]">Adjudicator:</span>
                  <div className="font-mono font-medium">{selectedConflict.model || "Graph"}</div>
                </div>
                <div>
                  <span className="text-[#777A73]">Inference Latency:</span>
                  <div className="font-mono">{selectedConflict.latencyMs || 0} ms</div>
                </div>
                <div>
                  <span className="text-[#777A73]">Tokens In:</span>
                  <div className="font-mono">{selectedConflict.tokensIn || 0}</div>
                </div>
                <div>
                  <span className="text-[#777A73]">Tokens Out:</span>
                  <div className="font-mono">{selectedConflict.tokensOut || 0}</div>
                </div>
              </div>
            </div>

            {/* Target intent statement */}
            {selectedConflict.intentStatement && (
              <div className="text-xs">
                <span className="text-[#777A73] block mb-1">Target Intent Statement:</span>
                <div className="p-2.5 bg-[#F9F8F5] rounded border border-[#E5E4DE] font-medium text-[#252722]">
                  {selectedConflict.intentStatement}
                </div>
              </div>
            )}
          </div>
        )}
      </Drawer>
    </AppLayout>
  );
}

