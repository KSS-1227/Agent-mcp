import { AdjudicationCompletion, AdjudicationProvider } from "./types";

const DEFAULT_MODEL = "nvidia/NVIDIA-Nemotron-3.5-Bolt-E4B-4GB";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 768;
const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

interface NemotronOptions {
  fetchImpl?: typeof fetch;
  token?: () => string | undefined;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  retryDelayMs?: (attempt: number) => number;
}

export class NemotronChatCompletionsClient implements AdjudicationProvider {
  readonly label: string;
  private readonly fetchImpl: typeof fetch;
  private readonly token: () => string | undefined;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxOutputTokens: number;
  private readonly temperature: number;
  private readonly systemPrompt?: string;
  private readonly retryDelayMs: (attempt: number) => number;

  constructor(options: NemotronOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.token = options.token ?? (() => process.env.HF_TOKEN);
    this.baseUrl = (options.baseUrl ?? process.env.NEMOTRON_BASE_URL ?? "").trim().replace(/\/+$/, "");
    this.model = options.model ?? process.env.NEMOTRON_MODEL ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.NEMOTRON_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
    this.maxOutputTokens = options.maxOutputTokens ?? Number(process.env.NEMOTRON_MAX_OUTPUT_TOKENS || DEFAULT_MAX_OUTPUT_TOKENS);
    this.temperature = options.temperature ?? Number(process.env.NEMOTRON_TEMPERATURE || 0);
    this.systemPrompt = options.systemPrompt ?? process.env.NEMOTRON_SYSTEM_PROMPT;
    this.retryDelayMs = options.retryDelayMs ?? ((attempt) => Math.min(250 * 2 ** (attempt - 1), 2_000));
    this.label = `Nemotron / ${this.model}`;
  }

  async createResponse(prompt: string): Promise<AdjudicationCompletion> {
    const token = this.token()?.trim();
    if (!this.baseUrl) throw new Error("NEMOTRON_BASE_URL must point to a deployed OpenAI-compatible endpoint");
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 300_000) {
      throw new Error("NEMOTRON_TIMEOUT_MS must be between 100 and 300000 milliseconds");
    }
    if (!Number.isInteger(this.maxOutputTokens) || this.maxOutputTokens < 1 || this.maxOutputTokens > 8192) {
      throw new Error("NEMOTRON_MAX_OUTPUT_TOKENS must be an integer between 1 and 8192");
    }
    if (!Number.isFinite(this.temperature) || this.temperature < 0 || this.temperature > 2) {
      throw new Error("NEMOTRON_TEMPERATURE must be between 0 and 2");
    }
    let endpoint: URL;
    try {
      const base = new URL(this.baseUrl);
      if (base.username || base.password || base.search || base.hash) throw new Error();
      endpoint = new URL(`${base.toString().replace(/\/+$/, "")}/chat/completions`);
      if (endpoint.protocol !== "https:" && endpoint.hostname !== "localhost" && endpoint.hostname !== "127.0.0.1") throw new Error();
    } catch {
      throw new Error("NEMOTRON_BASE_URL must be a valid HTTPS URL (HTTP is allowed only for localhost)");
    }
    if (!this.model.trim()) throw new Error("NEMOTRON_MODEL must not be empty");
    if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Nemotron prompt must be non-empty text");

    const messages = [
      ...(this.systemPrompt?.trim() ? [{ role: "system", content: this.systemPrompt.trim() }] : []),
      { role: "user", content: prompt },
    ];
    const startedAt = Date.now();
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(endpoint, {
          method: "POST",
          headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
          body: JSON.stringify({ model: this.model, messages, temperature: this.temperature, max_tokens: this.maxOutputTokens }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const error = new Error(`Nemotron request failed with HTTP ${response.status}`);
          if (!RETRYABLE_STATUS.has(response.status) || attempt === MAX_ATTEMPTS) throw error;
          lastError = error;
        } else {
          let body: unknown;
          try { body = await response.json(); } catch { throw new Error("Nemotron returned malformed JSON"); }
          if (!body || typeof body !== "object") throw new Error("Nemotron returned a malformed response");
          const result = body as { choices?: unknown; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
          if (!Array.isArray(result.choices) || !result.choices[0] || typeof result.choices[0] !== "object") {
            throw new Error("Nemotron response is missing choices");
          }
          const choice = result.choices[0] as { message?: unknown; finish_reason?: unknown };
          if (choice.finish_reason === "length") throw new Error("Nemotron response was truncated at the output-token limit");
          const message = choice.message;
          const content = message && typeof message === "object" ? (message as { content?: unknown }).content : undefined;
          if (typeof content !== "string" || !content.trim()) throw new Error("Nemotron response contains empty or malformed content");
          const tokenCount = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
          return { text: content.trim(), inputTokens: tokenCount(result.usage?.prompt_tokens), outputTokens: tokenCount(result.usage?.completion_tokens), latencyMs: Date.now() - startedAt };
        }
      } catch (error) {
        if (controller.signal.aborted) lastError = new Error(`Nemotron request timed out after ${this.timeoutMs}ms`);
        else if (error instanceof TypeError) lastError = new Error("Nemotron endpoint is unavailable");
        else throw error;
        if (attempt === MAX_ATTEMPTS) throw lastError;
      } finally {
        clearTimeout(timer);
      }
      await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs(attempt)));
    }
    throw lastError instanceof Error ? lastError : new Error("Nemotron request failed");
  }
}
