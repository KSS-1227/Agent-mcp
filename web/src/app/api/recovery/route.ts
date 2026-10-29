import { NextResponse } from "next/server";
import { fetchLiveActions, fetchLiveActionByKey } from "@/lib/server-db";
import { requireSession } from "@/lib/auth";
import { DEMO_ACTIONS } from "@/lib/demo-data";

/** Idempotency keys are SHA-256 hex (or opaque VARCHAR(255)) — never SQL, but validate anyway. */
const ACTION_KEY_PATTERN = /^[A-Za-z0-9:_-]{1,255}$/;

export async function GET(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("mode");

  if (mode === "demo") {
    const awaitingReconciliation = DEMO_ACTIONS.filter(
      (a) =>
        a.status === "PENDING" &&
        (a.effectState === "UNKNOWN" ||
          (a.leaseExpires && new Date(a.leaseExpires).getTime() < Date.now()))
    );

    const resolvedHistory = DEMO_ACTIONS.filter(
      (a) => a.status === "COMMITTED" || a.status === "FAILED"
    );

    return NextResponse.json({
      awaitingReconciliation,
      resolvedHistory,
      reconcilerAgentKey: null,
      reconcilerNote:
        "Demo fixtures. The reconciler daemon identity cannot be verified from the web tier.",
      isDemo: true,
    });
  }

  const result = await fetchLiveActions();
  if (!result.ok) {
    return NextResponse.json(
      {
        awaitingReconciliation: [],
        resolvedHistory: [],
        reconcilerAgentKey: null,
        reconcilerNote: null,
        isDemo: false,
        error: result.message,
        code: result.code,
      },
      { status: 503 }
    );
  }

  const now = Date.now();
  const awaitingReconciliation = result.data.filter(
    (a) =>
      a.status === "PENDING" &&
      (a.effectState === "UNKNOWN" ||
        !a.leaseExpires ||
        new Date(a.leaseExpires).getTime() < now)
  );

  const resolvedHistory = result.data.filter(
    (a) => a.status === "COMMITTED" || a.status === "FAILED"
  );

  return NextResponse.json({
    awaitingReconciliation,
    resolvedHistory,
    // The daemon runs inside the MCP backend process; its identity and liveness
    // are not observable here, so nothing is asserted about it.
    reconcilerAgentKey: null,
    reconcilerNote:
      "Reconciliation is performed by the backend ActionReconciler daemon. This dashboard cannot observe or trigger it.",
    isDemo: false,
  });
}

/**
 * Manual, read-only inspection.
 *
 * This does not trigger recovery, does not verify external ground truth and does
 * not mutate any row. It reports the action's persisted state and whether the
 * backend has already recorded a verifier disposition.
 */
export async function POST(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  let body: { actionKey?: unknown; mode?: unknown } | null = null;
  try {
    body = (await request.json()) as { actionKey?: unknown; mode?: unknown };
  } catch {
    body = null;
  }

  const actionKey = typeof body?.actionKey === "string" ? body.actionKey : "";
  if (!ACTION_KEY_PATTERN.test(actionKey)) {
    return NextResponse.json(
      { error: "A valid actionKey is required.", code: "INVALID_ACTION_KEY" },
      { status: 400 }
    );
  }

  if (body?.mode === "demo") {
    return NextResponse.json({
      success: true,
      operation: "inspect",
      isDemo: true,
      simulated: true,
      dispositionConfirmed: false,
      actionKey,
      message:
        "Demo mode: no backend call was made. This is a simulated preview, not a verification or a recovery.",
    });
  }

  const result = await fetchLiveActionByKey(actionKey);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.message, code: result.code },
      { status: 503 }
    );
  }

  const action = result.data;
  if (!action) {
    return NextResponse.json(
      { error: "No action with that idempotency key exists.", code: "ACTION_NOT_FOUND" },
      { status: 404 }
    );
  }

  const dispositionConfirmed =
    Boolean(action.verifierResponse) && Boolean(action.verifiedAt);

  return NextResponse.json({
    success: true,
    operation: "inspect",
    isDemo: false,
    simulated: false,
    actionKey: action.idemKey,
    dispositionConfirmed,
    action: {
      status: action.status,
      effectState: action.effectState,
      leaseOwner: action.leaseOwner ?? null,
      leaseExpires: action.leaseExpires ?? null,
      attempts: action.attempts,
      externalRef: action.externalRef ?? null,
      verifierResponse: action.verifierResponse ?? null,
      verifiedAt: action.verifiedAt ?? null,
      resolvedAt: action.resolvedAt ?? null,
    },
    message: dispositionConfirmed
      ? "Inspected. The backend has recorded a verifier disposition for this action; no further action was taken by the dashboard."
      : "Inspected. No verifier disposition has been recorded yet. Reconciliation is performed by the backend ActionReconciler daemon; this dashboard cannot trigger or verify it.",
  });
}
