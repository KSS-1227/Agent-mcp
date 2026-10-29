import type { Embedder } from "./reconciliation";
import { EPISODE_EMBEDDING_DIMENSIONS } from "./reconciliation";

export const OLLAMA_EMBEDDING_MODEL = "mxbai-embed-large";
export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

export class OllamaEmbedder implements Embedder {
  readonly baseUrl: string;

  constructor(
    baseUrl = process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL,
    private readonly fetcher: typeof fetch = fetch
  ) {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error("OLLAMA_BASE_URL must be a valid HTTP(S) URL");
    }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("OLLAMA_BASE_URL must be a valid HTTP(S) base URL without credentials or query parameters");
    }
    this.baseUrl = parsed.toString().replace(/\/$/, "");
  }

  async checkAvailability(): Promise<void> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    } catch {
      throw new Error("Ollama is unavailable");
    }
    if (!response.ok) throw new Error(`Ollama model check failed (HTTP ${response.status})`);
    let payload: any;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Ollama returned a malformed model list");
    }
    if (!Array.isArray(payload?.models) || !payload.models.some((model: any) => {
      const name = model?.name ?? model?.model;
      return typeof name === "string" && (name === OLLAMA_EMBEDDING_MODEL || name.startsWith(`${OLLAMA_EMBEDDING_MODEL}:`));
    })) {
      throw new Error("Ollama model is not installed");
    }
  }

  async embed(text: string): Promise<number[]> {
    if (typeof text !== "string" || !text.trim()) throw new Error("Embedding input must be non-empty text");
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: OLLAMA_EMBEDDING_MODEL, input: text }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error("Ollama embedding request failed");
    }
    if (!response.ok) throw new Error(`Ollama embedding request failed (HTTP ${response.status})`);
    let payload: any;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Ollama returned a malformed embedding response");
    }
    const vector = Array.isArray(payload?.embeddings) && payload.embeddings.length === 1
      ? payload.embeddings[0]
      : undefined;
    if (!Array.isArray(vector) || vector.length !== EPISODE_EMBEDDING_DIMENSIONS ||
        !vector.every((value: unknown) => typeof value === "number" && Number.isFinite(value))) {
      throw new Error(`Ollama must return exactly ${EPISODE_EMBEDDING_DIMENSIONS} finite embedding values`);
    }
    return vector;
  }
}
