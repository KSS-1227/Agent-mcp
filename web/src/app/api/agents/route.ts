import { NextResponse } from "next/server";
import { fetchLiveAgents } from "@/lib/server-db";
import { requireSession } from "@/lib/auth";
import { DEMO_AGENTS } from "@/lib/demo-data";

export async function GET(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("mode");
  const id = searchParams.get("id");

  if (mode === "demo") {
    if (id) {
      const found = DEMO_AGENTS.find((a) => a.id === id || a.key === id);
      return NextResponse.json({ data: found || null, isDemo: true });
    }
    return NextResponse.json({ data: DEMO_AGENTS, isDemo: true });
  }

  const result = await fetchLiveAgents();
  if (!result.ok) {
    return NextResponse.json(
      { data: null, isDemo: false, error: result.message, code: result.code },
      { status: 503 }
    );
  }

  if (id) {
    const found = result.data.find((a) => a.id === id || a.key === id);
    return NextResponse.json({ data: found || null, isDemo: false });
  }

  return NextResponse.json({ data: result.data, isDemo: false });
}
