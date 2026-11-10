import { NextResponse } from "next/server";
import { getScope } from "@/lib/data-scope";
import { DEMO_AGENTS } from "@/lib/demo-data";

export async function GET(request: Request) {
  const scope = await getScope(request);
  if (!scope) return NextResponse.json({ error: "Authentication required.", code: "UNAUTHENTICATED" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("mode");
  const id = searchParams.get("id");

  if (scope.kind === "user") {
    const { data, error } = await scope.supabase
      .from("agents")
      .select("id, key, name, metadata, created_at, updated_at")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) return NextResponse.json({ data: null, isDemo: false, error: "Could not load agents.", code: "USER_QUERY_FAILED" }, { status: 503 });
    const agents = (data ?? []).map((agent) => ({
      id: agent.id, key: agent.key, name: agent.name, metadata: agent.metadata,
      createdAt: agent.created_at, updatedAt: agent.updated_at,
    }));
    if (id) return NextResponse.json({ data: agents.find((agent) => agent.id === id || agent.key === id) ?? null, isDemo: false });
    return NextResponse.json({ data: agents, isDemo: false });
  }

  if (mode === "demo") {
    if (id) return NextResponse.json({ data: DEMO_AGENTS.find((agent) => agent.id === id || agent.key === id) ?? null, isDemo: true });
    return NextResponse.json({ data: DEMO_AGENTS, isDemo: true });
  }

  const { fetchLiveAgents } = await import("@/lib/server-db");
  const result = await fetchLiveAgents();
  if (!result.ok) return NextResponse.json({ data: null, isDemo: false, error: result.message, code: result.code }, { status: 503 });
  if (id) return NextResponse.json({ data: result.data.find((agent) => agent.id === id || agent.key === id) ?? null, isDemo: false });
  return NextResponse.json({ data: result.data, isDemo: false });
}
