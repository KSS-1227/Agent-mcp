import { AdjudicationProvider } from "./types";
import { GrokResponsesClient } from "./grok";
import { NebiusChatCompletionsClient } from "./nebius";
import { NvidiaChatCompletionsClient } from "./nvidia";
import { NemotronChatCompletionsClient } from "./nemotron";

export function getAdjudicationProvider(): AdjudicationProvider | undefined {
  const selected = process.env.LLM_PROVIDER?.trim().toLowerCase() || "nemotron";
  if (selected === "none") return undefined;
  if (selected === "nebius") return new NebiusChatCompletionsClient();
  if (selected === "nvidia") return new NvidiaChatCompletionsClient();
  if (selected === "nemotron") return new NemotronChatCompletionsClient();
  if (selected === "grok") return new GrokResponsesClient();
  throw new Error(`Invalid LLM_PROVIDER "${selected}". Accepted options: grok, nebius, nvidia, nemotron, none.`);
}

export function getAdjudicationProviderStartupWarning(): string | undefined {
  const rawSelection = process.env.LLM_PROVIDER;
  const selected = rawSelection?.trim().toLowerCase() || "nemotron";
  if (selected === "nebius" && !process.env.NEBIUS_API_KEY?.trim()) {
    return "NEBIUS_API_KEY is missing; adjudication will fall back to deterministic-only behavior.";
  }
  if (selected === "nvidia" && !process.env.NVIDIA_API_KEY?.trim()) {
    return "NVIDIA_API_KEY is missing; adjudication will fall back to deterministic-only behavior.";
  }
  if (selected === "nemotron" && !process.env.NEMOTRON_BASE_URL?.trim()) {
    return "NEMOTRON_BASE_URL is missing; no hosted endpoint is configured, so conflict adjudication will fall back to deterministic-only behavior.";
  }
  if (selected === "grok" && !process.env.BEDROCK_API_KEY?.trim()) {
    return "BEDROCK_API_KEY is missing; adjudication will fall back to deterministic-only behavior.";
  }
  return undefined;
}

export function getAdjudicationProviderLabel(): string {
  return getAdjudicationProvider()?.label ?? "none (deterministic only)";
}
