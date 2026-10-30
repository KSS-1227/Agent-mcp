import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflareEmbedder, CLOUDFLARE_EMBEDDING_MODEL } from "../../src/recovery-engine/cloudflare-embedder";
import { getEmbeddingProvider, getRecoveryEmbedder } from "../../src/recovery-engine/embedder";
import { TitanEmbedder } from "../../src/recovery-engine/titan-embedder";

const vector = Array.from({ length: 1024 }, (_, index) => index / 1024);
const success = (embedding: number[][] = [vector]) => new Response(JSON.stringify({
  success: true,
  result: { data: embedding, shape: [embedding.length, embedding[0]?.length ?? 0], pooling: "cls" },
}), { status: 200 });

function client(fetchImpl: typeof fetch, options: { timeoutMs?: number; model?: string } = {}) {
  return new CloudflareEmbedder({
    accountId: "account-id-test",
    apiToken: "token-test",
    fetchImpl,
    ...options,
  });
}

afterEach(() => vi.unstubAllEnvs());

describe("Cloudflare BGE-M3 recovery embedder", () => {
  it("sends the configured model request and parses the nested vector", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account-id-test");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "token-test");
    vi.stubEnv("CLOUDFLARE_EMBEDDING_MODEL", CLOUDFLARE_EMBEDDING_MODEL);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(success());
    const embedder = new CloudflareEmbedder({ fetchImpl });

    await expect(embedder.embed("episode text")).resolves.toEqual(vector);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(`https://api.cloudflare.com/client/v4/accounts/account-id-test/ai/run/${CLOUDFLARE_EMBEDDING_MODEL}`);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer token-test", "Content-Type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({ text: ["episode text"] });
  });

  it("rejects missing configuration before making a request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const embedder = new CloudflareEmbedder({ fetchImpl });
    await expect(embedder.embed("episode text")).rejects.toThrow("CLOUDFLARE_ACCOUNT_ID is required");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([401, 403])("rejects authentication/HTTP errors (%i)", async (status) => {
    const embedder = client(vi.fn<typeof fetch>().mockResolvedValue(new Response("unauthorized", { status })));
    await expect(embedder.embed("episode text")).rejects.toThrow(`HTTP ${status}`);
  });

  it("rejects Cloudflare API-level failures", async () => {
    const embedder = client(vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ success: false, errors: [{ code: 1000 }] }), { status: 200 })));
    await expect(embedder.embed("episode text")).rejects.toThrow("API reported failure");
  });

  it("rejects request timeouts", async () => {
    const fetchImpl: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
    const embedder = client(fetchImpl, { timeoutMs: 100 });
    await expect(embedder.embed("episode text")).rejects.toThrow("timed out after 100ms");
  });

  it.each([
    ["empty body", new Response(null, { status: 200 })],
    ["malformed JSON", new Response("not-json", { status: 200 })],
    ["missing nested data", new Response(JSON.stringify({ success: true, result: { shape: [1, 1024] } }), { status: 200 })],
    ["multiple embeddings", new Response(JSON.stringify({ success: true, result: { data: [vector, vector], shape: [1, 1024] } }), { status: 200 })],
    ["wrong shape", new Response(JSON.stringify({ success: true, result: { data: [vector], shape: [1, 768] } }), { status: 200 })],
    ["wrong vector dimensions", new Response(JSON.stringify({ success: true, result: { data: [[1, 2, 3]], shape: [1, 1024] } }), { status: 200 })],
    ["non-finite vector values", new Response(JSON.stringify({ success: true, result: { data: [[...vector.slice(0, -1), null]], shape: [1, 1024] } }), { status: 200 })],
  ])("rejects %s", async (_name, response) => {
    const embedder = client(vi.fn<typeof fetch>().mockResolvedValue(response as Response));
    await expect(embedder.embed("episode text")).rejects.toThrow();
  });

  it("selects one configured provider without silently falling back", async () => {
    expect(getEmbeddingProvider({ EMBEDDING_PROVIDER: "cloudflare" })).toBe("cloudflare");
    expect(getEmbeddingProvider({ EMBEDDING_PROVIDER: "titan" })).toBe("titan");
    expect(getEmbeddingProvider({})).toBe("titan");
    vi.stubEnv("EMBEDDING_PROVIDER", "cloudflare");
    expect(getRecoveryEmbedder()).toBeInstanceOf(CloudflareEmbedder);
    vi.stubEnv("EMBEDDING_PROVIDER", "titan");
    expect(getRecoveryEmbedder()).toBeInstanceOf(TitanEmbedder);
    const failing = client(vi.fn<typeof fetch>().mockResolvedValue(new Response("denied", { status: 401 })));
    await expect(failing.embed("episode text")).rejects.toThrow("HTTP 401");
  });
});
