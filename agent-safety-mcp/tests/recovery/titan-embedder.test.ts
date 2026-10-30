import { describe, expect, it, vi } from "vitest";
import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { TitanEmbedder, TITAN_EMBEDDING_MODEL } from "../../src/recovery-engine/titan-embedder";

describe("Titan recovery embedder", () => {
  it("preserves the 1024-dimensional Titan Text Embeddings V2 contract", async () => {
    const vector = Array.from({ length: 1024 }, (_, index) => index / 1024);
    const send = vi.fn().mockResolvedValue({ body: new TextEncoder().encode(JSON.stringify({ embedding: vector })) });
    const embedder = new TitanEmbedder({ send } as unknown as BedrockRuntimeClient);
    await expect(embedder.embed("recovery episode")).resolves.toEqual(vector);
    const command = send.mock.calls[0][0];
    expect(command.input.modelId).toBe(TITAN_EMBEDDING_MODEL);
    expect(JSON.parse(new TextDecoder().decode(command.input.body))).toMatchObject({ inputText: "recovery episode", dimensions: 1024, normalize: true });
  });

  it("rejects malformed vectors before they reach recovery persistence", async () => {
    const send = vi.fn().mockResolvedValue({ body: new TextEncoder().encode(JSON.stringify({ embedding: [1, 2, 3] })) });
    const embedder = new TitanEmbedder({ send } as unknown as BedrockRuntimeClient);
    await expect(embedder.embed("recovery episode")).rejects.toThrow("exactly 1024 finite embedding values");
  });
});
