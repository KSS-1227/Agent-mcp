import { NextResponse } from "next/server";
import { getScope } from "@/lib/data-scope";
import { NOT_PERSISTED } from "@/lib/not-persisted";
import { DEMO_CONFLICTS, DEMO_PROVENANCE_GRAPH } from "@/lib/demo-data";

/**
 * Conflict adjudication history.
 *
 * The unified backend evaluates conflicts in-process and returns the verdict to
 * the calling agent; it never writes to the `conflicts` table. This endpoint
 * therefore reports the capability as unsupported instead of pretending to be an
 * empty history. Live provenance is served separately by /api/provenance.
 */
export async function GET(request: Request) {
  const scope = await getScope(request);
  if (!scope) return NextResponse.json({ error: "Authentication required.", code: "UNAUTHENTICATED" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("mode");

  if (scope.kind === "operator" && mode === "demo") {
    return NextResponse.json({
      data: DEMO_CONFLICTS,
      graph: DEMO_PROVENANCE_GRAPH,
      supported: true,
      isDemo: true,
    });
  }

  return NextResponse.json(
    {
      data: [],
      graph: null,
      supported: false,
      isDemo: false,
      code: NOT_PERSISTED.conflicts.code,
      error: scope.kind === "user" ? "Conflict history is not available for your account." : NOT_PERSISTED.conflicts.message,
      detail: scope.kind === "user" ? "Conflict adjudications are not exposed in user scope." : NOT_PERSISTED.conflicts.detail,
    },
    { status: 501 }
  );
}
