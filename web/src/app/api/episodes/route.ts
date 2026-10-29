import { NextResponse } from "next/server";
import { fetchLiveEpisodes } from "@/lib/server-db";
import { requireSession } from "@/lib/auth";
import { DEMO_EPISODES } from "@/lib/demo-data";

/** Committed recovery episodes — a table the unified backend really writes to. */
export async function GET(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("mode");

  if (mode === "demo") {
    return NextResponse.json({ data: DEMO_EPISODES, isDemo: true });
  }

  const result = await fetchLiveEpisodes();
  if (!result.ok) {
    return NextResponse.json(
      { data: null, isDemo: false, error: result.message, code: result.code },
      { status: 503 }
    );
  }

  return NextResponse.json({ data: result.data, isDemo: false });
}
