import { NextResponse } from "next/server";
import { getScope } from "@/lib/data-scope";
import { DEMO_ACTIONS } from "@/lib/demo-data";
import type { Action } from "@/types";

export async function GET(request: Request) {
  const scope = await getScope(request);
  if (!scope) return NextResponse.json({ error: "Authentication required.", code: "UNAUTHENTICATED" }, { status: 401 });
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("mode");
  const key = searchParams.get("key");
  const status = searchParams.get("status");

  if (scope.kind === "user") {
    const { data: rows, error } = await scope.supabase.from("actions")
      .select("idempotency_key, episode_id, agent_id, action_type, arguments, status, lease_owner, lease_expires_at, external_reference, outcome, attempts, created_at, resolved_at, effect_state, effect_started_at, effect_completed_at, verifier_response, verified_at")
      .order("created_at", { ascending: false }).limit(100);
    if (error) return NextResponse.json({ data: null, isDemo: false, limited: true, error: "Could not load actions.", code: "USER_QUERY_FAILED" }, { status: 503 });
    const agentIds = [...new Set((rows ?? []).map((row) => row.agent_id).filter(Boolean))];
    const { data: agents, error: agentsError } = agentIds.length
      ? await scope.supabase.from("agents").select("id, key").in("id", agentIds)
      : { data: [], error: null };
    if (agentsError) return NextResponse.json({ data: null, isDemo: false, limited: true, error: "Could not load action agents.", code: "USER_QUERY_FAILED" }, { status: 503 });
    const keyById = new Map((agents ?? []).map((agent) => [agent.id, agent.key]));
    let list: Action[] = (rows ?? []).map((row) => ({
      idemKey: row.idempotency_key, episodeId: row.episode_id, agentId: row.agent_id,
      agentKey: keyById.get(row.agent_id) ?? undefined, actionType: row.action_type,
      actionArgs: row.arguments, status: row.status, leaseOwner: row.lease_owner ?? undefined,
      leaseExpires: row.lease_expires_at ?? undefined, externalRef: row.external_reference ?? undefined,
      outcome: row.outcome ?? undefined, attempts: row.attempts, createdAt: row.created_at,
      resolvedAt: row.resolved_at ?? undefined, effectState: row.effect_state,
      effectStartedAt: row.effect_started_at ?? undefined, effectCompletedAt: row.effect_completed_at ?? undefined,
      verifierResponse: row.verifier_response, verifiedAt: row.verified_at, resourceVersions: null,
    } as Action));
    if (status) list = list.filter((action) => action.status === status);
    if (key) list = list.filter((action) => action.idemKey === key);
    return NextResponse.json({ data: key ? list[0] ?? null : list, isDemo: false, limited: true });
  }

  if (mode === "demo") {
    let list = DEMO_ACTIONS;
    if (key) return NextResponse.json({ data: list.find((action) => action.idemKey === key) ?? null, isDemo: true });
    if (status) list = list.filter((action) => action.status === status);
    return NextResponse.json({ data: list, isDemo: true });
  }

  const { fetchLiveActions } = await import("@/lib/server-db");
  const result = await fetchLiveActions();
  if (!result.ok) return NextResponse.json({ data: null, isDemo: false, error: result.message, code: result.code }, { status: 503 });
  if (key) return NextResponse.json({ data: result.data.find((action) => action.idemKey === key) ?? null, isDemo: false });
  const list = status ? result.data.filter((action) => action.status === status) : result.data;
  return NextResponse.json({ data: list, isDemo: false });
}
