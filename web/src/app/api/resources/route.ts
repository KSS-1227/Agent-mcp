import { NextResponse } from "next/server";
import { getScope } from "@/lib/data-scope";
import { DEMO_RESOURCES } from "@/lib/demo-data";

export async function GET(request: Request) {
  const scope = await getScope(request);
  if (!scope) return NextResponse.json({ error: "Authentication required.", code: "UNAUTHENTICATED" }, { status: 401 });
  if (scope.kind === "user") return NextResponse.json({ error: "Operator access required.", code: "OPERATOR_REQUIRED" }, { status: 403 });

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

  const { fetchLiveResources } = await import("@/lib/server-db");
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
