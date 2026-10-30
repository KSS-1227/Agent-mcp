import type { Embedder } from "./reconciliation";
import { EPISODE_EMBEDDING_DIMENSIONS } from "./reconciliation";
import type { EmbeddingIdentity } from "./embedding-identity";

export const CLOUDFLARE_EMBEDDING_MODEL = "@cf/baai/bge-m3";
const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4/accounts";
const DEFAULT_TIMEOUT_MS = 30_000;

interface CloudflareEmbedderOptions {
  accountId?: string;
  apiToken?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class CloudflareEmbedder implements Embedder {
  readonly identity: EmbeddingIdentity;
  private readonly accountId: string;
  private readonly apiToken: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: CloudflareEmbedderOptions = {}) {
    this.accountId = (options.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
    this.apiToken = (options.apiToken ?? process.env.CLOUDFLARE_API_TOKEN ?? "").trim();
    this.model = (options.model ?? process.env.CLOUDFLARE_EMBEDDING_MODEL ?? CLOUDFLARE_EMBEDDING_MODEL).trim();
    this.identity = { provider: "cloudflare-workers-ai", model: this.model };
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async embed(text: string): Promise<number[]> {
    if (typeof text !== "string" || !text.trim()) throw new Error("Embedding input must be non-empty text");
    if (!this.accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is required for Cloudflare embeddings");
    if (!this.apiToken) throw new Error("CLOUDFLARE_API_TOKEN is required for Cloudflare embeddings");
    if (!/^@?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(this.model)) {
      throw new Error("CLOUDFLARE_EMBEDDING_MODEL is invalid");
    }
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 300_000) {
      throw new Error("Cloudflare embedding timeout must be between 100 and 300000 milliseconds");
    }

    // The model identifier is restricted above to safe path characters; keep
    // its leading @ literal to match Cloudflare's documented route.
    const endpoint = `${CLOUDFLARE_API}/${encodeURIComponent(this.accountId)}/ai/run/${this.model}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ text: [text] }),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) throw new Error(`Cloudflare embedding request timed out after ${this.timeoutMs}ms`);
        if (error instanceof TypeError) throw new Error("Cloudflare embedding endpoint is unavailable");
        throw error;
      }

      if (!response.ok) throw new Error(`Cloudflare embedding request failed with HTTP ${response.status}`);

      let payload: unknown;
      try { payload = await response.json(); }
      catch {
        if (controller.signal.aborted) throw new Error(`Cloudflare embedding request timed out after ${this.timeoutMs}ms`);
        throw new Error("Cloudflare returned malformed embedding JSON");
      }
      if (!payload || typeof payload !== "object") throw new Error("Cloudflare returned an empty or malformed embedding response");

      const result = payload as {
        success?: unknown;
        result?: { data?: unknown; shape?: unknown };
      };
      if (result.success !== true) throw new Error("Cloudflare embedding API reported failure");
      const shape = result.result?.shape;
      if (!Array.isArray(shape) || shape.length !== 2 || shape[0] !== 1 || shape[1] !== EPISODE_EMBEDDING_DIMENSIONS) {
        throw new Error(`Cloudflare embedding shape must be [1, ${EPISODE_EMBEDDING_DIMENSIONS}]`);
      }
      const data = result.result?.data;
      if (!Array.isArray(data) || data.length !== 1 || !Array.isArray(data[0])) {
        throw new Error("Cloudflare must return exactly one embedding for a single-text request");
      }
      const vector = data[0];
      if (vector.length !== EPISODE_EMBEDDING_DIMENSIONS ||
          !vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
        throw new Error(`Cloudflare must return exactly ${EPISODE_EMBEDDING_DIMENSIONS} finite embedding values`);
      }
      return vector;
    } finally {
      clearTimeout(timer);
    }
  }

  async checkAvailability(): Promise<void> {
    await this.embed("Agent Safety MCP recovery embedder availability check");
  }
}
