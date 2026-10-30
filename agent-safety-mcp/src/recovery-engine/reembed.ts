import type { DatabaseClient, Transaction } from "../database/client";
import type { RecoveryEmbedder } from "./embedder";
import { assertActiveEmbeddingIdentity } from "./embedding-identity";
import { EPISODE_EMBEDDING_DIMENSIONS } from "./reconciliation";

type EmbeddingTable = "episodes" | "intents";

interface StoredEmbeddingRow {
  id: string;
  source_text: string;
  embedding_text: string;
  embedding_provider: string | null;
  embedding_model: string | null;
}

export interface ReembeddingStats {
  episodesUpdated: number;
  intentsUpdated: number;
}

function selectSql(table: EmbeddingTable): string {
  const [idColumn, textColumn] = table === "episodes"
    ? ["episode_id", "narrative"]
    : ["id", "intent_statement"];
  return `SELECT ${idColumn} AS id, ${textColumn} AS source_text,
                 embedding::text AS embedding_text, embedding_provider, embedding_model
            FROM ${table}
           WHERE embedding IS NOT NULL
             AND (embedding_provider IS DISTINCT FROM $1 OR embedding_model IS DISTINCT FROM $2)
           ORDER BY ${idColumn}
           LIMIT $3`;
}

function updateSql(table: EmbeddingTable): string {
  const [idColumn, textColumn] = table === "episodes"
    ? ["episode_id", "narrative"]
    : ["id", "intent_statement"];
  return `UPDATE ${table}
             SET embedding = $1::vector, embedding_provider = $2, embedding_model = $3, updated_at = now()
           WHERE ${idColumn} = $4 AND ${textColumn} = $5
             AND embedding::text IS NOT DISTINCT FROM $6
             AND embedding_provider IS NOT DISTINCT FROM $7
             AND embedding_model IS NOT DISTINCT FROM $8`;
}

async function reembedTable(
  db: DatabaseClient,
  embedder: RecoveryEmbedder,
  table: EmbeddingTable,
  batchSize: number
): Promise<number> {
  let updatedCount = 0;
  const select = selectSql(table);
  const update = updateSql(table);

  for (;;) {
    const selected = await db.query<StoredEmbeddingRow>(select, [embedder.identity.provider, embedder.identity.model, batchSize]);
    if (selected.rows.length === 0) return updatedCount;

    let changedInBatch = 0;
    for (const row of selected.rows) {
      const vector = await embedder.embed(row.source_text);
      if (!Array.isArray(vector) || vector.length !== EPISODE_EMBEDDING_DIMENSIONS ||
          !vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
        throw new Error(`Re-embedder must return exactly ${EPISODE_EMBEDDING_DIMENSIONS} finite values`);
      }

      const result = await db.transaction((tx: Transaction) => tx.query(update, [
        JSON.stringify(vector),
        embedder.identity.provider,
        embedder.identity.model,
        row.id,
        row.source_text,
        row.embedding_text,
        row.embedding_provider,
        row.embedding_model,
      ]));
      if ((result.rowCount ?? 0) === 1) {
        changedInBatch++;
        updatedCount++;
      }
    }

    // A concurrent writer changed every selected row. Stop instead of spinning;
    // rerunning safely resumes from whichever rows still need this model.
    if (changedInBatch === 0) {
      throw new Error(`Stored ${table} embeddings changed during re-embedding; rerun the command to resume`);
    }
  }
}

/**
 * Re-embed preserved text into one provider/model space. Each vector and its
 * provenance update atomically with a compare-and-set against the old row.
 * Re-running after a crash skips rows already converted.
 */
export async function reembedHistoricalEmbeddings(
  db: DatabaseClient,
  embedder: RecoveryEmbedder,
  batchSize = 25
): Promise<ReembeddingStats> {
  assertActiveEmbeddingIdentity(embedder.identity);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new Error("Re-embedding batch size must be an integer between 1 and 500");
  }

  const episodesUpdated = await reembedTable(db, embedder, "episodes", batchSize);
  const intentsUpdated = await reembedTable(db, embedder, "intents", batchSize);
  return { episodesUpdated, intentsUpdated };
}
