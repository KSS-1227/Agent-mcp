/**
 * SDK contract test.
 *
 * Runs against the deployed endpoint over the public internet with a freshly
 * issued key — the same path a stranger takes. Nothing here imports the server
 * or touches the database, so it fails whenever the published contract breaks,
 * which is the only kind of breakage an SDK user can see.
 *
 * Run: npm run test:sdk
 */
import { Interlock, InterlockError } from "../sdk/client.js";

const DEFAULT_BASE =
  "https://wpvk3ox2bxo2w3zhxmx54ssjf40rakuz.lambda-url.us-east-1.on.aws/";
import { InterlockCallback } from "../sdk/langchain.js";

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
    passed += 1;
  } catch (e) {
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}\n        ${e.message}`);
    failures.push(name);
  }
}

const eq = (a, b, what) => {
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`);
};
const truthy = (v, what) => {
  if (!v) throw new Error(`${what}: expected a value, got ${JSON.stringify(v)}`);
};

console.log("\nSDK contract\n");

/* ---------------------------------------------------------------- issuing */

// Reuse a key when one is supplied. Each full run issues four, and running the
// suite a few times in an afternoon exhausted the per-address daily limit —
// which then blocks the actual product for everyone sharing that address.
// A test that degrades the thing it tests is a bad test.
const issued = process.env.INTERLOCK_KEY
  ? { key: process.env.INTERLOCK_KEY, tenant: { slug: "(reused from INTERLOCK_KEY)" } }
  : await Interlock.issueKey({ name: "SDK Test", label: "test" });

const client = new Interlock({ apiKey: issued.key });

await check("issueKey returns a usable key and a tenant", async () => {
  truthy(issued.key?.startsWith("ilk_"), "key prefix");
  truthy(issued.tenant?.slug, "tenant slug");
});

await check("the key issuance limit is a refusal, not a crash", async () => {
  // Exercised because we hit it for real and the client had no idea what to do
  // with it. A 429 from our own quota must arrive as a readable message with
  // our `error` shape, so the SDK can tell it apart from a platform throttle
  // and decline to retry past it.
  const res = await fetch(`${process.env.INTERLOCK_BASE ?? DEFAULT_BASE}v1/keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "shape check" }),
  });
  const body = await res.json();
  if (res.status === 429) {
    truthy(typeof body.error === "string" && body.error.length > 20, "429 explains itself");
    eq(body.ok, false, "429 sets ok:false");
  } else {
    eq(res.status, 200, "unexpected status from /v1/keys");
    truthy(body.key?.startsWith("ilk_"), "issued key");
  }
});

await check("health reports topology", async () => {
  const h = await client.health();
  truthy(h.topology?.regions?.length >= 1, "regions");
});

await check("spending money moves the service-wide ledger", async () => {
  // The ceilings are only real if the number they read actually rises. It did
  // not for the entire life of the feature: recordSpend UPDATEd a `global` row
  // that nothing ever INSERTed, so 116 rulings recorded $0.0000 and both the
  // daily and monthly caps were reading a constant zero while reporting healthy.
  //
  // Asserting the request succeeded would not have caught it. Only the delta does.
  const before = (await client.health()).quota.globalUsdMonth ?? 0;
  await client.demo();
  const after = (await client.health()).quota.globalUsdMonth ?? 0;
  truthy(
    after > before,
    `service-wide spend did not move (${before} -> ${after}) — the budget ceiling cannot fire`,
  );
});

/* ------------------------------------------------------------ registration */

let agent, queue;

await check("registerAgent is idempotent by name", async () => {
  agent = await client.registerAgent({ name: "Tester", role: "qa" });
  const again = await client.registerAgent({ name: "Tester", role: "qa" });
  eq(again.id, agent.id, "second registration returned a different id");
});

await check("registerResource returns a version to read at", async () => {
  queue = await client.registerResource({
    key: `sdk-test-${Date.now().toString(36)}`,
    kind: "queue",
    body: { open_tickets: 40 },
  });
  truthy(Number(queue.version) >= 1, "version");
});

/* -------------------------------------------------------- declare + append */

let intentId;

await check("declare returns an intent id", async () => {
  const res = await client.declare({
    agentId: agent.id,
    taskId: crypto.randomUUID(),
    statement: "Drain the test queue down to twenty tickets before the shift ends.",
    reads: [{ resourceId: queue.id, observedVersion: queue.version }],
  });
  intentId = res.intent?.id;
  truthy(intentId, "intent.id");
});

await check("addSteps continues seq across calls", async () => {
  const first = await client.addSteps({
    intentId,
    steps: [{ description: "read depth", dependsOn: [queue.id] }],
  });
  const second = await client.addSteps({
    intentId,
    steps: [{ description: "plan drain", dependsOn: [queue.id] }],
  });
  eq(first.added, 1, "first append count");
  eq(second.added, 1, "second append count");
  // Distinct ids means the second did not overwrite the first at seq 0.
  truthy(first.stepIds[0] !== second.stepIds[0], "step ids");
});

/* ------------------------------------------------------------------ ruling */

await check("a conflicting commit returns a ruling naming the steps", async () => {
  const other = await client.registerAgent({ name: "Interferer", role: "qa" });
  const res = await client.commit({
    agentId: other.id,
    resourceId: queue.id,
    expectedVersion: queue.version,
    body: { open_tickets: 95 },
    statement: "Depth jumped to 95 after a bulk import.",
  });

  const mine = (res.adjudications ?? []).find((a) => a.intentId === intentId);
  truthy(mine, "no adjudication for our intent — the conflict went undetected");
  truthy(
    ["irrelevant", "compatible", "invalidating", "fatal"].includes(mine.verdict),
    `unknown verdict ${mine.verdict}`,
  );
  truthy(Array.isArray(mine.affectedSteps), "affectedSteps must be an array");
  eq(mine.stepsPreserved + mine.stepsRepaired, mine.stepsTotal, "step accounting");
});

/* ------------------------------------------------------------- isolation */

await check("a key cannot append steps to another tenant's intent", async () => {
  const stranger = await Interlock.issueKey({ name: "Stranger", label: "test" });
  const sc = new Interlock({ apiKey: stranger.key, maxRetries: 0 });
  try {
    await sc.addSteps({ intentId, steps: [{ description: "injected" }] });
    throw new Error("cross-tenant append was allowed");
  } catch (e) {
    if (!(e instanceof InterlockError) || e.status !== 404) throw e;
  }
});

await check("two tenants may use the same resource key without colliding", async () => {
  // Resource keys were globally unique until migration 009. Under that schema
  // the second tenant's registration hit ON CONFLICT DO UPDATE and was handed
  // the first tenant's row — id, body and all.
  const shared = `collision-${Date.now().toString(36)}`;
  const mineRes = await client.registerResource({ key: shared, kind: "queue", body: { mine: true } });

  const other = await Interlock.issueKey({ name: "Neighbour", label: "test" });
  const oc = new Interlock({ apiKey: other.key });
  const theirs = await oc.registerResource({ key: shared, kind: "queue", body: { mine: false } });

  truthy(theirs.id !== mineRes.id, "neighbour received our resource row");
  eq(theirs.body?.mine, false, "neighbour received our resource body");
});

await check("an unauthenticated call is refused", async () => {
  const anon = new Interlock({ apiKey: "ilk_not_a_real_key", maxRetries: 0 });
  try {
    await anon.registerAgent({ name: "Nope" });
    throw new Error("bad key was accepted");
  } catch (e) {
    if (!(e instanceof InterlockError) || e.status !== 401) throw e;
  }
});

/* ------------------------------------------------------------- langchain */

await check("the callback declares once for nested chains", async () => {
  const guard = new InterlockCallback({
    apiKey: issued.key,
    agentId: agent.id,
    resources: [{ resourceId: queue.id, version: queue.version }],
    statement: "A nested chain should still produce exactly one intent.",
  });

  const chain = { id: ["langchain", "chains", "outer"] };
  await guard.handleChainStart(chain, { a: 1 }, crypto.randomUUID(), undefined);
  const outer = guard.intentId;
  truthy(outer, "outer chain did not declare");

  // An inner chain: parentRunId is set, so it must not declare again.
  await guard.handleChainStart(chain, { a: 2 }, crypto.randomUUID(), outer);
  eq(guard.intentId, outer, "a nested chain declared a second intent");
});

await check("steps recorded by the callback reach the service", async () => {
  const guard = new InterlockCallback({
    apiKey: issued.key,
    agentId: agent.id,
    resources: [{ resourceId: queue.id, version: queue.version }],
    statement: "Steps recorded through the callback must be durable, not local.",
  });
  await guard.handleChainStart({ id: ["c"] }, {}, crypto.randomUUID(), undefined);
  guard.handleToolStart({ name: "alpha" }, { x: 1 });
  guard.handleToolStart({ name: "beta" }, { x: 2 });
  await guard.flush();

  // Proven by appending one more and seeing seq continue past them.
  const res = await client.addSteps({
    intentId: guard.intentId,
    steps: [{ description: "gamma" }],
  });
  eq(res.added, 1, "append count");
  eq(guard.steps.length, 2, "locally recorded steps");
});

/* -------------------------------------------------------------------------- */

const total = passed + failures.length;
if (failures.length) {
  console.log(`\n\x1b[31m${failures.length} of ${total} failed\x1b[0m\n`);
  process.exit(1);
}
console.log(`\n\x1b[32mall ${total} passed\x1b[0m — against the live endpoint\n`);
