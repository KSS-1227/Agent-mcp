import { NextResponse } from "next/server";
import { getScope } from "@/lib/data-scope";

/**
 * Live provenance graph built from agents, intents, intent_reads and resources.
 * Conflict nodes are intentionally absent — the backend persists no adjudications.
 *
 * `counts` is derived from the payload itself so the UI can state what it drew
 * without re-deriving it, and `truncated` names any entity that hit the read
 * safety valve instead of silently dropping rows.
 */
export async function GET(request: Request) {
  const scope = await getScope(request);
  if (!scope) return NextResponse.json({ error: "Authentication required.", code: "UNAUTHENTICATED" }, { status: 401 });
  if (scope.kind === "user") return NextResponse.json({ error: "Operator access required.", code: "OPERATOR_REQUIRED" }, { status: 403 });

  const { fetchLiveProvenance } = await import("@/lib/server-db");
  const result = await fetchLiveProvenance();
  if (!result.ok) {
    return NextResponse.json(
      { graph: null, isDemo: false, error: result.message, code: result.code },
      { status: 503 }
    );
  }

  const { nodes, edges, note, truncated } = result.data;

  return NextResponse.json({
    graph: { nodes, edges },
    counts: {
      nodes: nodes.length,
      edges: edges.length,
      agents: nodes.filter((n) => n.type === "agent").length,
      intents: nodes.filter((n) => n.type === "intent").length,
      resources: nodes.filter((n) => n.type === "resource").length,
      conflicts: nodes.filter((n) => n.type === "conflict").length,
    },
    truncated,
    note,
    isDemo: false,
  });
}
