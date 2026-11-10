import { NextResponse } from "next/server";
import { getScope } from "@/lib/data-scope";
import { DEMO_ACTIONS } from "@/lib/demo-data";
import type { Action } from "@/types";

/** Idempotency keys are SHA-256 hex (or opaque VARCHAR(255)) — never SQL, but validate anyway. */
const ACTION_KEY_PATTERN = /^[A-Za-z0-9:_-]{1,255}$/;

export async function GET(request: Request) {
  const scope = await getScope(request);
  if (!scope) return NextResponse.json({ error: "Authentication required.", code: "UNAUTHENTICATED" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("mode");

  if (scope.kind === "user") {
    const { data: rows, error } = await scope.supabase.from("actions")
      .select("idempotency_key, episode_id, agent_id, action_type, arguments, status, lease_owner, lease_expires_at, external_reference, outcome, attempts, created_at, resolved_at, effect_state, effect_started_at, effect_completed_at, verifier_response, verified_at")
      .eq("status", "PENDING")
      .lt("lease_expires_at", new Date().toISOString())
      .order("created_at", { ascending: false });
    if (error) return NextResponse.json({ awaitingReconciliation: [], resolvedHistory: [], reconcilerAgentKey: null, reconcilerNote: null, isDemo: false, limited: true, error: "Could not load recovery actions.", code: "USER_QUERY_FAILED" }, { status: 503 });
    const awaitingReconciliation: Action[] = (rows ?? []).map((row) => ({
      idemKey: row.idempotency_key, episodeId: row.episode_id, agentId: row.agent_id,
      actionType: row.action_type, actionArgs: row.arguments, status: row.status,
      leaseOwner: row.lease_owner ?? undefined, leaseExpires: row.lease_expires_at ?? undefined,
      externalRef: row.external_reference ?? undefined, outcome: row.outcome ?? undefined,
      attempts: row.attempts, createdAt: row.created_at, resolvedAt: row.resolved_at ?? undefined,
      effectState: row.effect_state, effectStartedAt: row.effect_started_at ?? undefined,
      effectCompletedAt: row.effect_completed_at ?? undefined, verifierResponse: row.verifier_response,
      verifiedAt: row.verified_at, resourceVersions: null,
    } as Action));
    return NextResponse.json({ awaitingReconciliation, resolvedHistory: [], reconcilerAgentKey: null, reconcilerNote: "Recovery details are limited to your own action rows.", isDemo: false, limited: true });
  }

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

  const { fetchLiveActions } = await import("@/lib/server-db");
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
  const scope = await getScope(request);
  if (!scope) return NextResponse.json({ error: "Authentication required.", code: "UNAUTHENTICATED" }, { status: 401 });

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

  if (scope.kind === "user") {
    const { data: row, error } = await scope.supabase.from("actions")
      .select("idempotency_key, status, effect_state, lease_owner, lease_expires_at, attempts, external_reference, verifier_response, verified_at, resolved_at")
      .eq("idempotency_key", actionKey)
      .maybeSingle();
    if (error) return NextResponse.json({ error: "Could not inspect this action.", code: "USER_QUERY_FAILED" }, { status: 503 });
    if (!row) return NextResponse.json({ error: "No action with that idempotency key exists.", code: "ACTION_NOT_FOUND" }, { status: 404 });
    return NextResponse.json({
      success: true, operation: "inspect", isDemo: false, simulated: false, limited: true,
      actionKey: row.idempotency_key,
      action: {
        status: row.status, effectState: row.effect_state, leaseOwner: row.lease_owner,
        leaseExpires: row.lease_expires_at, attempts: row.attempts, externalRef: row.external_reference,
        verifierResponse: row.verifier_response, verifiedAt: row.verified_at, resolvedAt: row.resolved_at,
      },
      message: "Read-only inspection complete. No action or other row was changed.",
    });
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

  const { fetchLiveActionByKey } = await import("@/lib/server-db");
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
