import { AdjudicationCompletion, AdjudicationProvider } from "./types";

const DEFAULT_BASE_URL = "https://api.tokenfactory.nebius.com/v1";
const DEFAULT_MODEL = "nvidia/Nemotron-3_5-Lightning";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 768;
const MIN_OUTPUT_TOKENS = 128;
const MAX_OUTPUT_TOKENS = 2048;

interface NebiusOptions {
  fetchImpl?: typeof fetch;
  apiKey?: () => string | undefined;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
}

export class NebiusChatCompletionsClient implements AdjudicationProvider {
  readonly label: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiKey: () => string | undefined;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxOutputTokens: number;

  constructor(options: NebiusOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiKey = options.apiKey ?? (() => process.env.NEBIUS_API_KEY);
    this.baseUrl = (options.baseUrl ?? process.env.NEBIUS_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = options.model ?? process.env.NEBIUS_MODEL ?? DEFAULT_MODEL;
    const configuredTimeout = options.timeoutMs ?? Number(process.env.NEBIUS_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
    this.timeoutMs = configuredTimeout;
    this.maxOutputTokens = options.maxOutputTokens ?? Number(process.env.NEBIUS_MAX_OUTPUT_TOKENS || DEFAULT_MAX_OUTPUT_TOKENS);
    this.label = `Nebius / ${this.model}`;
  }

  async createResponse(prompt: string): Promise<AdjudicationCompletion> {
    const apiKey = this.apiKey();
    if (!apiKey?.trim()) throw new Error("NEBIUS_API_KEY is required for Nebius conflict adjudication");
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 300_000) {
      throw new Error("NEBIUS_TIMEOUT_MS must be between 100 and 300000 milliseconds");
    }
    if (!Number.isInteger(this.maxOutputTokens) || this.maxOutputTokens < MIN_OUTPUT_TOKENS || this.maxOutputTokens > MAX_OUTPUT_TOKENS) {
      throw new Error(`NEBIUS_MAX_OUTPUT_TOKENS must be an integer between ${MIN_OUTPUT_TOKENS} and ${MAX_OUTPUT_TOKENS}`);
    }
    let endpoint: URL;
    try {
      endpoint = new URL(`${this.baseUrl}/chat/completions`);
      if (endpoint.protocol !== "https:" && endpoint.hostname !== "localhost") throw new Error();
    } catch {
      throw new Error("NEBIUS_BASE_URL must be a valid HTTPS URL");
    }
    if (!this.model.trim()) throw new Error("NEBIUS_MODEL must not be empty");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = Date.now();
    try {
      const response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: this.maxOutputTokens,
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Nebius request failed with HTTP ${response.status}`);
      let body: unknown;
      try { body = await response.json(); } catch { throw new Error("Nebius returned malformed JSON"); }
      if (!body || typeof body !== "object") throw new Error("Nebius returned a malformed response");
      const result = body as { choices?: unknown; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
      if (!Array.isArray(result.choices) || !result.choices[0] || typeof result.choices[0] !== "object") {
        throw new Error("Nebius response is missing choices");
      }
      const choice = result.choices[0] as { message?: unknown; finish_reason?: unknown };
      if (choice.finish_reason === "length") throw new Error("Nebius adjudication response was truncated at the output-token limit");
      const message = choice.message;
      const content = message && typeof message === "object" ? (message as { content?: unknown }).content : undefined;
      if (typeof content !== "string" || !content.trim()) throw new Error("Nebius response contains empty or malformed content");
      const tokenCount = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
      return {
        text: content.trim(),
        inputTokens: tokenCount(result.usage?.prompt_tokens),
        outputTokens: tokenCount(result.usage?.completion_tokens),
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`Nebius request timed out after ${this.timeoutMs}ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

