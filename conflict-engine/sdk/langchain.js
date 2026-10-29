/**
 * LangChain integration.
 *
 * A LangChain agent already knows what it is about to do — the chain name, the
 * inputs, the tool calls. That is exactly the information INTERLOCK needs, and
 * LangChain already hands it to callbacks. So concurrency safety can be a
 * callback rather than a rewrite:
 *
 *   const guard = new InterlockCallback({ apiKey, agentId, resources });
 *   await executor.invoke(input, { callbacks: [guard] });
 *
 *   if (guard.wasInvalidated) {
 *     // guard.stepsToRedo names exactly which steps to run again
 *   }
 *
 * WHY A CALLBACK AND NOT A MEMORY CLASS
 * LangChain's memory abstractions are about what an agent remembers. This is
 * about what an agent is *about to do*, and whether the world moved underneath
 * it while it was thinking. That is a lifecycle concern, and the callback
 * surface is where lifecycle lives.
 *
 * WHAT IT DOES NOT DO
 * It does not touch your prompts, your model, or your tools. It declares an
 * intent when the chain starts and reports a ruling when a conflicting commit
 * lands. Your agent keeps its own reasoning; INTERLOCK arbitrates only the
 * shared state.
 */
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { Interlock } from "./client.js";

export class InterlockCallback extends BaseCallbackHandler {
  name = "interlock";

  /**
   * @param {object}   opts
   * @param {string}   opts.apiKey     an INTERLOCK key; get one at POST /v1/keys
   * @param {string}   opts.agentId    this agent's id within your tenant
   * @param {Array}    opts.resources  [{ resourceId, version }] this run depends on
   * @param {string}  [opts.statement] plain-language plan; derived from inputs if omitted
   * @param {boolean} [opts.throwOnFatal] abort the run when a ruling is fatal
   */
  constructor({
    apiKey,
    agentId,
    resources = [],
    statement,
    baseUrl,
    throwOnFatal = false,
    adjudicator,
  } = {}) {
    super();
    this.client = new Interlock({ apiKey, baseUrl });
    this.agentId = agentId;
    this.resources = resources;
    this.statement = statement;
    this.throwOnFatal = throwOnFatal;
    /** Which model tier rules on conflicts. See Interlock#commit. */
    this.adjudicator = adjudicator;

    /** Populated once a ruling arrives. */
    this.intentId = null;
    this.verdict = null;
    this.rationale = null;
    this.stepsToRedo = [];
    /** Steps recorded as the run progresses, so a repair can name them. */
    this.steps = [];
    /** Serialises step appends; see #enqueue. */
    this.pending = Promise.resolve();
  }

  get wasInvalidated() {
    return this.verdict === "invalidating" || this.verdict === "fatal";
  }

  /**
   * Declare the intent as the outermost chain begins.
   *
   * Only the outermost: LangChain fires this for every nested chain, and one
   * task should produce one intent, not one per layer of composition.
   */
  async handleChainStart(chain, inputs, runId, parentRunId) {
    if (parentRunId || this.intentId) return;

    const statement =
      this.statement ??
      `Run ${chain?.id?.slice(-1)[0] ?? "chain"} over: ${summarise(inputs)}`;

    try {
      const res = await this.client.declare({
        agentId: this.agentId,
        taskId: runId,
        statement,
        reads: this.resources.map((r) => ({
          resourceId: r.resourceId,
          observedVersion: r.version,
        })),
        steps: this.steps,
      });
      this.intentId = res?.intent?.id ?? null;
    } catch (e) {
      // A guard that breaks the run it is guarding is worse than no guard.
      // Fail open, and say so loudly enough to be noticed.
      console.warn(`[interlock] could not declare intent: ${e.message}`);
    }
  }

  /**
   * Record each tool call as a plan step, and send it.
   *
   * Steps are what make a repair surgical. Without them a conflict can only be
   * answered with "redo everything", which is the behaviour INTERLOCK exists to
   * improve on — and worse, an intent carrying no steps has no provenance
   * edges, so the graph pre-filter rules every conflict against it irrelevant.
   * Confidently, and wrongly.
   *
   * They cannot be batched until the end: a conflict can land at any moment,
   * and steps that arrive after the ruling did not exist when it mattered.
   *
   * Sent through a serialised queue rather than fired off per call, because
   * `seq` and the chain edge both depend on what is already stored, and
   * LangChain will happily start several tools before the first append returns.
   */
  handleToolStart(tool, input) {
    const name = tool?.name ?? tool?.id?.slice(-1)[0] ?? "tool";
    const step = {
      description: `${name}: ${summarise(input)}`,
      dependsOn: this.resources.map((r) => r.resourceId),
    };
    this.steps.push(step);
    this.#enqueue(step);
  }

  /**
   * Append one step, strictly after every step queued before it.
   *
   * LangChain callbacks are fire-and-forget, so nothing upstream will await
   * this. `flush()` is how a caller waits for the plan to be fully recorded.
   */
  #enqueue(step) {
    this.pending = this.pending
      .then(async () => {
        if (!this.intentId) return; // declaration failed; already warned
        await this.client.addSteps({ intentId: this.intentId, steps: [step] });
      })
      .catch((e) => {
        console.warn(`[interlock] could not record plan step: ${e.message}`);
      });
    return this.pending;
  }

  /**
   * Wait until every recorded step has reached the service.
   *
   * Call before committing if you want the ruling to see the whole plan.
   * `commit()` does it for you.
   */
  flush() {
    return this.pending;
  }

  /**
   * Commit through INTERLOCK and surface the ruling.
   *
   * Call this yourself when your agent is ready to write. It is not automatic:
   * only your code knows which write is *the* write, and guessing would be
   * worse than asking.
   */
  async commit({ resourceId, body, statement, expectedVersion, adjudicator }) {
    // Never adjudicate against a half-recorded plan.
    await this.flush();

    const res = await this.client.commit({
      agentId: this.agentId,
      intentId: this.intentId,
      resourceId,
      expectedVersion,
      body,
      statement: statement ?? this.statement ?? "Agent commit",
      adjudicator: adjudicator ?? this.adjudicator,
    });

    const mine = (res?.adjudications ?? []).find((a) => a.intentId === this.intentId);
    if (mine) {
      this.verdict = mine.verdict;
      this.rationale = mine.rationale;
      this.stepsToRedo = mine.affectedSteps ?? [];

      if (this.throwOnFatal && mine.verdict === "fatal") {
        throw new Error(`[interlock] plan invalidated beyond repair: ${mine.rationale}`);
      }
    }

    return res;
  }
}

/**
 * Tools, for agents that would rather reason about concurrency explicitly than
 * have it handled for them.
 *
 * Returned as plain descriptors so this module stays free of a hard dependency
 * on any one tool base class — wrap them with `tool()` or `DynamicStructuredTool`
 * in whichever LangChain version you are on.
 */
export function interlockTools({ apiKey, agentId, baseUrl } = {}) {
  const client = new Interlock({ apiKey, baseUrl });

  return [
    {
      name: "declare_intent",
      description:
        "Declare what you are about to do and what you read, BEFORE acting. " +
        "Lets other agents' commits be judged against your plan instead of silently invalidating it.",
      schema: { statement: "string", resourceIds: "string[]" },
      func: async ({ statement, resourceIds = [] }) =>
        client.declare({
          agentId,
          taskId: crypto.randomUUID(),
          statement,
          reads: resourceIds.map((id) => ({ resourceId: id, observedVersion: 1 })),
        }),
    },
    {
      name: "commit_change",
      description:
        "Commit a change to shared state. Returns a ruling for every agent your commit threatened, " +
        "naming which of their steps are now invalid.",
      schema: { resourceId: "string", body: "object", statement: "string" },
      func: async ({ resourceId, body, statement }) =>
        client.commit({ agentId, resourceId, body, statement }),
    },
  ];
}

/** Compact, non-leaky summary of arbitrary chain input. */
function summarise(value, max = 140) {
  if (value == null) return "(nothing)";
  const text =
    typeof value === "string" ? value : Object.entries(value ?? {})
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(", ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export default InterlockCallback;
