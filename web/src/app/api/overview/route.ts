import { NextResponse } from "next/server";
import { fetchLiveOverview } from "@/lib/server-db";
import { requireSession } from "@/lib/auth";
import { DEMO_OVERVIEW_METRICS } from "@/lib/demo-data";

export async function GET(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("mode");

  if (mode === "demo") {
    return NextResponse.json({
      data: DEMO_OVERVIEW_METRICS,
      isDemo: true,
      source: "Demonstration fixtures (deterministic sample data)",
    });
  }

  const result = await fetchLiveOverview();
  if (!result.ok) {
    return NextResponse.json(
      {
        data: null,
        isDemo: false,
        error: result.message,
        code: result.code,
      },
      { status: 503 }
    );
  }

  return NextResponse.json({
    data: result.data,
    isDemo: false,
    source: "Live PostgreSQL (read-only)",
  });
}
