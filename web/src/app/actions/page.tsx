"use client";

import React, { useEffect, useState, useMemo } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Table } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { TableSkeleton } from "@/components/ui/LoadingSkeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { useDashboard } from "@/lib/dashboard-context";
import { Action } from "@/types";
import {
  GitCommit,
  Search,
  Clock,
  ShieldCheck,
  CheckCircle,
  AlertTriangle,
  XCircle,
  ExternalLink,
} from "lucide-react";
import clsx from "clsx";

export default function ActionLifecyclePage() {
  const { mode, refreshKey } = useDashboard();
  const [actions, setActions] = useState<Action[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [selectedAction, setSelectedAction] = useState<Action | null>(null);

  useEffect(() => {
    let isMounted = true;
    setLoading(true);
    fetch(`/api/actions?mode=${mode}`)
      .then(async (res) => {
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || "Failed to load action lifecycle records");
        }
        return res.json();
      })
      .then((data) => {
        if (isMounted) {
          setActions(data.data || []);
          setError(null);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (isMounted) {
          setError(err.message);
          setActions([]);
          setLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [mode, refreshKey]);

  const filteredActions = useMemo(() => {
    return actions.filter((a) => {
      const matchesSearch =
        a.actionType.toLowerCase().includes(search.toLowerCase()) ||
        a.idemKey.toLowerCase().includes(search.toLowerCase()) ||
        a.agentKey?.toLowerCase().includes(search.toLowerCase());

      const matchesStatus = statusFilter === "ALL" || a.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [actions, search, statusFilter]);

  const columns = [
    {
      header: "Action Type & Key",
      cell: (act: Action) => (
        <div>
          <span className="font-mono font-semibold text-xs text-[#252722]">
            {act.actionType}
          </span>
          <div className="text-[10.5px] font-mono text-[#777A73] truncate max-w-xs">
            idempotency_key: {act.idemKey.slice(0, 16)}...
          </div>
        </div>
      ),
    },
    {
      header: "Agent",
      cell: (act: Action) => (
        <span className="font-mono text-xs text-[#252722]">
          {act.agentKey || act.agentId.slice(0, 8)}
        </span>
      ),
    },
    {
      header: "Status",
      cell: (act: Action) => {
        const variant =
          act.status === "COMMITTED"
            ? "success"
            : act.status === "FAILED"
            ? "danger"
            : act.status === "PENDING"
            ? "warning"
            : "neutral";
        return (
          <Badge variant={variant} dot>
            {act.status}
          </Badge>
        );
      },
    },
    {
      header: "Effect State",
      cell: (act: Action) => {
        const variant =
          act.effectState === "APPLIED"
            ? "success"
            : act.effectState === "NOT_APPLIED"
            ? "danger"
            : act.effectState === "IN_PROGRESS"
            ? "warning"
            : act.effectState === "UNKNOWN"
            ? "warning"
            : "neutral";
        return (
          <Badge variant={variant} size="sm">
            {act.effectState}
          </Badge>
        );
      },
    },
    {
      header: "Lease Status",
      cell: (act: Action) => {
        if (!act.leaseExpires) {
          return <span className="text-[11px] text-[#777A73]">No active lease</span>;
        }
        const isExpired = new Date(act.leaseExpires).getTime() < Date.now();
        return (
          <div className="text-[11px]">
            <span
              className={clsx(
                "font-mono text-[10.5px] px-1.5 py-0.2 rounded border",
                isExpired
                  ? "bg-[#FAF4E8] text-[#8C631B] border-[#E9D8B4] font-semibold"
                  : "bg-[#F3F4F6] text-[#4B5563] border-[#E5E7EB]"
              )}
            >
              {isExpired ? "EXPIRED (ORPHANED)" : "LIVE LEASE"}
            </span>
            <div className="text-[10px] text-[#777A73] mt-0.5 truncate max-w-[140px]">
              {act.leaseOwner || "anonymous"}
            </div>
          </div>
        );
      },
    },
    {
      header: "Timestamp",
      cell: (act: Action) => (
        <span className="font-mono text-[11px] text-[#777A73]">
          {new Date(act.createdAt).toLocaleTimeString()}
        </span>
      ),
    },
    {
      header: "Lifecycle Timeline",
      align: "right" as const,
      cell: (act: Action) => (
        <Button variant="outline" size="sm" onClick={() => setSelectedAction(act)}>
          Inspect Timeline
        </Button>
      ),
    },
  ];

  return (
    <AppLayout title="Action Lifecycle & Exactly-Once Protocol">
      {/* Search and Filters */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 bg-white p-3 border border-[#E5E4DE] rounded-md">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-4 h-4 text-[#777A73] absolute left-2.5 top-2.5" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search action type, idempotency_key, agent..."
            className="w-full text-xs bg-[#F9F8F5] border border-[#E5E4DE] rounded pl-8 pr-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-[#52745B] focus:border-[#52745B]"
          />
        </div>

        {/* Status filter pills */}
        <div className="flex items-center gap-1.5 overflow-x-auto">
          {["ALL", "PENDING", "COMMITTED", "FAILED"].map((st) => (
            <button
              key={st}
              onClick={() => setStatusFilter(st)}
              className={clsx(
                "px-2.5 py-1 text-[11px] font-medium rounded border transition-colors",
                statusFilter === st
                  ? "bg-[#242622] text-white border-[#242622]"
                  : "bg-white text-[#777A73] border-[#E5E4DE] hover:bg-[#F9F8F5]"
              )}
            >
              {st}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <TableSkeleton rows={5} />
      ) : error ? (
        <EmptyState title="Action Telemetry Unavailable" description={error} />
      ) : (
        <Table
          columns={columns}
          data={filteredActions}
          keyExtractor={(a) => a.idemKey}
          onRowClick={(a) => setSelectedAction(a)}
          emptyMessage="No actions recorded."
        />
      )}

      {/* Chronological Lifecycle Timeline Drawer */}
      <Drawer
        isOpen={Boolean(selectedAction)}
        onClose={() => setSelectedAction(null)}
        title={selectedAction?.actionType || "Action Lifecycle"}
        subtitle={`Idem Key: ${selectedAction?.idemKey.slice(0, 24)}...`}
        badge={
          <Badge
            variant={
              selectedAction?.status === "COMMITTED"
                ? "success"
                : selectedAction?.status === "FAILED"
                ? "danger"
                : "warning"
            }
            dot
          >
            {selectedAction?.status}
          </Badge>
        }
      >
        {selectedAction && (
          <div className="space-y-5">
            {/* Action Identity Card */}
            <div className="bg-[#F9F8F5] p-3 rounded border border-[#E5E4DE] space-y-1.5 text-xs">
              <span className="text-[11px] font-semibold text-[#777A73] uppercase tracking-wider block">
                Deterministic Idempotency Key
              </span>
              <div className="font-mono text-[10.5px] break-all bg-white p-2 rounded border border-[#E5E4DE] text-[#252722]">
                {selectedAction.idemKey}
              </div>
              <div className="text-[11px] text-[#777A73]">
                Derived from: sha256(episodeId, actionType, canonical_json(args))
              </div>
            </div>

            {/* Three-Phase Chronological Event Timeline */}
            <div>
              <h4 className="text-xs font-semibold text-[#252722] mb-3">
                Protocol Phase Progression
              </h4>

              <div className="relative border-l border-[#E5E4DE] ml-3 pl-5 space-y-5 text-xs">
                {/* Phase 1: Intend */}
                <div className="relative">
                  <div className="absolute -left-[27px] top-0.5 w-3.5 h-3.5 rounded-full bg-[#52745B] border-2 border-white" />
                  <div className="font-semibold text-[#252722] flex items-center gap-2">
                    <span>Phase 1 — Intend (`prepare_action`)</span>
                    <Badge variant="success" size="sm">
                      DEDUPED
                    </Badge>
                  </div>
                  <p className="text-[11px] text-[#777A73] mt-1">
                    Recorded at: {new Date(selectedAction.createdAt).toLocaleString()}. Lease allocated
                    to <span className="font-mono text-[#252722]">{selectedAction.leaseOwner}</span>.
                    Deterministic conflict gate verified.
                  </p>
                </div>

                {/* Phase 2: Execute */}
                <div className="relative">
                  <div
                    className={clsx(
                      "absolute -left-[27px] top-0.5 w-3.5 h-3.5 rounded-full border-2 border-white",
                      selectedAction.effectState === "APPLIED" || selectedAction.effectState === "NOT_APPLIED"
                        ? "bg-[#52745B]"
                        : selectedAction.effectState === "IN_PROGRESS" || selectedAction.effectState === "UNKNOWN"
                        ? "bg-[#B58533]"
                        : "bg-[#D5D3CA]"
                    )}
                  />
                  <div className="font-semibold text-[#252722] flex items-center gap-2">
                    <span>Phase 2 — Execute (`execute_action`)</span>
                    <Badge
                      variant={
                        selectedAction.effectState === "APPLIED"
                          ? "success"
                          : selectedAction.effectState === "NOT_APPLIED"
                          ? "danger"
                          : "warning"
                      }
                      size="sm"
                    >
                      {selectedAction.effectState}
                    </Badge>
                  </div>
                  <p className="text-[11px] text-[#777A73] mt-1">
                    External effect progress: <span className="font-mono">{selectedAction.effectState}</span>.
                    {selectedAction.externalRef && (
                      <span className="block mt-0.5 font-mono text-[10.5px]">
                        External Ref: {selectedAction.externalRef}
                      </span>
                    )}
                  </p>
                </div>

                {/* Phase 3: Commit */}
                <div className="relative">
                  <div
                    className={clsx(
                      "absolute -left-[27px] top-0.5 w-3.5 h-3.5 rounded-full border-2 border-white",
                      selectedAction.status === "COMMITTED"
                        ? "bg-[#52745B]"
                        : selectedAction.status === "FAILED"
                        ? "bg-[#A8423F]"
                        : "bg-[#D5D3CA]"
                    )}
                  />
                  <div className="font-semibold text-[#252722] flex items-center gap-2">
                    <span>Phase 3 — Commit (`complete_action`)</span>
                    <Badge
                      variant={
                        selectedAction.status === "COMMITTED"
                          ? "success"
                          : selectedAction.status === "FAILED"
                          ? "danger"
                          : "neutral"
                      }
                      size="sm"
                    >
                      {selectedAction.status}
                    </Badge>
                  </div>
                  <p className="text-[11px] text-[#777A73] mt-1">
                    {selectedAction.status === "COMMITTED"
                      ? "Atomically committed intent resolution, world state, and episode embeddings inside 1 transaction."
                      : selectedAction.status === "FAILED"
                      ? "Marked FAILED. Verified external system ground truth confirmed action did not apply."
                      : "Action remains pending completion or recovery reconciliation."}
                  </p>
                </div>
              </div>
            </div>

            {/* Action Arguments Payload */}
            <div>
              <span className="text-xs font-semibold text-[#252722] block mb-1">
                Action Input Arguments
              </span>
              <pre className="text-[11px] font-mono bg-white p-3 rounded border border-[#E5E4DE] overflow-x-auto text-[#252722]">
                {JSON.stringify(selectedAction.actionArgs, null, 2)}
              </pre>
            </div>

            {/* Outcome Receipt Payload */}
            {selectedAction.outcome && (
              <div>
                <span className="text-xs font-semibold text-[#252722] block mb-1">
                  Recorded Outcome / Evidence Receipt
                </span>
                <pre className="text-[11px] font-mono bg-white p-3 rounded border border-[#E5E4DE] overflow-x-auto text-[#252722]">
                  {JSON.stringify(selectedAction.outcome, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}
      </Drawer>
    </AppLayout>
  );
}

