import { NextResponse } from "next/server";
import { fetchLiveProvenance } from "@/lib/server-db";
import { requireSession } from "@/lib/auth";

/**
 * Live provenance graph built from agents, intents, intent_reads and resources.
 * Conflict nodes are intentionally absent — the backend persists no adjudications.
 *
 * `counts` is derived from the payload itself so the UI can state what it drew
 * without re-deriving it, and `truncated` names any entity that hit the read
 * safety valve instead of silently dropping rows.
 */
export async function GET(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

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
