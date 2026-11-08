import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const fetchLiveProvenance = vi.fn();
const requireSession = vi.fn();

vi.mock("@/lib/server-db", () => ({ fetchLiveProvenance }));
vi.mock("@/lib/auth", () => ({ requireSession }));

const { GET } = await import("@/app/api/provenance/route");

function graphFixture() {
  return {
    ok: true as const,
    data: {
      nodes: [
        { id: "agent:a1", label: "Agent One", type: "agent" as const, status: "active" },
        { id: "agent:a2", label: "Agent Two", type: "agent" as const, status: "active" },
        { id: "intent:i1", label: "Do the thing", type: "intent" as const, status: "open" },
        { id: "res:r1", label: "bucket (v1)", type: "resource" as const, status: "stable" },
        { id: "res:r2", label: "queue (v3)", type: "resource" as const, status: "stable" },
      ],
      edges: [
        { id: "e1", source: "agent:a1", target: "intent:i1", label: "declares" },
        { id: "e2", source: "intent:i1", target: "res:r1", label: "reads (v1)", status: "safe" as const },
      ],
      note: "live note",
      truncated: [] as string[],
    },
  };
}

const call = () => GET(new Request("http://localhost:3000/api/provenance"));

beforeEach(() => {
  vi.clearAllMocks();
  requireSession.mockResolvedValue(null);
  fetchLiveProvenance.mockResolvedValue(graphFixture());
});

describe("GET /api/provenance", () => {
  it("serves the live graph with per-type counts and isDemo false", async () => {
    const response = await call();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.isDemo).toBe(false);
    expect(body.counts).toEqual({
      nodes: 5,
      edges: 2,
      agents: 2,
      intents: 1,
      resources: 2,
      conflicts: 0,
    });
    expect(body.truncated).toEqual([]);
    expect(body.graph.nodes).toHaveLength(5);
    expect(body.graph.edges).toHaveLength(2);
  });

  it("passes truncation through instead of hiding a partial read", async () => {
    const fixture = graphFixture();
    fixture.data.truncated = ["resources"];
    fetchLiveProvenance.mockResolvedValue(fixture);

    const body = await (await call()).json();
    expect(body.truncated).toEqual(["resources"]);
  });

  it("answers 503 with no graph when the read fails", async () => {
    fetchLiveProvenance.mockResolvedValue({
      ok: false,
      code: "QUERY_FAILED",
      message: "Read failed.",
    });

    const response = await call();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({ graph: null, isDemo: false, code: "QUERY_FAILED" });
  });

  it("returns the guard response when the session is not valid", async () => {
    requireSession.mockResolvedValue(
      NextResponse.json({ error: "Authentication required.", code: "UNAUTHENTICATED" }, { status: 401 })
    );

    const response = await call();
    expect(response.status).toBe(401);
    expect(fetchLiveProvenance).not.toHaveBeenCalled();
  });
});
