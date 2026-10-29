export interface AdjudicationCompletion {
  text: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface AdjudicationProvider {
  readonly label: string;
  createResponse(prompt: string): Promise<AdjudicationCompletion>;
}
