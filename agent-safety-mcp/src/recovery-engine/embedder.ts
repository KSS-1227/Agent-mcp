import type { Embedder } from "./reconciliation";
import { CloudflareEmbedder } from "./cloudflare-embedder";
import { TitanEmbedder } from "./titan-embedder";

export type EmbeddingProvider = "cloudflare" | "titan";
export interface RecoveryEmbedder extends Embedder {
  checkAvailability(): Promise<void>;
}

export function getEmbeddingProvider(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider {
  const provider = env.EMBEDDING_PROVIDER?.trim().toLowerCase() || "titan";
  if (provider !== "cloudflare" && provider !== "titan") {
    throw new Error('EMBEDDING_PROVIDER must be either "cloudflare" or "titan"');
  }
  return provider;
}

/** Selects exactly one recovery embedder; failures never trigger provider substitution. */
export function getRecoveryEmbedder(): RecoveryEmbedder {
  return getEmbeddingProvider() === "cloudflare" ? new CloudflareEmbedder() : new TitanEmbedder();
}
