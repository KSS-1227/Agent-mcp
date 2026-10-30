import { afterEach, describe, expect, it, vi } from "vitest";
import { adjudicateWithGrok } from "../../src/conflict-engine/detection";
import { IntentService } from "../../src/conflict-engine/intent.service";
import { ProvenanceGraph, setProvenanceGraph } from "../../src/conflict-engine/provenance";
import { ResourceService } from "../../src/core/resource.service";
import { NemotronChatCompletionsClient } from "../../src/providers/nemotron";

describe("Nemotron Conflict Engine integration", () => {
  afterEach(() => setProvenanceGraph(new ProvenanceGraph()));

  it("retains the deterministic invalidating verdict when model output is malformed", async () => {
    const resources = new ResourceService();
    const intents = new IntentService();
    const graph = new ProvenanceGraph();
    setProvenanceGraph(graph);
    const resource = resources.registerResource("shared", "document", { value: 1 });
    const intent = intents.declareIntent(
      "agent-a", "task-a", "Update the dependent document",
      [{ resourceId: resource.id, observedVersion: resource.version }],
      [{ description: "Update document", dependsOn: [resource.id] }]
    );
    const step = intents.getIntentSteps(intent.id)[0];
    graph.recordResourceDependency(resource.id, step.id);
    resources.updateResource(resource.id, { value: 2 }, resource.version);
    const provider = new NemotronChatCompletionsClient({
      token: () => "test-token",
      baseUrl: "https://endpoint.example/v1",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ choices: [] }), { status: 200 })
      ),
    });

    const result = await adjudicateWithGrok("commit-a", intent.id, resources, intents, provider);
    expect(result.verdict).toBe("invalidating");
    expect(result.affectedSteps).toEqual([step.seq]);
    expect(result.providerError).toContain("missing choices");
  });
});
