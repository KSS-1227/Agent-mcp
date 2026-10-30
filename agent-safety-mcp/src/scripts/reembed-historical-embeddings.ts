import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createDatabaseClient } from "../database/client";
import { loadApplicationEnvironment } from "../config/load-environment";
import { getEmbeddingProvider, getRecoveryEmbedder } from "../recovery-engine/embedder";
import { reembedHistoricalEmbeddings } from "../recovery-engine/reembed";

async function main(): Promise<void> {
  loadApplicationEnvironment(resolve(process.cwd(), ".env"));
  if (!process.env.DATABASE_URL?.startsWith("postgresql://")) {
    throw new Error("DATABASE_URL must be configured to re-embed stored vectors");
  }
  const provider = getEmbeddingProvider();
  if (provider !== "cloudflare") {
    throw new Error("Set EMBEDDING_PROVIDER=cloudflare to re-embed historical vectors into BGE-M3 space");
  }

  const embedder = getRecoveryEmbedder();
  await embedder.checkAvailability();
  const db = createDatabaseClient({ connectionString: process.env.DATABASE_URL });
  try {
    const stats = await reembedHistoricalEmbeddings(db, embedder);
    console.log(`Embedding reindex complete: episodes=${stats.episodesUpdated}, intents=${stats.intentsUpdated}, provider=${embedder.identity.provider}, model=${embedder.identity.model}`);
  } finally {
    await db.close();
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  void main().catch((error) => {
    // Error details are sanitized by the embedder and do not include API tokens.
    console.error(`[Embedding reindex] ${error instanceof Error ? error.message : "operation failed"}`);
    process.exitCode = 1;
  });
}
