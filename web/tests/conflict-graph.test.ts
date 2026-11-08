import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConflictGraph, type GraphEdge, type GraphNode } from "@/components/conflict/ConflictGraph";

function render(nodes: GraphNode[], edges: GraphEdge[], selectedNodeId?: string): string {
  return renderToStaticMarkup(
    React.createElement(ConflictGraph, { nodes, edges, selectedNodeId })
  ).replace(/<!-- -->/g, "");
}

const liveNodes: GraphNode[] = [
  { id: "agent:a1", label: "Reconciler Worker", type: "agent", status: "active", metadata: { key: "test-reconciler-worker" } },
  { id: "agent:a2", label: "Test Agent", type: "agent", status: "active", metadata: { key: "test-agent" } },
  { id: "intent:i1", label: "Restore the ledger", type: "intent", status: "open", metadata: { statement: "Restore the ledger" } },
  { id: "res:r1", label: "ledger (v2)", type: "resource", status: "stable", metadata: { type: "config", version: 2 } },
  { id: "res:r2", label: "queue (v1)", type: "resource", status: "stable", metadata: { type: "config", version: 1 } },
];

const liveEdges: GraphEdge[] = [
  { id: "e-declares", source: "agent:a1", target: "intent:i1", label: "declares" },
  { id: "e-read", source: "intent:i1", target: "res:r1", label: "reads (v1)", status: "safe" },
];

describe("ConflictGraph rendering", () => {
  it("draws one column per entity type that exists, with counts", () => {
    const html = render(liveNodes, liveEdges);

    expect(html).toContain("AGENTS (2)");
    expect(html).toContain("DECLARED INTENTS (1)");
    expect(html).toContain("VERSIONED RESOURCES (2)");
    // No conflict records in live data, so no adjudication column is claimed.
    expect(html).not.toContain("CONFLICT NODES");
    expect(html).toContain("All Nodes (5)");
  });

  it("marks each node card with its type and draws every resolvable edge", () => {
    const html = render(liveNodes, liveEdges);

    expect(html).toContain("AGENT · active");
    expect(html).toContain("INTENT · open");
    expect(html).toContain("RESOURCE · stable");
    expect(html).toContain("declares");
    expect(html).toContain("reads (v1)");
    expect(html.match(/marker-end=/g) ?? []).toHaveLength(2);
    expect(html).toContain("5/5 shown");
  });

  it("reports edges whose endpoints are missing instead of drawing them silently", () => {
    const html = render(liveNodes, [
      ...liveEdges,
      { id: "e-orphan", source: "intent:i1", target: "res:missing", label: "reads (v9)" },
    ]);

    expect(html.match(/marker-end=/g) ?? []).toHaveLength(2);
    expect(html).toContain("1 unresolved");
    expect(html).toContain("declares");
  });

  it("shows a conflict column only when conflict records are present (demo data)", () => {
    const html = render([...liveNodes, { id: "conf:c1", label: "Conflict: v1 != v2", type: "conflict", status: "invalidating" }], [
      ...liveEdges,
      { id: "e-conf", source: "res:r1", target: "conf:c1", label: "triggered", status: "invalidated" },
    ]);

    expect(html).toContain("CONFLICT NODES (1)");
    expect(html).toContain("Conflict node");
    expect(html).toContain("Conflicts Only (2)");
  });

  it("renders a details panel with stored metadata and real relationships", () => {
    const html = render(liveNodes, liveEdges, "agent:a1");

    expect(html).toContain("Relationships (1)");
    expect(html).toContain("test-reconciler-worker");
    expect(html).toContain("Restore the ledger");
    expect(html).toContain("declares");
  });

  it("renders no details panel when nothing is selected", () => {
    expect(render(liveNodes, liveEdges)).not.toContain("Relationships (");
  });

  it("stays renderable with an empty graph", () => {
    const html = render([], []);
    expect(html).toContain("All Nodes (0)");
    expect(html).toContain("0/0 shown");
  });

  it("draws every node of a live-sized graph (15 agents, 14 intents, 89 resources)", () => {
    const nodes: GraphNode[] = [];
    for (let i = 0; i < 15; i += 1) {
      nodes.push({ id: `agent:${i}`, label: `Agent ${i}`, type: "agent", status: "active" });
    }
    for (let i = 0; i < 14; i += 1) {
      nodes.push({ id: `intent:${i}`, label: `Intent ${i}`, type: "intent", status: "open" });
    }
    for (let i = 0; i < 89; i += 1) {
      nodes.push({ id: `res:${i}`, label: `resource-${i} (v1)`, type: "resource", status: "stable" });
    }

    const html = render(nodes, liveEdges);

    expect(nodes).toHaveLength(118);
    expect(html).toContain("AGENTS (15)");
    expect(html).toContain("DECLARED INTENTS (14)");
    expect(html).toContain("VERSIONED RESOURCES (89)");
    expect(html).toContain("All Nodes (118)");
    expect(html).toContain("118/118 shown");
    expect(html.match(/cursor-pointer/g) ?? []).toHaveLength(118);
    // 89 resources across 8 sub-columns of 12 rows each.
    expect(html).toContain("resource-88 (v1)");
  });
});
