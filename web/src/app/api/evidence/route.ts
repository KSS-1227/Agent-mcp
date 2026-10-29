import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { NOT_PERSISTED } from "@/lib/not-persisted";
import { DEMO_EVIDENCE } from "@/lib/demo-data";

/**
 * External-effect verification evidence.
 *
 * The unified backend records verifier results on the action row
 * (`verifier_response`, `verified_at`) and never writes to `action_evidence`,
 * so this endpoint reports the ledger as unsupported rather than empty.
 * Committed episodes are real and are served by /api/episodes.
 */
export async function GET(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("mode");
  const actionKey = searchParams.get("actionKey");

  if (mode === "demo") {
    let evidenceList = DEMO_EVIDENCE;
    if (actionKey) {
      evidenceList = evidenceList.filter((e) => e.actionKey === actionKey);
    }
    return NextResponse.json({
      evidence: evidenceList,
      supported: true,
      isDemo: true,
    });
  }

  return NextResponse.json(
    {
      evidence: [],
      supported: false,
      isDemo: false,
      code: NOT_PERSISTED.actionEvidence.code,
      error: NOT_PERSISTED.actionEvidence.message,
      detail: NOT_PERSISTED.actionEvidence.detail,
    },
    { status: 501 }
  );
}
