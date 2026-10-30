import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { findSimilarIntents, storeIntentEmbedding } from "../../src/conflict-engine/vector";
import type { DatabaseClient } from "../../src/database/client";
import type { RecoveryEmbedder } from "../../src/recovery-engine/embedder";
import { reembedHistoricalEmbeddings } from "../../src/recovery-engine/reembed";

const vector = Array.from({ length: 1024 }, (_, index) => index / 1024);

describe("embedding provenance isolation", () => {
  it("filters cosine search by the exact provider and model", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ intent_id: "intent-a", similarity: 0.91 }] });
    const db = { query } as unknown as DatabaseClient;
    const found = await findSimilarIntents(vector, db, { provider: "cloudflare-workers-ai", model: "@cf/baai/bge-m3" });

    expect(found).toEqual([{ intentId: "intent-a", similarity: 0.91 }]);
    expect(query.mock.calls[0][0]).toContain("embedding_provider = $2");
    expect(query.mock.calls[0][0]).toContain("embedding_model = $3");
    expect(query.mock.calls[0][1]).toEqual([JSON.stringify(vector), "cloudflare-workers-ai", "@cf/baai/bge-m3", 0.3, 10]);
  });

  it("stores intent vectors together with validated provider/model provenance", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    await storeIntentEmbedding("intent-a", vector, { query } as unknown as DatabaseClient, {
      provider: "aws-bedrock",
      model: "amazon.titan-embed-text-v2:0",
    });
    expect(query.mock.calls[0][0]).toContain("embedding_provider = $3, embedding_model = $4");
    expect(query.mock.calls[0][1].slice(1)).toEqual(["intent-a", "aws-bedrock", "amazon.titan-embed-text-v2:0"]);
  });

  it("re-embeds legacy records idempotently without changing narratives or evidence", async () => {
    const tables: Record<string, Array<any>> = {
      episodes: [{ id: "episode-a", source_text: "original recovery narrative", embedding_text: "[0.1]", embedding_provider: "legacy", embedding_model: "unverified", outcome: "recovered", evidence: { issue: 17 } }],
      intents: [{ id: "intent-a", source_text: "original intent statement", embedding_text: "[0.2]", embedding_provider: "legacy", embedding_model: "unverified", status: "ACTIVE", metadata: { owner: "agent-a" } }],
    };
    const query = vi.fn(async (sql: string, values: any[] = []) => {
      const table = sql.match(/FROM (episodes|intents)/)?.[1] ?? sql.match(/UPDATE (episodes|intents)/)?.[1];
      if (sql.startsWith("SELECT")) {
        return { rows: tables[table!].filter((row) => row.embedding_provider !== values[0] || row.embedding_model !== values[1]).slice(0, values[2]) };
      }
      const [embedding, provider, model, id, text, oldEmbedding, oldProvider, oldModel] = values;
      const row = tables[table!].find((candidate) => candidate.id === id);
      if (!row || row.source_text !== text || row.embedding_text !== oldEmbedding || row.embedding_provider !== oldProvider || row.embedding_model !== oldModel) return { rowCount: 0 };
      row.embedding_text = embedding;
      row.embedding_provider = provider;
      row.embedding_model = model;
      return { rowCount: 1 };
    });
    const db = {
      query,
      transaction: async (work: (tx: { query: typeof query }) => Promise<unknown>) => work({ query }),
    } as unknown as DatabaseClient;
    const embedder = {
      identity: { provider: "cloudflare-workers-ai", model: "@cf/baai/bge-m3" },
      embed: vi.fn(async () => vector),
    } as RecoveryEmbedder;

    await expect(reembedHistoricalEmbeddings(db, embedder, 10)).resolves.toEqual({ episodesUpdated: 1, intentsUpdated: 1 });
    expect(tables.episodes[0]).toMatchObject({ source_text: "original recovery narrative", outcome: "recovered", evidence: { issue: 17 }, embedding_provider: "cloudflare-workers-ai", embedding_model: "@cf/baai/bge-m3" });
    expect(tables.intents[0]).toMatchObject({ source_text: "original intent statement", status: "ACTIVE", metadata: { owner: "agent-a" }, embedding_provider: "cloudflare-workers-ai", embedding_model: "@cf/baai/bge-m3" });

    await expect(reembedHistoricalEmbeddings(db, embedder, 10)).resolves.toEqual({ episodesUpdated: 0, intentsUpdated: 0 });
    expect(embedder.embed).toHaveBeenCalledTimes(2);
  });

  it("does not update a historical row if re-embedding fails", async () => {
    const transaction = vi.fn();
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: "episode-a", source_text: "preserved", embedding_text: "[0.1]", embedding_provider: "legacy", embedding_model: "unverified" }] }),
      transaction,
    } as unknown as DatabaseClient;
    const embedder = {
      identity: { provider: "cloudflare-workers-ai", model: "@cf/baai/bge-m3" },
      embed: vi.fn().mockRejectedValue(new Error("provider unavailable")),
    } as unknown as RecoveryEmbedder;

    await expect(reembedHistoricalEmbeddings(db, embedder)).rejects.toThrow("provider unavailable");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("marks historical vectors unverified without changing vector dimensions", async () => {
    const migration = await readFile(new URL("../../supabase/migrations/20240101000018_embedding_provenance.sql", import.meta.url), "utf8");
    expect(migration).toContain("UPDATE episodes");
    expect(migration).toContain("UPDATE intents");
    expect(migration).toContain("embedding_provider = 'legacy', embedding_model = 'unverified'");
    expect(migration).toContain("episodes_embedding_provenance_pair");
    expect(migration).toContain("intents_embedding_provenance_pair");
    expect(migration).not.toMatch(/ALTER\s+COLUMN\s+embedding\s+TYPE/i);
  });
});
