import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
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
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("mode");

  if (mode === "demo") {
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
      error: NOT_PERSISTED.conflicts.message,
      detail: NOT_PERSISTED.conflicts.detail,
    },
    { status: 501 }
  );
}
