/**
 * Static facts about what the unified backend persists.
 *
 * Verified against `agent-safety-mcp/src`: no code path executes
 * `INSERT INTO conflicts` or `INSERT INTO action_evidence`. The tables exist in
 * the migrations, but nothing ever writes to them, so the dashboard must not
 * pretend to read a conflict history or an evidence ledger.
 */
export const NOT_PERSISTED = {
  conflicts: {
    code: "CONFLICTS_NOT_PERSISTED",
    message:
      "Conflict adjudications are not persisted by the current backend. The conflict gate evaluates each plan in-process (declare_intent / prepare_action) and returns its verdict to the calling agent without writing a row to the conflicts table.",
    detail:
      "No conflict history or adjudication telemetry can be shown. Re-run the agent-facing MCP tool to obtain a live verdict.",
  },
  actionEvidence: {
    code: "ACTION_EVIDENCE_NOT_PERSISTED",
    message:
      "Verification evidence is not persisted by the current backend. External-effect verification results are stored on the action row itself (verifier_response / verified_at) instead of the action_evidence table.",
    detail:
      "Inspect Action Lifecycle for verifier_response and verified_at, or the Recovery Center for lease and effect state.",
  },
} as const;
