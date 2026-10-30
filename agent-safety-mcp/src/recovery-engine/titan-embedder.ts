import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import type { Embedder } from "./reconciliation";
import { EPISODE_EMBEDDING_DIMENSIONS } from "./reconciliation";
import type { EmbeddingIdentity } from "./embedding-identity";

export const TITAN_EMBEDDING_MODEL = "amazon.titan-embed-text-v2:0";

export class TitanEmbedder implements Embedder {
  readonly identity: EmbeddingIdentity;

  constructor(private readonly client = new BedrockRuntimeClient({ region: process.env.AWS_REGION || "us-east-1" })) {
    this.identity = {
      provider: "aws-bedrock",
      model: process.env.BEDROCK_MODEL_EMBEDDINGS?.trim() || TITAN_EMBEDDING_MODEL,
    };
  }

  async embed(text: string): Promise<number[]> {
    if (typeof text !== "string" || !text.trim()) throw new Error("Embedding input must be non-empty text");
    const response = await this.client.send(new InvokeModelCommand({
      modelId: this.identity.model,
      contentType: "application/json",
      accept: "application/json",
      body: new TextEncoder().encode(JSON.stringify({ inputText: text, dimensions: EPISODE_EMBEDDING_DIMENSIONS, normalize: true })),
    }));
    if (!response.body) throw new Error("Titan returned an empty embedding response");
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder().decode(response.body)); }
    catch { throw new Error("Titan returned malformed embedding JSON"); }
    const vector = payload && typeof payload === "object" ? (payload as { embedding?: unknown }).embedding : undefined;
    if (!Array.isArray(vector) || vector.length !== EPISODE_EMBEDDING_DIMENSIONS ||
        !vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw new Error(`Titan must return exactly ${EPISODE_EMBEDDING_DIMENSIONS} finite embedding values`);
    }
    return vector;
  }

  async checkAvailability(): Promise<void> {
    await this.embed("Agent Safety MCP recovery embedder availability check");
  }
}
