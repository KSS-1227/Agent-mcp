import { NextResponse } from "next/server";
import { fetchLiveActions } from "@/lib/server-db";
import { requireSession } from "@/lib/auth";
import { DEMO_ACTIONS } from "@/lib/demo-data";

export async function GET(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("mode");
  const key = searchParams.get("key");
  const status = searchParams.get("status");

  if (mode === "demo") {
    let list = DEMO_ACTIONS;
    if (key) {
      const found = list.find((a) => a.idemKey === key);
      return NextResponse.json({ data: found || null, isDemo: true });
    }
    if (status) {
      list = list.filter((a) => a.status === status);
    }
    return NextResponse.json({ data: list, isDemo: true });
  }

  const result = await fetchLiveActions();
  if (!result.ok) {
    return NextResponse.json(
      { data: null, isDemo: false, error: result.message, code: result.code },
      { status: 503 }
    );
  }

  if (key) {
    const found = result.data.find((a) => a.idemKey === key);
    return NextResponse.json({ data: found || null, isDemo: false });
  }

  let filtered = result.data;
  if (status) {
    filtered = filtered.filter((a) => a.status === status);
  }

  return NextResponse.json({ data: filtered, isDemo: false });
}
