import { NextResponse } from "next/server";
import { getScope } from "@/lib/data-scope";
import { DEMO_INTENTS } from "@/lib/demo-data";
import type { Intent } from "@/types";

export async function GET(request: Request) {
  const scope = await getScope(request);
  if (!scope) return NextResponse.json({ error: "Authentication required.", code: "UNAUTHENTICATED" }, { status: 401 });
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("mode");
  const agentId = searchParams.get("agentId");
  const status = searchParams.get("status");

  if (scope.kind === "user") {
    const { data: rows, error } = await scope.supabase.from("intents")
      .select("id, agent_id, task_id, intent_statement, status, expiration_at, created_at, updated_at")
      .order("created_at", { ascending: false }).limit(100);
    if (error) return NextResponse.json({ data: null, isDemo: false, limited: true, error: "Could not load intents.", code: "USER_QUERY_FAILED" }, { status: 503 });
    const agentIds = [...new Set((rows ?? []).map((row) => row.agent_id).filter(Boolean))];
    const intentIds = (rows ?? []).map((row) => row.id);
    const [{ data: agents, error: agentsError }, { data: stepRows, error: stepsError }] = await Promise.all([
      agentIds.length
        ? scope.supabase.from("agents").select("id, key, name").in("id", agentIds)
        : Promise.resolve({ data: [], error: null }),
      intentIds.length
        ? scope.supabase.from("intent_steps").select("id, intent_id, step_number, description, status, dependencies, created_at").in("intent_id", intentIds).order("step_number", { ascending: true })
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (agentsError || stepsError) return NextResponse.json({ data: null, isDemo: false, limited: true, error: "Could not load intent details.", code: "USER_QUERY_FAILED" }, { status: 503 });
    const agentById = new Map((agents ?? []).map((agent) => [agent.id, agent]));
    const stepsByIntent = new Map<string, unknown[]>();
    for (const step of stepRows ?? []) {
      const list = stepsByIntent.get(step.intent_id) ?? [];
      list.push({ id: step.id, intentId: step.intent_id, seq: step.step_number, description: step.description, status: step.status, dependsOn: Array.isArray(step.dependencies) ? step.dependencies : [], createdAt: step.created_at });
      stepsByIntent.set(step.intent_id, list);
    }
    let list: Intent[] = (rows ?? []).map((row) => {
      const agent = agentById.get(row.agent_id);
      return {
        id: row.id, agentId: row.agent_id, agentKey: agent?.key, agentName: agent?.name,
        taskId: row.task_id, statement: row.intent_statement, status: row.status,
        expirationAt: row.expiration_at, recordedAt: row.created_at, updatedAt: row.updated_at,
        reads: null, steps: (stepsByIntent.get(row.id) ?? []) as Intent["steps"],
      } as Intent;
    });
    if (agentId) list = list.filter((intent) => intent.agentId === agentId || intent.agentKey === agentId);
    if (status) list = list.filter((intent) => intent.status === status);
    return NextResponse.json({ data: list, isDemo: false, limited: true });
  }

  if (mode === "demo") {
    let list = DEMO_INTENTS;
    if (agentId) list = list.filter((intent) => intent.agentId === agentId || intent.agentKey === agentId);
    if (status) list = list.filter((intent) => intent.status === status);
    return NextResponse.json({ data: list, isDemo: true });
  }

  const { fetchLiveIntents } = await import("@/lib/server-db");
  const result = await fetchLiveIntents();
  if (!result.ok) return NextResponse.json({ data: null, isDemo: false, error: result.message, code: result.code }, { status: 503 });
  let list = result.data;
  if (agentId) list = list.filter((intent) => intent.agentId === agentId || intent.agentKey === agentId);
  if (status) list = list.filter((intent) => intent.status === status);
  return NextResponse.json({ data: list, isDemo: false });
}
