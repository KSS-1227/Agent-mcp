import { NextResponse } from "next/server";
import { checkBackendHealth } from "@/lib/server-db";
import { requireSession } from "@/lib/auth";

/**
 * Live reachability probe. There is deliberately no demo branch: demo fixtures
 * only exist for dashboard content, and must never fabricate backend health.
 */
export async function GET(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  try {
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
