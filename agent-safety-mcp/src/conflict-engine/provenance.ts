/**
 * Provenance Graph - Tracks dependencies between resources and steps
 *
 * The provenance graph is core to Interlock's selective repair:
 * - When a resource changes, find all steps that descend from it
 * - Only those steps are candidates for invalidation/repair
 * - Steps that are independent continue unaffected
 *
 * This is a recursive CTE in the real Interlock (PostgreSQL); here we
 * implement it as a graph walk with memoization.
 */

import { PlanStep, ProvenanceEdge } from "../core/types";

export class ProvenanceGraph {
  private edges: ProvenanceEdge[] = [];
  private adjacency = new Map<string, ProvenanceEdge[]>();

  /**
   * Add an edge: from -> to
   */
  addEdge(edge: ProvenanceEdge): void {
    this.edges.push(edge);

    // Build adjacency for fast lookup
    const key = `${edge.fromKind}:${edge.fromId}`;
    if (!this.adjacency.has(key)) {
      this.adjacency.set(key, []);
    }
    this.adjacency.get(key)!.push(edge);
  }

  /**
   * Record that a step depends on a resource
   */
  recordResourceDependency(resourceId: string, stepId: string): void {
    this.addEdge({
      fromKind: "resource",
      fromId: resourceId,
      toKind: "step",
      toId: stepId,
    });
  }

  /**
   * Record that a step depends on the previous step
   */
  recordStepDependency(prevStepId: string, nextStepId: string): void {
    this.addEdge({
      fromKind: "step",
      fromId: prevStepId,
      toKind: "step",
      toId: nextStepId,
    });
  }

  /**
   * Find all steps that transitively depend on a resource.
   * This is the "blast radius" â€” how many steps are affected by this resource changing?
   *
   * Uses depth-first search with memoization.
   */
  findDependentSteps(resourceId: string, steps: PlanStep[]): PlanStep[] {
    const visited = new Set<string>();
    const dependent = new Set<string>();

    const dfs = (kind: string, id: string) => {
      const key = `${kind}:${id}`;
      if (visited.has(key)) return;
      visited.add(key);

      const neighbors = this.adjacency.get(key) || [];
      for (const edge of neighbors) {
        const toKey = `${edge.toKind}:${edge.toId}`;
        if (edge.toKind === "step") {
          dependent.add(edge.toId);
        }
        dfs(edge.toKind, edge.toId);
      }
    };

    dfs("resource", resourceId);

    // Return steps in sequence order for deterministic ordering
    return steps.filter((s) => dependent.has(s.id)).sort((a, b) => a.seq - b.seq);
  }

  /**
   * Find which of the given steps are affected by changes to the given resources.
   */
  findAffectedSteps(changedResourceIds: string[], steps: PlanStep[]): PlanStep[] {
    const affected = new Set<string>();

    for (const resourceId of changedResourceIds) {
      const dependent = this.findDependentSteps(resourceId, steps);
      for (const step of dependent) {
        affected.add(step.id);
      }
    }

    return steps.filter((s) => affected.has(s.id)).sort((a, b) => a.seq - b.seq);
  }

  /**
   * Find which of the given steps are independent (NOT affected).
   */
  findPreservedSteps(changedResourceIds: string[], steps: PlanStep[]): PlanStep[] {
    const affected = this.findAffectedSteps(changedResourceIds, steps);
    const affectedIds = new Set(affected.map((s) => s.id));
    return steps.filter((s) => !affectedIds.has(s.id)).sort((a, b) => a.seq - b.seq);
  }

  /**
   * Get all edges
   */
  getEdges(): ProvenanceEdge[] {
    return this.edges;
  }

  /**
   * Clear the graph (for testing)
   */
  clear(): void {
    this.edges = [];
    this.adjacency.clear();
  }
}

// Singleton instance
let provenanceGraph: ProvenanceGraph | null = null;

export function getProvenanceGraph(): ProvenanceGraph {
  if (!provenanceGraph) {
    provenanceGraph = new ProvenanceGraph();
  }
  return provenanceGraph;
}

export function setProvenanceGraph(graph: ProvenanceGraph): void {
  provenanceGraph = graph;
}


