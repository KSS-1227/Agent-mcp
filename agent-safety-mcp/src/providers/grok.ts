const GROK_BASE_URL = "https://bedrock-mantle.us-east-1.api.aws/openai/v1";
const GROK_MODEL = "xai.grok-4.3";
const DEFAULT_TIMEOUT_MS = 30_000;

const REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export interface GrokCompletion {
  text: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

interface GrokProviderOptions {
  fetchImpl?: typeof fetch;
  apiKey?: () => string | undefined;
  timeoutMs?: number;
  reasoningEffort?: string;
}

export class GrokResponsesClient implements AdjudicationProvider {
  readonly label = `Grok / ${GROK_MODEL}`;
  private readonly fetchImpl: typeof fetch;
  private readonly apiKey: () => string | undefined;
  private readonly timeoutMs: number;
  private readonly reasoningEffort: string;

  constructor(options: GrokProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiKey = options.apiKey ?? (() => process.env.BEDROCK_API_KEY);
    this.timeoutMs = options.timeoutMs ?? Number(process.env.GROK_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
    this.reasoningEffort =
      options.reasoningEffort ??
      process.env.GROK_REASONING_EFFORT ??
      "none";
  }

  async createResponse(prompt: string): Promise<GrokCompletion> {
    const apiKey = this.apiKey();
    if (!apiKey?.trim()) {
      throw new Error("BEDROCK_API_KEY is required for Grok conflict adjudication");
    }
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("GROK_TIMEOUT_MS must be a positive number");
    }
    if (!REASONING_EFFORTS.has(this.reasoningEffort)) {
      throw new Error("GROK_REASONING_EFFORT has an unsupported value");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = Date.now();

    try {
      const response = await this.fetchImpl(`${GROK_BASE_URL}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: GROK_MODEL,
          input: prompt,
          reasoning: { effort: this.reasoningEffort },
          max_output_tokens: 512,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Grok request failed with HTTP ${response.status}`);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new Error("Grok returned malformed JSON");
      }

      if (!body || typeof body !== "object") {
        throw new Error("Grok returned a malformed response");
      }

      const result = body as {
        status?: unknown;
        output?: unknown;
        usage?: { input_tokens?: unknown; output_tokens?: unknown };
      };
      if (result.status !== "completed") {
        throw new Error(`Grok response did not complete (status: ${String(result.status ?? "missing")})`);
      }
      if (!Array.isArray(result.output)) {
        throw new Error("Grok completed response has malformed output");
      }

      const messages = result.output
        .filter(
          (item): item is { type: "message"; content: unknown[] } =>
            !!item &&
            typeof item === "object" &&
            (item as { type?: unknown }).type === "message" &&
            Array.isArray((item as { content?: unknown }).content)
        );
      const finalMessage = messages[messages.length - 1];
      const text = (finalMessage?.content ?? [])
        .filter(
          (content): content is { type: "output_text"; text: string } =>
            !!content &&
            typeof content === "object" &&
            (content as { type?: unknown }).type === "output_text" &&
            typeof (content as { text?: unknown }).text === "string"
        )
        .map((content) => content.text)
        .join("")
        .trim();

      if (!text) {
        throw new Error("Grok completed response contains no output_text");
      }

      return {
        text,
        inputTokens: this.readTokenCount(result.usage?.input_tokens),
        outputTokens: this.readTokenCount(result.usage?.output_tokens),
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Grok request timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private readTokenCount(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : 0;
  }
}
import { AdjudicationProvider } from "./types";
