/**
 * Vector Search Support - pgvector operations for semantic conflict detection
 *
 * Task 15: Implements semantic similarity search using pgvector
 * - Find conflicting intents by embedding similarity
 * - Uses cosine distance for ranking
 * - Part of the 5-step conflict pipeline (after EXACT and PROVENANCE)
 */

import { DatabaseClient } from "../database/client";

/**
 * Find similar intents using pgvector cosine distance
 * 
 * @param embedding - Query embedding vector (1536 dimensions for Titan)
 * @param db - DatabaseClient instance
 * @param threshold - Cosine distance threshold (lower = more similar)
 * @param limit - Maximum number of results
 * @returns Array of intent IDs sorted by similarity (most similar first)
 */
export async function findSimilarIntents(
  embedding: number[],
  db: DatabaseClient,
  threshold: number = 0.3,
  limit: number = 10
): Promise<Array<{ intentId: string; similarity: number }>> {
  if (!embedding || embedding.length === 0) {
    return [];
  }

  // Vector should be represented as a string for PostgreSQL pgvector
  const embeddingStr = `[${embedding.join(",")}]`;

  const query = `
    SELECT 
      id as intent_id,
      1 - (embedding <=> $1::vector) as similarity
    FROM intents
    WHERE embedding IS NOT NULL
      AND status IN ('DECLARED', 'ACTIVE')
      AND (embedding <=> $1::vector) <= $2
    ORDER BY embedding <=> $1::vector ASC
    LIMIT $3
  `;

  try {
    const result = await db.query<{
      intent_id: string;
      similarity: number;
    }>(query, [embeddingStr, threshold, limit]);

    return result.rows.map((row) => ({
      intentId: row.intent_id,
      similarity: row.similarity,
    }));
  } catch (error) {
    // If pgvector is not available or query fails, return empty
    console.warn("Vector search not available:", error);
    return [];
  }
}

/**
 * Store embedding for an intent
 * 
 * @param intentId - Intent UUID
 * @param embedding - Embedding vector (1536 dimensions for Titan)
 * @param db - DatabaseClient instance
 */
export async function storeIntentEmbedding(
  intentId: string,
  embedding: number[],
  db: DatabaseClient
): Promise<void> {
  if (!embedding || embedding.length === 0) {
    return;
  }

  const embeddingStr = `[${embedding.join(",")}]`;

  const query = `
    UPDATE intents
    SET embedding = $1::vector
    WHERE id = $2
  `;

  try {
    await db.query(query, [embeddingStr, intentId]);
  } catch (error) {
    console.warn("Failed to store embedding:", error);
  }
}

/**
 * Compute cosine distance between two vectors
 * (For in-memory calculation when database vector ops unavailable)
 * 
 * @param vecA - First vector
 * @param vecB - Second vector
 * @returns Cosine distance (0-2, lower = more similar)
 */
export function cosineDistance(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length || vecA.length === 0) {
    return 2; // Maximum distance (dissimilar)
  }

  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    magnitudeA += vecA[i] * vecA[i];
    magnitudeB += vecB[i] * vecB[i];
  }

  magnitudeA = Math.sqrt(magnitudeA);
  magnitudeB = Math.sqrt(magnitudeB);

  if (magnitudeA === 0 || magnitudeB === 0) {
    return 2;
  }

  const cosineSimilarity = dotProduct / (magnitudeA * magnitudeB);
  return 1 - cosineSimilarity; // Convert to distance (0-2)
}


