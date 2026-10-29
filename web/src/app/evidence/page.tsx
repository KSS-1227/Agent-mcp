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
import { ActionEvidence, Episode } from "@/types";
import {
  FileCheck2,
  Search,
  BookOpen,
  ShieldCheck,
  Hash,
  Clock,
  Layers,
  Database,
} from "lucide-react";
import clsx from "clsx";

export default function EvidenceAndAuditPage() {
  const { mode, refreshKey } = useDashboard();
  const [activeTab, setActiveTab] = useState<"evidence" | "episodes">("evidence");
  const [evidenceList, setEvidenceList] = useState<ActionEvidence[]>([]);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [episodesError, setEpisodesError] = useState<string | null>(null);
  const [evidenceUnavailable, setEvidenceUnavailable] = useState<{
    code: string;
    message: string;
    detail?: string;
  } | null>(null);
  const [search, setSearch] = useState("");
  const [selectedEvidence, setSelectedEvidence] = useState<ActionEvidence | null>(null);
  const [selectedEpisode, setSelectedEpisode] = useState<Episode | null>(null);

  useEffect(() => {
    let isMounted = true;
    setLoading(true);
    setEvidenceUnavailable(null);
    setEpisodesError(null);

    // Evidence ledger and committed episodes are separate resources with different support levels.
    fetch(`/api/evidence?mode=${mode}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!isMounted) return;

        if (res.status === 501 && body.code === "ACTION_EVIDENCE_NOT_PERSISTED") {
          setEvidenceList([]);
          setEvidenceUnavailable({
            code: body.code,
            message: body.error || "Verification evidence is not persisted.",
            detail: body.detail,
          });
          setError(null);
          return;
        }

        if (!res.ok) {
          throw new Error(body.error || `Evidence request failed (HTTP ${res.status})`);
        }

        setEvidenceList(body.evidence || []);
        setError(null);
      })
      .catch((err) => {
        if (isMounted) {
          setError(err.message);
          setEvidenceList([]);
        }
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    fetch(`/api/episodes?mode=${mode}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!isMounted) return;
        if (!res.ok) {
          throw new Error(body.error || `Episode request failed (HTTP ${res.status})`);
        }
        setEpisodes(body.data || []);
      })
      .catch((err) => {
        if (isMounted) {
          setEpisodes([]);
          setEpisodesError(err.message);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [mode, refreshKey]);

  const filteredEvidence = useMemo(() => {
    return evidenceList.filter(
      (e) =>
        e.actionKey.toLowerCase().includes(search.toLowerCase()) ||
        e.evidenceType.toLowerCase().includes(search.toLowerCase()) ||
        e.id.toLowerCase().includes(search.toLowerCase())
    );
  }, [evidenceList, search]);

  const filteredEpisodes = useMemo(() => {
    return episodes.filter(
      (ep) =>
        ep.narrative.toLowerCase().includes(search.toLowerCase()) ||
        (ep.status || "").toLowerCase().includes(search.toLowerCase()) ||
        ep.id.toLowerCase().includes(search.toLowerCase())
    );
  }, [episodes, search]);

  const evidenceColumns = [
    {
      header: "Evidence ID & Verification Type",
      cell: (ev: ActionEvidence) => (
        <div>
          <span className="font-mono font-semibold text-xs text-[#252722]">
            {ev.id.slice(0, 12)}...
          </span>
          <div className="text-[11px] text-[#777A73]">
            Type:{" "}
            <span className="font-mono bg-[#F3F4F6] px-1.5 py-0.2 rounded border border-[#E5E7EB] text-[#4B5563]">
              {ev.evidenceType}
            </span>
          </div>
        </div>
      ),
    },
    {
      header: "Associated Action Idem Key",
      cell: (ev: ActionEvidence) => (
        <span className="font-mono text-xs text-[#252722] truncate max-w-xs block">
          {ev.actionKey}
        </span>
      ),
    },
    {
      header: "Verified Timestamp",
      cell: (ev: ActionEvidence) => (
        <span className="font-mono text-[11px] text-[#777A73]">
          {new Date(ev.verifiedAt).toLocaleString()}
        </span>
      ),
    },
    {
      header: "Payload",
      align: "right" as const,
      cell: (ev: ActionEvidence) => (
        <Button variant="outline" size="sm" onClick={() => setSelectedEvidence(ev)}>
          Inspect Proof
        </Button>
      ),
    },
  ];

  const episodeColumns = [
    {
      header: "Episode & Status",
      cell: (ep: Episode) => (
        <div>
          <span className="font-mono font-semibold text-xs text-[#252722]">
            {ep.id.slice(0, 12)}...
          </span>
          <div className="text-[11px] text-[#777A73]">
            Status: <span className="font-mono">{ep.status || "unknown"}</span>
          </div>
        </div>
      ),
    },
    {
      header: "Episode Narrative",
      cell: (ep: Episode) => (
        <p className="text-xs text-[#252722] line-clamp-2 max-w-lg">{ep.narrative}</p>
      ),
    },
    {
      header: "Vector Embedding",
      cell: (ep: Episode) => (
        <Badge variant={ep.hasEmbedding ? "success" : "neutral"} size="sm">
          {ep.hasEmbedding ? "Embedding stored" : "No Embedding"}
        </Badge>
      ),
    },
    {
      header: "Recorded At",
      cell: (ep: Episode) => (
        <span className="font-mono text-[11px] text-[#777A73]">
          {new Date(ep.createdAt).toLocaleString()}
        </span>
      ),
    },
    {
      header: "Inspect",
      align: "right" as const,
      cell: (ep: Episode) => (
        <Button variant="outline" size="sm" onClick={() => setSelectedEpisode(ep)}>
          Outcome Data
        </Button>
      ),
    },
  ];

  return (
    <AppLayout title="Evidence & Ground Truth Audit">
      {/* Header Tabs & Search */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 bg-white p-3 border border-[#E5E4DE] rounded-md">
        <div className="flex items-center bg-[#F6F5F1] p-0.5 rounded border border-[#E5E4DE]">
          <button
            onClick={() => setActiveTab("evidence")}
            className={clsx(
              "px-3 py-1.5 text-xs font-medium rounded transition-all",
              activeTab === "evidence"
                ? "bg-white text-[#252722] shadow-2xs font-semibold"
                : "text-[#777A73] hover:text-[#252722]"
            )}
          >
            Verification Evidence ({evidenceUnavailable ? "n/a" : evidenceList.length})
          </button>
          <button
            onClick={() => setActiveTab("episodes")}
            className={clsx(
              "px-3 py-1.5 text-xs font-medium rounded transition-all",
              activeTab === "episodes"
                ? "bg-white text-[#252722] shadow-2xs font-semibold"
                : "text-[#777A73] hover:text-[#252722]"
            )}
          >
            Committed Episodes ({episodes.length})
          </button>
        </div>

        <div className="relative flex-1 max-w-sm">
          <Search className="w-4 h-4 text-[#777A73] absolute left-2.5 top-2.5" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search proof type, action key, narrative..."
            className="w-full text-xs bg-[#F9F8F5] border border-[#E5E4DE] rounded pl-8 pr-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-[#52745B] focus:border-[#52745B]"
          />
        </div>
      </div>

      {loading ? (
        <TableSkeleton rows={4} />
      ) : activeTab === "evidence" ? (
        evidenceUnavailable ? (
          <div className="border border-[#E5BCB9] bg-[#F9ECEB] rounded-md p-4 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-semibold text-[#872B28] flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4" />
                Verification evidence is not persisted
              </span>
              <span className="text-[10px] font-mono uppercase bg-white/70 px-1.5 py-0.5 rounded border border-[#E5BCB9] text-[#872B28]">
                {evidenceUnavailable.code}
              </span>
            </div>
            <p className="text-[11px] text-[#252722] leading-relaxed">
              {evidenceUnavailable.message}
            </p>
            {evidenceUnavailable.detail && (
              <p className="text-[11px] text-[#777A73] leading-relaxed">
                {evidenceUnavailable.detail}
              </p>
            )}
            <p className="text-[11px] text-[#777A73] leading-relaxed">
              No evidence rows exist because nothing writes them, not because the ledger is empty.
            </p>
          </div>
        ) : error ? (
          <EmptyState title="Evidence Audit Offline" description={error} />
        ) : (
          <Table
            columns={evidenceColumns}
            data={filteredEvidence}
            keyExtractor={(e) => e.id}
            onRowClick={(e) => setSelectedEvidence(e)}
            emptyMessage="No verification evidence entries recorded."
          />
        )
      ) : episodesError ? (
        <EmptyState title="Episode History Unavailable" description={episodesError} />
      ) : (
        <Table
          columns={episodeColumns}
          data={filteredEpisodes}
          keyExtractor={(ep) => ep.id}
          onRowClick={(ep) => setSelectedEpisode(ep)}
          emptyMessage="No committed episode logs found."
        />
      )}

      {/* Evidence Payload Drawer */}
      <Drawer
        isOpen={Boolean(selectedEvidence)}
        onClose={() => setSelectedEvidence(null)}
        title={selectedEvidence?.evidenceType || "Verification Proof"}
        subtitle={`Action Key: ${selectedEvidence?.actionKey.slice(0, 20)}...`}
        badge={
          <Badge variant="olive" size="sm">
            EVIDENCE RECORD
          </Badge>
        }
      >
        {selectedEvidence && (
          <div className="space-y-4">
            <div className="bg-[#F9F8F5] p-3 rounded border border-[#E5E4DE] text-xs space-y-1">
              <div>
                <span className="text-[#777A73]">Evidence UUID:</span>{" "}
                <span className="font-mono">{selectedEvidence.id}</span>
              </div>
              <div>
                <span className="text-[#777A73]">Verified At:</span>{" "}
                <span className="font-mono">
                  {new Date(selectedEvidence.verifiedAt).toLocaleString()}
                </span>
              </div>
              <div className="truncate">
                <span className="text-[#777A73]">Associated Action:</span>{" "}
                <span className="font-mono font-medium">{selectedEvidence.actionKey}</span>
              </div>
            </div>

            <div>
              <span className="text-xs font-semibold text-[#252722] block mb-2">
                External Verification Proof Payload
              </span>
              <pre className="text-[11px] font-mono bg-white p-3 rounded border border-[#E5E4DE] overflow-x-auto text-[#252722]">
                {JSON.stringify(selectedEvidence.payload, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </Drawer>

      {/* Episode Narrative Drawer */}
      <Drawer
        isOpen={Boolean(selectedEpisode)}
        onClose={() => setSelectedEpisode(null)}
        title="Recovery Episode Narrative"
        subtitle={`Episode: ${selectedEpisode?.id}`}
        badge={
          <Badge variant="neutral" size="sm">
            {selectedEpisode?.status ? selectedEpisode.status.toUpperCase() : "STATUS UNKNOWN"}
          </Badge>
        }
      >
        {selectedEpisode && (
          <div className="space-y-4">
            <div className="bg-[#EEF3EE] p-3.5 rounded border border-[#C8D7CA] text-xs space-y-1">
              <span className="font-semibold text-[#3B6145] block">
                Narrative recorded by the backend
              </span>
              <p className="text-[#252722] leading-relaxed mt-1">
                {selectedEpisode.narrative}
              </p>
            </div>

            <div>
              <span className="text-xs font-semibold text-[#252722] block mb-1">
                Outcome Record
              </span>
              <pre className="text-[11px] font-mono bg-[#F9F8F5] p-3 rounded border border-[#E5E4DE] overflow-x-auto text-[#252722]">
                {typeof selectedEpisode.outcome === "string"
                  ? selectedEpisode.outcome
                  : JSON.stringify(selectedEpisode.outcome, null, 2)}
              </pre>
            </div>

            <div className="text-[11px] text-[#777A73] leading-relaxed">
              Episodes are written by the backend during the commit transaction. The unified
              <span className="font-mono"> episodes </span>
              table stores only narrative, outcome, status and embedding — not agent or task
              identifiers.
            </div>
          </div>
        )}
      </Drawer>
    </AppLayout>
  );
}

