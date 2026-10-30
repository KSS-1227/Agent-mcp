import { describe, expect, it, vi } from "vitest";
import { ActionCoordinator } from "../../src/recovery-engine/coordinator";
import { AtomicCommit, VerdictDisposition, verdictDispositionToString } from "../../src/recovery-engine/types";

describe("GitHub recovery evidence persistence", () => {
  it("writes verifier evidence in the same transaction as action recovery and episode memory", async () => {
    const intentId = "11111111-1111-4111-8111-111111111111";
    const stepId = "22222222-2222-4222-8222-222222222222";
    const episodeId = `${intentId}:${stepId}`;
    const commit: AtomicCommit = {
      idemKey: "a".repeat(64),
      leaseOwner: "33333333-3333-4333-8333-333333333333",
      receipt: {
        externalRef: "42",
        outcome: { status: "success", issue_number: 42, html_url: "https://github.com/test/repo/issues/42" },
      },
      evidenceWrite: {
        source: "github.create_issue",
        evidenceType: "verified_external_effect",
        externalReference: "42",
        payload: {
          // Derived from the production mapping: a hand-written label would let a
          // numeric-vs-string regression pass unnoticed.
          disposition: verdictDispositionToString(VerdictDisposition.Applied),
          reason: "GitHub repository API confirmed the issue and correlation marker",
          correlationMarker: `<!-- agent-safety-mcp-action:${"a".repeat(64)} -->`,
          outcome: { issue_number: 42, html_url: "https://github.com/test/repo/issues/42" },
        },
      },
      memoryWrite: {
        episodeId,
        narrative: "Recovered GitHub issue by matching its correlation marker",
        outcome: "recovered",
        embedding: new Array(1024).fill(0.01),
        embeddingProvider: "test",
        embeddingModel: "test-1024",
      },
    };
    const statements: Array<{ sql: string; values?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        statements.push({ sql, values });
        if (sql.includes("SELECT status FROM episodes")) return { rowCount: 1, rows: [{ status: "resolved" }] };
        if (sql.includes("SELECT status, intent_id FROM intent_steps")) return { rowCount: 1, rows: [{ status: "done", intent_id: intentId }] };
        if (sql.includes("INSERT INTO action_evidence")) return { rowCount: 1, rows: [{ id: "evidence-id" }] };
        if (sql.includes("UPDATE episodes") && sql.includes("SET narrative = $2")) return { rowCount: 1, rows: [] };
        if (sql.includes("SET status = 'COMMITTED'")) return { rowCount: 1, rows: [] };
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(client) };

    await new ActionCoordinator(pool as any, commit.leaseOwner).commitAtomic(commit);

    const evidenceIndex = statements.findIndex(({ sql }) => sql.includes("INSERT INTO action_evidence"));
    const memoryIndex = statements.findIndex(({ sql }) => sql.includes("SET narrative = $2"));
    const commitIndex = statements.findIndex(({ sql }) => sql === "COMMIT");
    expect(evidenceIndex).toBeGreaterThan(-1);
    expect(evidenceIndex).toBeLessThan(memoryIndex);
    expect(memoryIndex).toBeLessThan(commitIndex);
    expect(statements[evidenceIndex].values).toEqual([
      commit.idemKey,
      commit.evidenceWrite?.source,
      commit.evidenceWrite?.evidenceType,
      commit.evidenceWrite?.externalReference,
      JSON.stringify(commit.evidenceWrite?.payload),
    ]);
    expect(client.release).toHaveBeenCalledOnce();

    // The payload carries the stable label, never the enum ordinal.
    const persistedDisposition = commit.evidenceWrite?.payload.disposition;
    expect(persistedDisposition).toBe(verdictDispositionToString(VerdictDisposition.Applied));
    expect(typeof persistedDisposition).toBe("string");
    expect(persistedDisposition).not.toBe(VerdictDisposition.Applied);
  });

  it("maps every disposition to its stable label and still reads legacy ordinals", () => {
    expect(verdictDispositionToString(VerdictDisposition.Applied)).toBe("APPLIED");
    expect(verdictDispositionToString(VerdictDisposition.NotApplied)).toBe("NOT_APPLIED");
    expect(verdictDispositionToString(VerdictDisposition.Unknown)).toBe("UNKNOWN");
    // Evidence rows written before the label change hold the ordinal.
    expect(verdictDispositionToString(0)).toBe("APPLIED");
    expect(verdictDispositionToString(1)).toBe("NOT_APPLIED");
    // Already-mapped labels round-trip, unknown input stays UNKNOWN.
    expect(verdictDispositionToString("applied")).toBe("APPLIED");
    expect(verdictDispositionToString(null)).toBe("UNKNOWN");
    expect(verdictDispositionToString(undefined)).toBe("UNKNOWN");
  });
});
