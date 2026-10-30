import { afterEach, describe, expect, it, vi } from "vitest";
import { NemotronChatCompletionsClient } from "../../src/providers/nemotron";
import { getAdjudicationProvider, getConflictAdjudicationProvider } from "../../src/providers";
import { GrokResponsesClient } from "../../src/providers/grok";

const successful = () => new Response(JSON.stringify({
  choices: [{ message: { content: '{"verdict":"invalidating","rationale":"The deterministic conflict remains."}' }, finish_reason: "stop" }],
  usage: { prompt_tokens: 17, completion_tokens: 9 },
}), { status: 200 });

describe("Nemotron OpenAI-compatible provider", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends the selected model, structured messages, auth and generation controls", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(successful());
    const client = new NemotronChatCompletionsClient({
      fetchImpl, token: () => "test-token", baseUrl: "https://endpoint.example/v1/",
      systemPrompt: "Return JSON only.", temperature: 0.2, maxOutputTokens: 256,
    });
    const result = await client.createResponse("Review this conflict.");
    const [url, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(String(url)).toBe("https://endpoint.example/v1/chat/completions");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer test-token" });
    expect(body).toMatchObject({
      model: "nvidia/NVIDIA-Nemotron-3.5-Bolt-E4B-4GB", temperature: 0.2, max_tokens: 256,
      messages: [{ role: "system", content: "Return JSON only." }, { role: "user", content: "Review this conflict." }],
    });
    expect(result).toMatchObject({ text: '{"verdict":"invalidating","rationale":"The deterministic conflict remains."}', inputTokens: 17, outputTokens: 9 });
  });

  it("selects Nemotron via CONFLICT_LLM_PROVIDER", () => {
    const previous = process.env.LLM_PROVIDER;
    const conflictPrevious = process.env.CONFLICT_LLM_PROVIDER;
    process.env.CONFLICT_LLM_PROVIDER = "nemotron";
    try { expect(getConflictAdjudicationProvider()?.label).toContain("nvidia/NVIDIA-Nemotron-3.5-Bolt-E4B-4GB"); }
    finally {
      if (previous === undefined) delete process.env.LLM_PROVIDER; else process.env.LLM_PROVIDER = previous;
      if (conflictPrevious === undefined) delete process.env.CONFLICT_LLM_PROVIDER; else process.env.CONFLICT_LLM_PROVIDER = conflictPrevious;
    }
  });

  it("routes conflict adjudication independently from the generic Grok provider", () => {
    vi.stubEnv("LLM_PROVIDER", "grok");
    vi.stubEnv("CONFLICT_LLM_PROVIDER", "nemotron");
    expect(getAdjudicationProvider()).toBeInstanceOf(GrokResponsesClient);
    expect(getAdjudicationProvider()?.label).toBe("Grok / xai.grok-4.3");
    expect(getConflictAdjudicationProvider()).toBeInstanceOf(NemotronChatCompletionsClient);

    vi.stubEnv("CONFLICT_LLM_PROVIDER", "grok");
    expect(getConflictAdjudicationProvider()).toBeInstanceOf(GrokResponsesClient);
  });

  it("keeps Grok requests on the existing Bedrock Mantle endpoint and model", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }],
    }), { status: 200 }));
    const client = new GrokResponsesClient({ apiKey: () => "bedrock-test-token", fetchImpl });
    await client.createResponse("review");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://bedrock-mantle.us-east-1.api.aws/openai/v1/responses");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer bedrock-test-token" });
    expect(JSON.parse(String(init?.body)).model).toBe("xai.grok-4.3");
  });

  it("supports local endpoints without authentication", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(successful());
    const client = new NemotronChatCompletionsClient({ fetchImpl, token: () => undefined, baseUrl: "http://127.0.0.1:8080/v1" });
    await client.createResponse("prompt");
    expect(fetchImpl.mock.calls[0][1]?.headers).not.toHaveProperty("Authorization");
  });

  it("does not retry authentication failures", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("unauthorized", { status: 401 }));
    const client = new NemotronChatCompletionsClient({ fetchImpl, token: () => "bad-token", baseUrl: "https://endpoint.example/v1", retryDelayMs: () => 0 });
    await expect(client.createResponse("prompt")).rejects.toThrow("HTTP 401");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries rate limits a bounded number of times", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 429 }))
      .mockResolvedValueOnce(new Response("busy", { status: 429 }))
      .mockResolvedValueOnce(successful());
    const client = new NemotronChatCompletionsClient({ fetchImpl, token: () => "test-token", baseUrl: "https://endpoint.example/v1", retryDelayMs: () => 0 });
    await expect(client.createResponse("prompt")).resolves.toMatchObject({ inputTokens: 17 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("surfaces unavailable endpoints after bounded retries", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("network error"));
    const client = new NemotronChatCompletionsClient({ fetchImpl, token: () => "test-token", baseUrl: "https://endpoint.example/v1", retryDelayMs: () => 0 });
    await expect(client.createResponse("prompt")).rejects.toThrow("unavailable");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("reports request timeouts and rejects malformed model output", async () => {
    const timeoutFetch = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const timeoutClient = new NemotronChatCompletionsClient({ fetchImpl: timeoutFetch, token: () => "test-token", baseUrl: "https://endpoint.example/v1", timeoutMs: 100, retryDelayMs: () => 0 });
    await expect(timeoutClient.createResponse("prompt")).rejects.toThrow("timed out after 100ms");
    expect(timeoutFetch).toHaveBeenCalledTimes(3);

    const malformed = new NemotronChatCompletionsClient({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 })),
      token: () => "test-token", baseUrl: "https://endpoint.example/v1",
    });
    await expect(malformed.createResponse("prompt")).rejects.toThrow("empty or malformed content");
  });
});
