import { NextResponse } from "next/server";
import { getScope } from "@/lib/data-scope";
import { DEMO_OVERVIEW_METRICS } from "@/lib/demo-data";

export async function GET(request: Request) {
  const scope = await getScope(request);
  if (!scope) return NextResponse.json({ error: "Authentication required.", code: "UNAUTHENTICATED" }, { status: 401 });
  const mode = new URL(request.url).searchParams.get("mode");

  if (scope.kind === "user") {
    const now = new Date().toISOString();
    const [agentsResult, activeResult, recoveryResult, committedResult, failedResult, recentResult, conflictsResult] = await Promise.all([
      scope.supabase.from("agents").select("id", { count: "exact", head: true }),
      scope.supabase.from("actions").select("id", { count: "exact", head: true }).eq("status", "PENDING"),
      scope.supabase.from("actions").select("id", { count: "exact", head: true }).eq("status", "PENDING").lt("lease_expires_at", now),
      scope.supabase.from("actions").select("id", { count: "exact", head: true }).eq("status", "COMMITTED"),
      scope.supabase.from("actions").select("id", { count: "exact", head: true }).eq("status", "FAILED"),
      scope.supabase.from("actions").select("idempotency_key, action_type, status, created_at").order("created_at", { ascending: false }).limit(6),
      scope.supabase.from("conflicts").select("id", { count: "exact", head: true }),
    ]);
    const failedQuery = [agentsResult, activeResult, recoveryResult, committedResult, failedResult, recentResult, conflictsResult].some((result) => result.error);
    if (failedQuery) return NextResponse.json({ data: null, isDemo: false, source: "supabase-session", error: "Could not load overview activity.", code: "USER_QUERY_FAILED" }, { status: 503 });
    const totalCommitted = committedResult.count ?? 0;
    const totalFailed = failedResult.count ?? 0;
    const outcomeCount = totalCommitted + totalFailed;
    const recentActivity = (recentResult.data ?? []).map((row) => ({
      id: String(row.idempotency_key), type: "action" as const, title: `Action: ${row.action_type}`,
      description: `Status: ${row.status} (key: ${String(row.idempotency_key).slice(0, 12)}...)`,
      timestamp: new Date(row.created_at).toLocaleString(),
      status: row.status === "COMMITTED" ? "success" as const : row.status === "FAILED" ? "danger" as const : "warning" as const,
    }));
    return NextResponse.json({
      data: {
        registeredAgents: agentsResult.count ?? 0, activeActions: activeResult.count ?? 0,
        detectedConflicts: conflictsResult.count ?? 0, pendingRecoveries: recoveryResult.count ?? 0,
        totalCommitted, totalFailed,
        commitSuccessRate: outcomeCount ? Number(((totalCommitted / outcomeCount) * 100).toFixed(1)) : null,
        recentActivity,
      },
      isDemo: false,
      source: "supabase-session",
    });
  }

  if (mode === "demo") return NextResponse.json({ data: DEMO_OVERVIEW_METRICS, isDemo: true, source: "Demonstration fixtures (deterministic sample data)" });
  const { fetchLiveOverview } = await import("@/lib/server-db");
  const result = await fetchLiveOverview();
  if (!result.ok) return NextResponse.json({ data: null, isDemo: false, error: result.message, code: result.code }, { status: 503 });
  return NextResponse.json({ data: result.data, isDemo: false, source: "Live PostgreSQL (read-only)" });
}
