import { NextResponse } from "next/server";
import { getScope } from "@/lib/data-scope";

/**
 * Live reachability probe. There is deliberately no demo branch: demo fixtures
 * only exist for dashboard content, and must never fabricate backend health.
 */
export async function GET(request: Request) {
  const scope = await getScope(request);
  if (!scope) return NextResponse.json({ error: "Authentication required.", code: "UNAUTHENTICATED" }, { status: 401 });
  if (scope.kind === "user") return NextResponse.json({ error: "Operator access required.", code: "OPERATOR_REQUIRED" }, { status: 403 });

  try {
    const { checkBackendHealth } = await import("@/lib/server-db");
    const health = await checkBackendHealth();
    return NextResponse.json(health);
  } catch {
    return NextResponse.json(
      {
        status: "disconnected",
        mode: "live",
        database: { configured: false, reachable: false, errorCode: "UNKNOWN" },
        backend: {
          configured: false,
          reachable: false,
          liveness: false,
          readiness: false,
          errorCode: "UNKNOWN",
        },
        provider: {
          verified: false,
          note: "Provider health is not exposed by the backend.",
        },
        checkedAt: new Date().toISOString(),
        error: "Backend health could not be inspected.",
        code: "HEALTH_CHECK_FAILED",
      },
      { status: 503 }
    );
  }
}
