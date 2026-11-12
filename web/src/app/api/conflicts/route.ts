import { NextResponse } from "next/server";
import { getScope } from "@/lib/data-scope";
import { NOT_PERSISTED } from "@/lib/not-persisted";
import { DEMO_CONFLICTS, DEMO_PROVENANCE_GRAPH } from "@/lib/demo-data";

/**
 * Conflict history.
 *
 * User scope: reads the owner-limited `conflicts` rows through the user's Supabase session.
 * Column-level grants allow ONLY the columns listed below; never select("*") and never
 * reference reason, conflicting_intent_id, dedupe_key or updated_at here.
 * Operator scope keeps the previous behaviour (unsupported / demo fixtures).
 */
export async function GET(request: Request) {
  const scope = await getScope(request);
  if (!scope) return NextResponse.json({ error: "Authentication required.", code: "UNAUTHENTICATED" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("mode");

  if (scope.kind === "user") {
    const { data: rows, error } = await scope.supabase
      .from("conflicts")
      .select("id, intent_id, conflict_type, severity, decision, affected_steps, preserved_steps, resource_changes, created_at")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) {
      return NextResponse.json(
        { data: [], graph: null, supported: true, isDemo: false, code: "CONFLICTS_QUERY_FAILED", error: "Conflicts could not be loaded." },
        { status: 500 }
      );
    }

    const list = rows ?? [];
    const intentIds = Array.from(new Set(list.map((r: any) => r.intent_id as string)));
    const intentById = new Map<string, { agent_id: string; intent_statement: string }>();
    const agentNameById = new Map<string, string>();
    if (intentIds.length > 0) {
      const { data: intents } = await scope.supabase
        .from("intents")
        .select("id, agent_id, intent_statement")
        .in("id", intentIds);
      (intents ?? []).forEach((i: any) => intentById.set(i.id, i));
      const agentIds = Array.from(new Set((intents ?? []).map((i: any) => i.agent_id as string)));
      if (agentIds.length > 0) {
        const { data: agents } = await scope.supabase.from("agents").select("id, name").in("id", agentIds);
        (agents ?? []).forEach((a: any) => agentNameById.set(a.id, a.name));
      }
    }

    const data = list.map((r: any) => {
      const intent = intentById.get(r.intent_id);
      return {
        id: r.id,
        intentId: r.intent_id,
        agentName: intent ? agentNameById.get(intent.agent_id) ?? null : null,
        intentStatement: intent?.intent_statement ?? null,
        type: r.conflict_type,
        severity: r.severity,
        decision: r.decision,
        affectedSteps: r.affected_steps ?? [],
        preservedSteps: r.preserved_steps ?? [],
        resourceChanges: r.resource_changes ?? [],
        createdAt: r.created_at,
      };
    });
    return NextResponse.json({ data, graph: null, supported: true, isDemo: false, limited: true });
  }

  if (mode === "demo") {
    return NextResponse.json({
      data: DEMO_CONFLICTS,
      graph: DEMO_PROVENANCE_GRAPH,
      supported: true,
      isDemo: true,
    });
  }

  return NextResponse.json(
    {
      data: [],
      graph: null,
      supported: false,
      isDemo: false,
      code: NOT_PERSISTED.conflicts.code,
      error: NOT_PERSISTED.conflicts.message,
      detail: NOT_PERSISTED.conflicts.detail,
    },
    { status: 501 }
  );
}