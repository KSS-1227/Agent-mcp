export interface EmbeddingIdentity {
  provider: string;
  model: string;
}

export function assertActiveEmbeddingIdentity(identity: EmbeddingIdentity): void {
  if (!identity || !identity.provider?.trim() || !identity.model?.trim() ||
      identity.provider === "legacy" || identity.model === "unverified") {
    throw new Error("A verified embedding provider and model identity is required");
  }
}
