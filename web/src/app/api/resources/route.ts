import { NextResponse } from "next/server";
import { fetchLiveResources } from "@/lib/server-db";
import { requireSession } from "@/lib/auth";
import { DEMO_RESOURCES } from "@/lib/demo-data";

export async function GET(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("mode");
  const key = searchParams.get("key");

  if (mode === "demo") {
    if (key) {
      const found = DEMO_RESOURCES.find((r) => r.key === key || r.id === key);
      return NextResponse.json({ data: found || null, isDemo: true });
    }
    return NextResponse.json({ data: DEMO_RESOURCES, isDemo: true });
  }

  const result = await fetchLiveResources();
  if (!result.ok) {
    return NextResponse.json(
      { data: null, isDemo: false, error: result.message, code: result.code },
      { status: 503 }
    );
  }

  if (key) {
    const found = result.data.find((r) => r.key === key || r.id === key);
    return NextResponse.json({ data: found || null, isDemo: false });
  }

  return NextResponse.json({ data: result.data, isDemo: false });
}
