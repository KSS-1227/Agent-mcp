import { NextResponse } from "next/server";
import { fetchLiveIntents } from "@/lib/server-db";
import { requireSession } from "@/lib/auth";
import { DEMO_INTENTS } from "@/lib/demo-data";

export async function GET(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("mode");
  const agentId = searchParams.get("agentId");
  const status = searchParams.get("status");

  if (mode === "demo") {
    let list = DEMO_INTENTS;
    if (agentId) {
      list = list.filter((i) => i.agentId === agentId || i.agentKey === agentId);
    }
    if (status) {
      list = list.filter((i) => i.status === status);
    }
    return NextResponse.json({ data: list, isDemo: true });
  }

  const result = await fetchLiveIntents();
  if (!result.ok) {
    return NextResponse.json(
      { data: null, isDemo: false, error: result.message, code: result.code },
      { status: 503 }
    );
  }

  let filtered = result.data;
  if (agentId) {
    filtered = filtered.filter((i) => i.agentId === agentId || i.agentKey === agentId);
  }
  if (status) {
    filtered = filtered.filter((i) => i.status === status);
  }

  return NextResponse.json({ data: filtered, isDemo: false });
}
