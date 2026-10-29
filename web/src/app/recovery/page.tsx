"use client";

import React, { useEffect, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Table } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Drawer } from "@/components/ui/Drawer";
import { TableSkeleton } from "@/components/ui/LoadingSkeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { useDashboard } from "@/lib/dashboard-context";
import { Action } from "@/types";
import {
  LifeBuoy,
  AlertTriangle,
  RotateCcw,
  ShieldCheck,
  CheckCircle,
  Clock,
  ExternalLink,
  ShieldAlert,
  Info,
} from "lucide-react";
import Link from "next/link";
import clsx from "clsx";

export default function RecoveryCenterPage() {
  const { mode, refreshKey, health } = useDashboard();
  const [awaitingActions, setAwaitingActions] = useState<Action[]>([]);
  const [resolvedHistory, setResolvedHistory] = useState<Action[]>([]);
  const [reconcilerKey, setReconcilerKey] = useState<string | null>(null);
  const [reconcilerNote, setReconcilerNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedAction, setSelectedAction] = useState<Action | null>(null);

  // Manual inspection state (read-only — never triggers recovery)
  const [inspectingKey, setInspectingKey] = useState<string | null>(null);
  const [inspection, setInspection] = useState<any | null>(null);
  const [inspectionError, setInspectionError] = useState<string | null>(null);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const runtime = mode === "live" ? health?.backend.recovery : null;
  const runtimeFresh = Boolean(runtime && Date.now() - Date.parse(runtime.observedAt) <= 90_000 &&
    (runtime.state === "disabled" || runtime.state === "starting" || runtime.lastPassAt && Date.now() - Date.parse(runtime.lastPassAt) <= 90_000));
  const daemonLabel = !runtime || !runtimeFresh
    ? "NOT VERIFIED"
    : runtime.state.toUpperCase();

  useEffect(() => {
    let isMounted = true;
    setLoading(true);
    fetch(`/api/recovery?mode=${mode}`)
      .then(async (res) => {
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || "Failed to load recovery telemetry");
        }
        return res.json();
      })
      .then((data) => {
        if (isMounted) {
          setAwaitingActions(data.awaitingReconciliation || []);
          setResolvedHistory(data.resolvedHistory || []);
          setReconcilerKey(data.reconcilerAgentKey ?? null);
          setReconcilerNote(data.reconcilerNote ?? null);
          setError(null);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (isMounted) {
          setError(err.message);
          setAwaitingActions([]);
          setResolvedHistory([]);
          setLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [mode, refreshKey]);

  const handleInspect = async (action: Action) => {
    setInspectingKey(action.idemKey);
    setInspection(null);
    setInspectionError(null);

    try {
      const res = await fetch("/api/recovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionKey: action.idemKey, mode }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setInspectionError(data.error || `Inspection failed (HTTP ${res.status}).`);
        return;
      }

      setInspection(data);
    } catch {
      setInspectionError("Inspection request could not be completed.");
    } finally {
      setInspectingKey(null);
      setConfirmKey(null);
    }
  };

  const awaitingColumns = [
    {
      header: "Orphaned Action & Type",
      cell: (act: Action) => (
        <div>
          <span className="font-mono font-semibold text-xs text-[#252722]">
            {act.actionType}
          </span>
          <div className="font-mono text-[10.5px] text-[#777A73] truncate max-w-xs">
            {act.idemKey.slice(0, 16)}...
          </div>
        </div>
      ),
    },
    {
      header: "Orphaned Agent",
      cell: (act: Action) => (
        <span className="font-mono text-xs text-[#252722]">
          {act.agentKey || act.agentId.slice(0, 8)}
        </span>
      ),
    },
    {
      header: "Effect State",
      cell: (act: Action) => (
        <Badge variant={act.effectState === "UNKNOWN" ? "warning" : "danger"} size="sm">
          {act.effectState}
        </Badge>
      ),
    },
    {
      header: "Lease Expiry",
      cell: (act: Action) => {
        const isExpired = act.leaseExpires && new Date(act.leaseExpires).getTime() < Date.now();
        return (
          <div className="text-[11px]">
            <span className="text-[#8C631B] font-semibold">
              {isExpired ? "LEASE EXPIRED" : "NO LEASE"}
            </span>
            <div className="text-[10px] text-[#777A73] font-mono">
              Expired: {act.leaseExpires ? new Date(act.leaseExpires).toLocaleTimeString() : "No lease recorded"}
            </div>
          </div>
        );
      },
    },
    {
      header: "Ground Truth Resolution",
      align: "right" as const,
      cell: (act: Action) => (
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => setSelectedAction(act)}>
            Inspect
          </Button>
          {confirmKey === act.idemKey ? (
            <div className="flex items-center gap-1.5 bg-[#FAF4E8] p-1 rounded border border-[#E9D8B4]">
              <span className="text-[10px] text-[#8C631B] font-medium">Read-only lookup?</span>
              <button
                onClick={() => handleInspect(act)}
                disabled={Boolean(inspectingKey)}
                className="px-2 py-0.5 text-[11px] bg-[#52745B] text-white rounded font-medium hover:bg-[#44624C] disabled:opacity-50"
              >
                Confirm
              </button>
              <button
                onClick={() => setConfirmKey(null)}
                className="px-1.5 py-0.5 text-[11px] text-[#777A73] hover:text-[#252722]"
              >
                Cancel
              </button>
            </div>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setConfirmKey(act.idemKey)}
              disabled={Boolean(inspectingKey)}
            >
              Inspect State
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <AppLayout title="Recovery Center & External Reconciliation">
      {/* Policy Explainer */}
      <div className="bg-white p-4 border border-[#E5E4DE] rounded-md space-y-1">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[#252722]">
            Crash Recovery & Ground Truth Verification
          </h2>
          <Badge variant={runtimeFresh && (runtime?.state === "idle" || runtime?.state === "running") ? "olive" : "neutral"} size="sm">
            DAEMON: {daemonLabel}
          </Badge>
        </div>
        <p className="text-xs text-[#777A73] leading-relaxed max-w-4xl">
          When an agent process crashes after dispatching an external call, the action is orphaned
          with an expired lease. The reconciler claims the expired lease and queries the external
          system for attributable correlation evidence. It commits if applied, fails if not applied,
          and escalates to human operators on unknown outcomes—<strong>never double-acting</strong>.
        </p>
        {reconcilerNote && (
          <p className="text-[11px] text-[#777A73] leading-relaxed max-w-4xl pt-1">
            {reconcilerNote}
          </p>
        )}
        {runtimeFresh && runtime && (
          <p className="text-[11px] text-[#777A73] leading-relaxed max-w-4xl pt-1">
            Production verifiers: {runtime.productionVerifierCount}. Last pass: {new Date(runtime.lastPassAt!).toLocaleString()}.
            {runtime.lastPass ? ` Claimed ${runtime.lastPass.claimed}; committed ${runtime.lastPass.committed}; failed ${runtime.lastPass.failed}; unresolved ${runtime.lastPass.escalated}.` : runtime.failure ? " Last pass failed." : ""}
          </p>
        )}
      </div>

      {/* Inspection outcome — read-only; never presented as a completed recovery */}
      {inspectionError && (
        <div className="bg-[#F9ECEB] border border-[#E5BCB9] p-3.5 rounded text-xs space-y-1">
          <div className="font-semibold flex items-center gap-2 text-[#872B28]">
            <AlertTriangle className="w-4 h-4" />
            <span>Inspection Failed</span>
          </div>
          <p className="text-[11px] text-[#252722]">{inspectionError}</p>
        </div>
      )}

      {inspection && (
        <div
          className={clsx(
            "p-3.5 rounded text-xs space-y-2 border",
            inspection.simulated
              ? "bg-[#FAF4E8] border-[#E9D8B4]"
              : inspection.dispositionConfirmed
                ? "bg-[#EEF3EE] border-[#C8D7CA]"
                : "bg-white border-[#E5E4DE]"
          )}
        >
          <div className="font-semibold flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              {inspection.dispositionConfirmed && !inspection.simulated ? (
                <CheckCircle className="w-4 h-4 text-[#52745B]" />
              ) : (
                <Info className="w-4 h-4 text-[#777A73]" />
              )}
              <span className="text-[#252722]">
                {inspection.simulated
                  ? "Simulated Preview — No Verification Performed"
                  : inspection.dispositionConfirmed
                    ? "Verifier Disposition Recorded by the Backend"
                    : "Read-Only Inspection Complete"}
              </span>
            </span>
            <span className="text-[10px] font-mono uppercase bg-white/70 px-1.5 py-0.5 rounded border border-[#E5E4DE] text-[#777A73]">
              {inspection.operation || "inspect"}
              {inspection.simulated ? " · simulated" : ""}
            </span>
          </div>

          {inspection.message && (
            <p className="text-[11px] text-[#777A73] leading-relaxed">{inspection.message}</p>
          )}

          {inspection.action && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] pt-1 border-t border-[#E5E4DE]/60">
              <div>
                <span className="text-[#777A73] block">Action status</span>
                <span className="font-mono text-[#252722]">{inspection.action.status}</span>
              </div>
              <div>
                <span className="text-[#777A73] block">Effect state</span>
                <span className="font-mono text-[#252722]">{inspection.action.effectState}</span>
              </div>
              <div>
                <span className="text-[#777A73] block">Verifier response</span>
                <span className="font-mono text-[#252722]">
                  {inspection.action.verifierResponse || "none recorded"}
                </span>
              </div>
              <div>
                <span className="text-[#777A73] block">Lease expires</span>
                <span className="font-mono text-[#252722]">
                  {inspection.action.leaseExpires
                    ? new Date(inspection.action.leaseExpires).toLocaleString()
                    : "no lease"}
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Actions Awaiting Reconciliation */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[#777A73]">
            Actions Awaiting Reconciliation ({awaitingActions.length})
          </h3>
          <span className="text-[11px] text-[#777A73]">
            Read-only inspection only — this dashboard cannot trigger or verify reconciliation
          </span>
        </div>

        {loading ? (
          <TableSkeleton rows={3} />
        ) : error ? (
          <EmptyState title="Recovery Center Offline" description={error} />
        ) : awaitingActions.length === 0 ? (
          <div className="p-8 border border-[#E5E4DE] rounded-md bg-white text-center">
            <CheckCircle className="w-8 h-8 text-[#52745B] mx-auto mb-2" />
            <h4 className="text-xs font-semibold text-[#252722]">
              No Orphaned Actions Detected
            </h4>
            <p className="text-[11px] text-[#777A73] max-w-sm mx-auto mt-1">
              No PENDING action has an expired or missing lease, and none is in an UNKNOWN effect
              state. This reflects the rows readable from PostgreSQL; the reconciler daemon itself
              is not observable from this dashboard.
            </p>
          </div>
        ) : (
          <Table
            columns={awaitingColumns}
            data={awaitingActions}
            keyExtractor={(a) => a.idemKey}
            onRowClick={(a) => setSelectedAction(a)}
          />
        )}
      </div>

      {/* Historical Resolved Actions */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[#777A73] mb-2">
          Reconciled & Completed Action History ({resolvedHistory.length})
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {resolvedHistory.slice(0, 4).map((act) => (
            <Card key={act.idemKey} className="p-3">
              <div className="flex items-center justify-between">
                <span className="font-mono font-medium text-xs text-[#252722]">
                  {act.actionType}
                </span>
                <Badge variant={act.status === "COMMITTED" ? "success" : "danger"} size="sm">
                  {act.status}
                </Badge>
              </div>
              <div className="font-mono text-[10.5px] text-[#777A73] truncate mt-1">
                idempotency_key: {act.idemKey}
              </div>
              <div className="mt-2 pt-2 border-t border-[#E5E4DE] flex items-center justify-between text-[11px] text-[#777A73]">
                <span>Effect: {act.effectState}</span>
                <button
                  onClick={() => setSelectedAction(act)}
                  className="text-[#52745B] hover:underline"
                >
                  View Evidence →
                </button>
              </div>
            </Card>
          ))}
        </div>
      </div>

      {/* Action Inspection Drawer */}
      <Drawer
        isOpen={Boolean(selectedAction)}
        onClose={() => setSelectedAction(null)}
        title={selectedAction?.actionType || "Recovery Details"}
        subtitle={`Key: ${selectedAction?.idemKey.slice(0, 20)}...`}
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
          <div className="space-y-4">
            <div className="bg-[#FAF4E8] border border-[#E9D8B4] p-3 rounded text-xs text-[#8C631B] space-y-1">
              <span className="font-semibold block">Crash Recovery State Machine</span>
              <p className="text-[11px] leading-relaxed">
                Lease Owner: <span className="font-mono font-bold">{selectedAction.leaseOwner}</span>
                <br />
                Lease Expiration:{" "}
                <span className="font-mono">
                  {selectedAction.leaseExpires
                    ? new Date(selectedAction.leaseExpires).toLocaleString()
                    : "None"}
                </span>
                <br />
                External Ref: <span className="font-mono">{selectedAction.externalRef || "None recorded"}</span>
              </p>
            </div>

            <div>
              <span className="text-xs font-semibold text-[#252722] block mb-1">
                Recorded Arguments
              </span>
              <pre className="text-[11px] font-mono bg-[#F9F8F5] p-3 rounded border border-[#E5E4DE] overflow-x-auto text-[#252722]">
                {JSON.stringify(selectedAction.actionArgs, null, 2)}
              </pre>
            </div>

            {selectedAction.outcome && (
              <div>
                <span className="text-xs font-semibold text-[#252722] block mb-1">
                  Verifier Diagnosis & Ground Truth Evidence
                </span>
                <pre className="text-[11px] font-mono bg-[#F9F8F5] p-3 rounded border border-[#E5E4DE] overflow-x-auto text-[#252722]">
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

