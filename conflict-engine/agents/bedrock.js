/**
 * Bedrock client — embeddings, cost-aware model routing, and honest accounting.
 *
 * Three things live here that the rest of the system depends on:
 *
 *   embed(text)          → a 1024-dim vector, the same shape as intent.embedding
 *   complete({tier,...}) → a completion plus its exact token usage
 *   Usage                → the running ledger of tokens, dollars and energy
 *
 * WHY THE ACCOUNTING IS BUILT IN RATHER THAN BOLTED ON.
 * The headline claim of this project is that optimistic concurrency burns 1.83×
 * the tokens of running agents serially, and that repairing only the dependent
 * steps removes most of that overhead. A claim like that is only worth making if
 * every token is counted at the point it is spent, by the code that spends it —
 * not reconstructed afterwards from logs.
 *
 * Verified working in account 957325809861 / us-east-1 on 2026-08-11:
 *   amazon.titan-embed-text-v2:0
 *   us.anthropic.claude-haiku-4-5-20251001-v1:0
 *   us.anthropic.claude-sonnet-4-6
 *   us.anthropic.claude-opus-4-5-20251101-v1:0
 *
 * NOTE: Claude on Bedrock requires the `us.` inference-profile prefix. The bare
 * `anthropic.*` IDs appear in list-foundation-models but return AccessDenied.
 */
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import "../scripts/env.js";

const REGION = process.env.AWS_REGION || "us-east-1";

export const MODELS = {
  embeddings:
    process.env.BEDROCK_MODEL_EMBEDDINGS || "amazon.titan-embed-text-v2:0",
  bulk:
    process.env.BEDROCK_MODEL_BULK ||
    "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  adjudicator:
    process.env.BEDROCK_MODEL_ADJUDICATOR || "us.anthropic.claude-sonnet-4-6",
  escalate:
    process.env.BEDROCK_MODEL_ESCALATE ||
    "us.anthropic.claude-opus-4-5-20251101-v1:0",
};

export const EMBEDDING_DIMENSIONS = 1024;

/**
 * Published Bedrock on-demand pricing, USD per 1M tokens.
 * Used only to attach a dollar figure to token counts we measured ourselves —
 * the tokens are the measurement, the dollars are a presentation layer.
 */
const PRICING = {
  "us.anthropic.claude-haiku-4-5-20251001-v1:0": { in: 1.0, out: 5.0 },
  "us.anthropic.claude-sonnet-4-6": { in: 3.0, out: 15.0 },
  "us.anthropic.claude-sonnet-4-5-20250929-v1:0": { in: 3.0, out: 15.0 },
  "us.anthropic.claude-opus-4-5-20251101-v1:0": { in: 5.0, out: 25.0 },
  "amazon.titan-embed-text-v2:0": { in: 0.02, out: 0 },
};

/**
 * Energy coefficient, watt-hours per 1,000 tokens.
 *
 * ESTIMATE, NOT A MEASUREMENT. Datacentre energy per token is not published
 * per-model by any provider, so this is a single tunable coefficient applied
 * uniformly to every mode in the benchmark. That uniformity is the point: the
 * comparison between modes stays valid even if the absolute figure is off,
 * because every mode is multiplied by the same number.
 *
 * Override with ENERGY_WH_PER_1K_TOKENS. Reported as a range, never as a fact.
 */
const WH_PER_1K_TOKENS = Number(process.env.ENERGY_WH_PER_1K_TOKENS ?? 0.3);

/** Grid carbon intensity, gCO2e per kWh. us-east-1 default; override per region. */
const G_CO2E_PER_KWH = Number(process.env.GRID_G_CO2E_PER_KWH ?? 379);

const client = new BedrockRuntimeClient({ region: REGION });

/* -------------------------------------------------------------------------- */
/* Usage ledger                                                               */
/* -------------------------------------------------------------------------- */

export class Usage {
  constructor(label = "run") {
    this.label = label;
    this.calls = 0;
    this.tokensIn = 0;
    this.tokensOut = 0;
    /** Tokens spent on work that was later discarded. The number that matters. */
    this.tokensWasted = 0;
    this.usd = 0;
    this.byModel = new Map();

    /**
     * Embedding tokens are tracked apart from completion tokens because summing
     * them is misleading: embeddings bill at $0.02/1M and Sonnet at $3/1M, so a
     * raw token total makes a system that embeds a lot look 150x worse than it
     * is. Cost is the comparison that survives scrutiny; token counts are kept
     * for transparency, not for the headline.
     */
    this.embedTokens = 0;
    this.completionTokens = 0;
  }

  record({ model, tokensIn = 0, tokensOut = 0, wasted = 0, kind = "completion" }) {
    if (kind === "embedding") this.embedTokens += tokensIn + tokensOut;
    else this.completionTokens += tokensIn + tokensOut;
    const p = PRICING[model] ?? { in: 0, out: 0 };
    const usd = (tokensIn / 1e6) * p.in + (tokensOut / 1e6) * p.out;

    this.calls++;
    this.tokensIn += tokensIn;
    this.tokensOut += tokensOut;
    this.tokensWasted += wasted;
    this.usd += usd;

    const m = this.byModel.get(model) ?? { calls: 0, tokensIn: 0, tokensOut: 0, usd: 0 };
    m.calls++;
    m.tokensIn += tokensIn;
    m.tokensOut += tokensOut;
    m.usd += usd;
    this.byModel.set(model, m);

    return usd;
  }

  /** Mark tokens as discarded — e.g. an OCC abort throwing away reasoning. */
  waste(tokens) {
    this.tokensWasted += tokens;
  }

  get tokensTotal() {
    return this.tokensIn + this.tokensOut;
  }

  /** Energy and carbon, derived from tokens via the stated coefficient. */
  get energy() {
    const wh = (this.tokensTotal / 1000) * WH_PER_1K_TOKENS;
    const whWasted = (this.tokensWasted / 1000) * WH_PER_1K_TOKENS;
    return {
      wh,
      kwh: wh / 1000,
      gCO2e: (wh / 1000) * G_CO2E_PER_KWH,
      whWasted,
      gCO2eWasted: (whWasted / 1000) * G_CO2E_PER_KWH,
      assumption: `${WH_PER_1K_TOKENS} Wh/1k tokens · ${G_CO2E_PER_KWH} gCO2e/kWh (estimate)`,
    };
  }

  toJSON() {
    return {
      label: this.label,
      calls: this.calls,
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      tokensTotal: this.tokensTotal,
      embedTokens: this.embedTokens,
      completionTokens: this.completionTokens,
      tokensWasted: this.tokensWasted,
      wastedPct: this.tokensTotal
        ? +((this.tokensWasted / this.tokensTotal) * 100).toFixed(1)
        : 0,
      usd: +this.usd.toFixed(6),
      energy: this.energy,
      byModel: Object.fromEntries(this.byModel),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Embeddings                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Embed text into the 1024-dim space that intent.embedding uses.
 * Returns { vector, literal } — `literal` is the CockroachDB VECTOR literal,
 * ready to interpolate into SQL.
 */
export async function embed(text, usage) {
  const model = MODELS.embeddings;
  const res = await client.send(
    new InvokeModelCommand({
      modelId: model,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        inputText: text,
        dimensions: EMBEDDING_DIMENSIONS,
        normalize: true,
      }),
    }),
  );

  const parsed = JSON.parse(new TextDecoder().decode(res.body));
  const vector = parsed.embedding;

  if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `expected ${EMBEDDING_DIMENSIONS} dims, got ${vector?.length}`,
    );
  }

  usage?.record({
    model,
    tokensIn: parsed.inputTextTokenCount ?? 0,
    kind: "embedding",
  });

  return { vector, literal: `[${vector.join(",")}]` };
}

/* -------------------------------------------------------------------------- */
/* Completions                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Invoke a Claude model on Bedrock.
 *
 * `tier` selects the model rather than the caller hard-coding an ID, so the
 * whole fleet can be re-pointed at a different model with one env var — and so
 * cost-aware routing is a property of the system rather than a habit.
 */
export async function complete({
  tier = "bulk",
  system,
  prompt,
  maxTokens = 1024,
  temperature = 0,
  usage,
  json = false,
}) {
  const model = MODELS[tier] ?? tier;
  const started = Date.now();

  const body = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: maxTokens,
    temperature,
    messages: [{ role: "user", content: prompt }],
  };
  if (system) body.system = system;

  const res = await client.send(
    new InvokeModelCommand({
      modelId: model,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(body),
    }),
  );

  const parsed = JSON.parse(new TextDecoder().decode(res.body));
  const text = parsed.content?.[0]?.text ?? "";
  const tokensIn = parsed.usage?.input_tokens ?? 0;
  const tokensOut = parsed.usage?.output_tokens ?? 0;

  usage?.record({ model, tokensIn, tokensOut });

  let data = null;
  if (json) {
    // Models sometimes wrap JSON in prose or a fence; take the outermost object.
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        data = JSON.parse(match[0]);
      } catch {
        data = null;
      }
    }
  }

  return {
    text,
    data,
    model,
    tokensIn,
    tokensOut,
    latencyMs: Date.now() - started,
  };
}

/** Quick liveness probe for all four configured models. */
export async function probe() {
  const results = {};
  for (const [tier, model] of Object.entries(MODELS)) {
    try {
      if (tier === "embeddings") {
        const { vector } = await embed("probe");
        results[tier] = { model, ok: true, detail: `${vector.length} dims` };
      } else {
        const r = await complete({
          tier,
          prompt: "Reply with the single word: ready",
          maxTokens: 8,
        });
        results[tier] = {
          model,
          ok: true,
          detail: `${r.text.trim()} (${r.latencyMs}ms)`,
        };
      }
    } catch (e) {
      results[tier] = { model, ok: false, detail: e.message.split("\n")[0] };
    }
  }
  return results;
}
