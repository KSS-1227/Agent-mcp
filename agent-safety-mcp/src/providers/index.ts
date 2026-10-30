import { AdjudicationProvider } from "./types";
import { GrokResponsesClient } from "./grok";
import { NebiusChatCompletionsClient } from "./nebius";
import { NvidiaChatCompletionsClient } from "./nvidia";
import { NemotronChatCompletionsClient } from "./nemotron";

type ProviderName = "grok" | "nebius" | "nvidia" | "nemotron" | "none";

function createProvider(selected: string): AdjudicationProvider | undefined {
  if (selected === "none") return undefined;
  if (selected === "nebius") return new NebiusChatCompletionsClient();
  if (selected === "nvidia") return new NvidiaChatCompletionsClient();
  if (selected === "nemotron") return new NemotronChatCompletionsClient();
  if (selected === "grok") return new GrokResponsesClient();
  throw new Error(`Invalid LLM provider "${selected}". Accepted options: grok, nebius, nvidia, nemotron, none.`);
}

function providerStartupWarning(selected: ProviderName): string | undefined {
  if (selected === "nebius" && !process.env.NEBIUS_API_KEY?.trim()) {
    return "NEBIUS_API_KEY is missing; adjudication will fall back to deterministic-only behavior.";
  }
  if (selected === "nvidia" && !process.env.NVIDIA_API_KEY?.trim()) {
    return "NVIDIA_API_KEY is missing; adjudication will fall back to deterministic-only behavior.";
  }
  if (selected === "nemotron" && !process.env.NEMOTRON_BASE_URL?.trim()) {
    return "NEMOTRON_BASE_URL is missing; no hosted endpoint is configured, so the selected service will fall back to deterministic-only behavior.";
  }
  if (selected === "grok" && !process.env.BEDROCK_API_KEY?.trim()) {
    return "BEDROCK_API_KEY is missing; adjudication will fall back to deterministic-only behavior.";
  }
  return undefined;
}

function readProvider(value: string | undefined, fallback: ProviderName, source: string): ProviderName {
  const selected = value?.trim().toLowerCase() || fallback;
  if (!["grok", "nebius", "nvidia", "nemotron", "none"].includes(selected)) {
    throw new Error(`Invalid ${source} "${selected}". Accepted options: grok, nebius, nvidia, nemotron, none.`);
  }
  return selected as ProviderName;
}

/** Generic provider selection retained for non-conflict services using LLM_PROVIDER. */
export function getAdjudicationProvider(): AdjudicationProvider | undefined {
  return createProvider(readProvider(process.env.LLM_PROVIDER, "grok", "LLM_PROVIDER"));
}

export function getAdjudicationProviderStartupWarning(): string | undefined {
  return providerStartupWarning(readProvider(process.env.LLM_PROVIDER, "grok", "LLM_PROVIDER"));
}

/** Conflict Engine routing is independent of the generic/Grok provider setting. */
export function getConflictAdjudicationProvider(): AdjudicationProvider | undefined {
  return createProvider(readProvider(process.env.CONFLICT_LLM_PROVIDER, "nemotron", "CONFLICT_LLM_PROVIDER"));
}

export function getConflictAdjudicationProviderStartupWarning(): string | undefined {
  return providerStartupWarning(readProvider(process.env.CONFLICT_LLM_PROVIDER, "nemotron", "CONFLICT_LLM_PROVIDER"));
}

export function getConflictAdjudicationProviderLabel(): string {
  return getConflictAdjudicationProvider()?.label ?? "none (deterministic only)";
}

export function getAdjudicationProviderLabel(): string {
  return getAdjudicationProvider()?.label ?? "none (deterministic only)";
}
