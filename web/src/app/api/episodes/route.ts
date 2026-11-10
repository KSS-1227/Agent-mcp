import { NextResponse } from "next/server";
import { getScope } from "@/lib/data-scope";
import { DEMO_EPISODES } from "@/lib/demo-data";

export async function GET(request: Request) {
  const scope = await getScope(request);
  if (!scope) return NextResponse.json({ error: "Authentication required.", code: "UNAUTHENTICATED" }, { status: 401 });
  const mode = new URL(request.url).searchParams.get("mode");

  if (scope.kind === "user") {
    const { data: rows, error } = await scope.supabase.from("episodes")
      .select("episode_id, narrative, outcome, status, created_at")
      .order("created_at", { ascending: false }).limit(100);
    if (error) return NextResponse.json({ data: null, isDemo: false, error: "Could not load episodes.", code: "USER_QUERY_FAILED" }, { status: 503 });

    const ids = (rows ?? []).map((episode) => episode.episode_id);
    const { data: embeddedRows, error: embeddingError } = ids.length
      ? await scope.supabase.from("episodes").select("episode_id").in("episode_id", ids).not("embedding", "is", null)
      : { data: [], error: null };
    if (embeddingError) return NextResponse.json({ data: null, isDemo: false, error: "Could not load episode metadata.", code: "USER_QUERY_FAILED" }, { status: 503 });
    const embedded = new Set((embeddedRows ?? []).map((episode) => episode.episode_id));
    const data = (rows ?? []).map((episode) => ({
      id: episode.episode_id, narrative: episode.narrative, outcome: episode.outcome,
      status: episode.status, hasEmbedding: embedded.has(episode.episode_id), createdAt: episode.created_at,
    }));
    return NextResponse.json({ data, isDemo: false });
  }

  if (mode === "demo") return NextResponse.json({ data: DEMO_EPISODES, isDemo: true });
  const { fetchLiveEpisodes } = await import("@/lib/server-db");
  const result = await fetchLiveEpisodes();
  if (!result.ok) return NextResponse.json({ data: null, isDemo: false, error: result.message, code: result.code }, { status: 503 });
  return NextResponse.json({ data: result.data, isDemo: false });
}
