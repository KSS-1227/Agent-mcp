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
import { Agent, Intent, Action } from "@/types";
import { Search, Shield, Bot, Key, Calendar, Cpu, Lock, ExternalLink } from "lucide-react";

export default function AgentsPage() {
  const { mode, refreshKey } = useDashboard();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);

  // Associated agent data for drawer
  const [agentIntents, setAgentIntents] = useState<Intent[]>([]);
  const [agentActions, setAgentActions] = useState<Action[]>([]);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [drawerError, setDrawerError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    setLoading(true);
    fetch(`/api/agents?mode=${mode}`)
      .then(async (res) => {
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || "Failed to retrieve agents");
        }
        return res.json();
      })
      .then((data) => {
        if (isMounted) {
          setAgents(data.data || []);
          setError(null);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (isMounted) {
          setError(err.message);
          setAgents([]);
          setLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [mode, refreshKey]);

  // Load related intents & actions when agent is selected
  useEffect(() => {
    if (!selectedAgent) return;
    let isMounted = true;
    setDrawerLoading(true);
    setDrawerError(null);

    const loadJson = async (url: string, label: string) => {
      const res = await fetch(url);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `${label} request failed (HTTP ${res.status})`);
      }
      return body;
    };

    Promise.all([
      loadJson(`/api/intents?mode=${mode}&agentId=${selectedAgent.id}`, "Intents"),
      loadJson(`/api/actions?mode=${mode}`, "Actions"),
    ])
      .then(([intentsData, actionsData]) => {
        if (!isMounted) return;
        setAgentIntents(intentsData.data || []);
        const filtered = (actionsData.data || []).filter(
          (a: Action) => a.agentId === selectedAgent.id || a.agentKey === selectedAgent.key
        );
        setAgentActions(filtered);
      })
      .catch((err) => {
        if (!isMounted) return;
        setDrawerError(err.message || "Related records could not be loaded.");
        setAgentIntents([]);
        setAgentActions([]);
      })
      .finally(() => {
        if (isMounted) setDrawerLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [selectedAgent, mode]);

  const filteredAgents = useMemo(() => {
    return agents.filter(
      (a) =>
        a.key.toLowerCase().includes(search.toLowerCase()) ||
        a.name.toLowerCase().includes(search.toLowerCase()) ||
        a.metadata?.role?.toLowerCase().includes(search.toLowerCase())
    );
  }, [agents, search]);

  const columns = [
    {
      header: "Agent Key & Identifier",
      cell: (agent: Agent) => (
        <div>
          <div className="font-mono font-medium text-[#252722] flex items-center gap-1.5">
            {agent.key}
            {agent.metadata?.systemAgent && (
              <Badge variant="olive" size="sm">
                SYSTEM
              </Badge>
            )}
          </div>
          <div className="text-[11px] font-mono text-[#777A73]">{agent.id}</div>
        </div>
      ),
    },
    {
      header: "Display Name / Role",
      cell: (agent: Agent) => (
        <div>
          <div className="font-semibold text-[#252722]">{agent.name}</div>
          <div className="text-[11px] text-[#777A73]">
            {agent.metadata?.role || agent.metadata?.purpose || "No role recorded in metadata"}
          </div>
        </div>
      ),
    },
    {
      header: "Permissions",
      cell: (agent: Agent) => {
        const perms = agent.metadata?.permissions;
        if (!perms || perms.length === 0) {
          return (
            <span className="text-[11px] text-[#777A73]">
              Not declared in agent metadata
            </span>
          );
        }
        return (
          <div className="flex flex-wrap gap-1 max-w-xs">
            {perms.map((p, idx) => (
              <span
                key={idx}
                className="text-[10px] font-mono bg-[#F3F4F6] px-1.5 py-0.5 rounded text-[#4B5563] border border-[#E5E7EB]"
              >
                {p}
              </span>
            ))}
          </div>
        );
      },
    },
    {
      header: "Registered Timestamp",
      cell: (agent: Agent) => (
        <span className="font-mono text-[11px] text-[#777A73]">
          {new Date(agent.createdAt).toLocaleString()}
        </span>
      ),
    },
    {
      header: "Inspect",
      align: "right" as const,
      cell: (agent: Agent) => (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setSelectedAgent(agent)}
        >
          View Details
        </Button>
      ),
    },
  ];

  return (
    <AppLayout title="Registered Agents">
      {/* Search and Header Controls */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 bg-white p-3 border border-[#E5E4DE] rounded-md">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-[#777A73] absolute left-2.5 top-2.5" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by agent key, name, or role..."
            className="w-full text-xs bg-[#F9F8F5] border border-[#E5E4DE] rounded pl-8 pr-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-[#52745B] focus:border-[#52745B]"
          />
        </div>

        <div className="flex items-center gap-2">
          {/* Note regarding direct browser write restriction */}
          <div className="text-[11px] text-[#777A73] flex items-center gap-1.5 bg-[#F9F8F5] px-2.5 py-1.5 rounded border border-[#E5E4DE]">
            <Lock className="w-3.5 h-3.5 text-[#777A73]" />
            <span>Agent creation requires privileged MCP tool: `register_agent`</span>
          </div>
        </div>
      </div>

      {loading ? (
        <TableSkeleton rows={4} />
      ) : error ? (
        <EmptyState title="Agent Directory Unavailable" description={error} />
      ) : (
        <Table
          columns={columns}
          data={filteredAgents}
          keyExtractor={(a) => a.id}
          onRowClick={(agent) => setSelectedAgent(agent)}
          emptyMessage="No agents matching filter criteria."
        />
      )}

      {/* Agent Detail Inspection Drawer */}
      <Drawer
        isOpen={Boolean(selectedAgent)}
        onClose={() => setSelectedAgent(null)}
        title={selectedAgent?.name || "Agent Details"}
        subtitle={`Key: ${selectedAgent?.key}`}
        badge={
          selectedAgent?.metadata?.systemAgent ? (
            <Badge variant="olive" size="sm">
              SYSTEM AGENT
            </Badge>
          ) : (
            <Badge variant="neutral" size="sm">
              AUTONOMOUS AGENT
            </Badge>
          )
        }
      >
        {selectedAgent && (
          <div className="space-y-5">
            {/* Metadata overview */}
            <div className="bg-[#F9F8F5] p-3 rounded border border-[#E5E4DE] space-y-2">
              <div className="text-[11px] font-semibold text-[#777A73] uppercase tracking-wider">
                Identity & Access
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <span className="text-[#777A73]">Agent UUID:</span>
                  <div className="font-mono text-[11px] truncate">{selectedAgent.id}</div>
                </div>
                <div>
                  <span className="text-[#777A73]">Registered At:</span>
                  <div className="font-mono text-[11px]">
                    {new Date(selectedAgent.createdAt).toLocaleString()}
                  </div>
                </div>
              </div>

              {selectedAgent.metadata && (
                <div className="pt-2 border-t border-[#E5E4DE]">
                  <span className="text-[#777A73] block mb-1">Attached Metadata:</span>
                  <pre className="text-[10.5px] font-mono bg-white p-2 rounded border border-[#E5E4DE] overflow-x-auto text-[#252722]">
                    {JSON.stringify(selectedAgent.metadata, null, 2)}
                  </pre>
                </div>
              )}
            </div>

            {/* Declared Intents by this Agent */}
            <div>
              {drawerError && (
                <div className="mb-3 border border-[#E5BCB9] bg-[#F9ECEB] rounded p-2.5 text-[11px] text-[#872B28]">
                  Related records could not be read: {drawerError}
                </div>
              )}
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-xs font-semibold text-[#252722]">
                  Declared Intents ({agentIntents.length})
                </h4>
                <span className="text-[10px] text-[#777A73]">Recorded via `declare_intent`</span>
              </div>
              {drawerLoading ? (
                <div className="text-xs text-[#777A73]">Loading declared plans...</div>
              ) : agentIntents.length === 0 ? (
                <div className="p-4 text-center text-xs text-[#777A73] border border-[#E5E4DE] rounded bg-white">
                  No active intents recorded for this agent.
                </div>
              ) : (
                <div className="space-y-2">
                  {agentIntents.map((intent) => (
                    <div
                      key={intent.id}
                      className="p-3 border border-[#E5E4DE] rounded bg-white text-xs space-y-1.5"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-[11px] text-[#777A73]">
                          {intent.id.slice(0, 8)}...
                        </span>
                        <Badge
                          variant={
                            intent.status === "committed"
                              ? "success"
                              : intent.status === "threatened"
                              ? "warning"
                              : "neutral"
                          }
                          dot
                        >
                          {intent.status.toUpperCase()}
                        </Badge>
                      </div>
                      <p className="font-medium text-[#252722]">{intent.statement}</p>
                      {intent.steps && intent.steps.length > 0 && (
                        <div className="text-[11px] text-[#777A73]">
                          Plan Steps: {intent.steps.length} sequential execution blocks
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Actions Prepared / Executed by this Agent */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-xs font-semibold text-[#252722]">
                  Action Records ({agentActions.length})
                </h4>
                <span className="text-[10px] text-[#777A73]">Anchor Protocol</span>
              </div>
              {agentActions.length === 0 ? (
                <div className="p-4 text-center text-xs text-[#777A73] border border-[#E5E4DE] rounded bg-white">
                  No actions executed by this agent.
                </div>
              ) : (
                <div className="space-y-2">
                  {agentActions.map((act) => (
                    <div
                      key={act.idemKey}
                      className="p-3 border border-[#E5E4DE] rounded bg-white text-xs space-y-1"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono font-medium text-[#252722]">
                          {act.actionType}
                        </span>
                        <Badge
                          variant={
                            act.status === "COMMITTED"
                              ? "success"
                              : act.status === "FAILED"
                              ? "danger"
                              : "warning"
                          }
                          dot
                        >
                          {act.status}
                        </Badge>
                      </div>
                      <div className="font-mono text-[10.5px] text-[#777A73] truncate">
                        idempotency_key: {act.idemKey}
                      </div>
                      <div className="text-[11px] text-[#777A73]">
                        Effect State: <span className="font-mono font-medium">{act.effectState}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Drawer>
    </AppLayout>
  );
}

