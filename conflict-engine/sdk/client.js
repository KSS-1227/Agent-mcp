/**
 * INTERLOCK client.
 *
 * A dependency-free wrapper over the public API, so an agent fleet can adopt
 * concurrency safety without adopting our stack. Everything here is plain
 * fetch: no SDK, no build step, works in Node, Deno, Bun, workers and browsers.
 *
 *   import { Interlock } from "interlock/sdk";
 *
 *   const il = new Interlock({ apiKey: process.env.INTERLOCK_KEY });
 *   const intent = await il.declare({ agentId, statement, reads, steps });
 *   const { adjudications } = await il.commit({ agentId, resourceId, body, statement });
 *
 * THE SHAPE OF THE CONTRACT
 * Declare what you are about to do. Commit through us. Act on the ruling.
 * Your agents keep their own reasoning, their own tools and their own models —
 * INTERLOCK arbitrates the shared state and nothing else.
 */

const DEFAULT_BASE =
  "https://wpvk3ox2bxo2w3zhxmx54ssjf40rakuz.lambda-url.us-east-1.on.aws/";

export class InterlockError extends Error {
  constructor(message, { status, body, retryable = false } = {}) {
    super(message);
    this.name = "InterlockError";
    this.status = status;
    this.body = body;
    /** True when trying again later is the correct response. */
    this.retryable = retryable;
  }
}

export class Interlock {
  constructor({ apiKey, baseUrl = DEFAULT_BASE, fetch: customFetch, maxRetries = 4 } = {}) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    this.fetch = customFetch ?? globalThis.fetch;
    this.maxRetries = maxRetries;

    if (!this.fetch) {
      throw new Error("No fetch available. Pass one via { fetch }.");
    }
  }

  /**
   * One request, with backoff on transient failures only.
   *
   * A 429 can mean two opposite things and they must not be conflated:
   * our own quota is a deliberate refusal and retrying past it would be both
   * rude and a lie about what the service does, while a platform throttle is
   * transient and retrying is correct.
   *
   * They are told apart by shape rather than by having a JSON body — a Lambda
   * function URL answers a throttle with {"Message":"Rate Exceeded."}, which is
   * JSON too. Ours always carries an `error` field.
   */
  async #request(path, { method = "GET", body } = {}) {
    const url = `${this.baseUrl}${path.replace(/^\//, "")}`;
    const headers = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let res;
      try {
        res = await this.fetch(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (e) {
        // Same rule as for 5xx below. A fetch that throws cannot tell you
        // whether the server saw the request, so replaying a mutation is a
        // guess about which of two very different things happened.
        lastError = new InterlockError(`Network error: ${e.message}`, {
          retryable: method === "GET",
        });
        if (method !== "GET" || attempt === this.maxRetries) throw lastError;
        await sleep(backoff(attempt));
        continue;
      }

      const parsed = await res.json().catch(() => null);
      const ours = !!parsed && typeof parsed === "object" && "error" in parsed;

      if (res.ok) return parsed;

      if (res.status === 429 && !ours && attempt < this.maxRetries) {
        await sleep(backoff(attempt)); // platform throttle
        continue;
      }

      /*
       * A 5xx is only safe to retry when the call could not have changed
       * anything.
       *
       * This used to retry every 5xx, and it produced precisely the anomaly
       * this library exists to prevent. A commit whose write landed and whose
       * *adjudication* then failed returned 500 — so the client sent it again,
       * the version guard saw the write it had itself just made, and reported a
       * 409 "someone else moved this row". The real error was swallowed, and
       * the caller was told a lie about why.
       *
       * Only GET is retried. The mutating routes are not idempotent — there is
       * no request id to deduplicate on — so a failed POST is the caller's to
       * decide about, with the actual error in hand.
       */
      const idempotent = method === "GET";
      if (res.status >= 500 && idempotent && attempt < this.maxRetries) {
        await sleep(backoff(attempt));
        continue;
      }

      throw new InterlockError(
        parsed?.error ?? `Request failed with ${res.status}`,
        { status: res.status, body: parsed, retryable: res.status === 429 },
      );
    }
    throw lastError;
  }

  /** Topology, survival goal, time-travel reach and remaining quota. */
  health() {
    return this.#request("v1/health");
  }

  /** Create an isolated tenant and a key. The key is returned once and never again. */
  static async issueKey({ name, label = "sdk", baseUrl = DEFAULT_BASE } = {}) {
    const il = new Interlock({ baseUrl });
    return il.#request("v1/keys", { method: "POST", body: { name, label } });
  }

  /**
   * Register an agent in your tenant. Idempotent by name — safe to call on
   * every boot rather than storing an id somewhere and keeping it in sync.
   */
  async registerAgent({ name, role = "agent" }) {
    const res = await this.#request("v1/agents", { method: "POST", body: { name, role } });
    return res.agent;
  }

  /** Register a piece of shared state. Idempotent by (kind, key). */
  async registerResource({ key, kind = "resource", body = {} }) {
    const res = await this.#request("v1/resources", {
      method: "POST",
      body: { key, kind, body },
    });
    return res.resource;
  }

  /**
   * Declare an intent before acting.
   *
   * `reads` is the read-set: what this plan depends on, and at which version.
   * `steps` carry `dependsOn` so a later conflict can be repaired at step
   * granularity instead of throwing the whole task away.
   */
  declare({ agentId, taskId, statement, reads = [], steps = [] }) {
    return this.#request("v1/intents", {
      method: "POST",
      body: { agentId, taskId, statement, reads, steps },
    });
  }

  /**
   * Add steps to an intent that is already open.
   *
   * For agents whose plan unfolds as they work rather than being known in
   * advance. The intent is still declared before acting; only its detail
   * arrives late.
   */
  addSteps({ intentId, steps }) {
    return this.#request("v1/intents/steps", {
      method: "POST",
      body: { intentId, steps },
    });
  }

  /**
   * Commit a change to shared state.
   *
   * Returns `adjudications`: one ruling per agent this commit threatened.
   * A ruling of `invalidating` names exactly which of their steps to redo.
   *
   * `adjudicator` picks which model rules on those conflicts — "bulk" (default,
   * cheapest), "adjudicator", or "escalate". Named by role, not by model id, so
   * your code does not break when the id behind a role changes. Call `health()`
   * to see what is available. Most conflicts never reach a model at all: the
   * provenance graph settles them for free.
   */
  commit({
    agentId,
    intentId,
    resourceId,
    expectedVersion,
    body,
    statement,
    adjudicator,
  }) {
    return this.#request("v1/commits", {
      method: "POST",
      body: {
        agentId,
        intentId,
        resourceId,
        expectedVersion,
        body,
        statement,
        adjudicator,
      },
    });
  }

  /** Recent rulings. Served as a follower read, so it is a few seconds stale by design. */
  adjudications() {
    return this.#request("v1/adjudications");
  }

  /** Run the built-in demo conflict. Useful as a smoke test after wiring up. */
  demo() {
    return this.#request("v1/demo", { method: "POST", body: {} });
  }

  /**
   * The demo as a stream of events.
   * Yields each stage as it happens: the SQL, the embedding, the prompt, the
   * verdict. Handy for building your own UI over the mechanism.
   */
  async *streamDemo() {
    const headers = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const res = await this.fetch(`${this.baseUrl}v1/demo/stream`, {
      method: "POST",
      headers,
      body: "{}",
    });
    if (!res.ok || !res.body) {
      throw new InterlockError(`Stream failed with ${res.status}`, { status: res.status });
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          yield JSON.parse(line);
        } catch {
          /* partial line across a chunk boundary */
        }
      }
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt) => Math.min(1200 * 2 ** attempt, 8000) + Math.random() * 300;

export default Interlock;
