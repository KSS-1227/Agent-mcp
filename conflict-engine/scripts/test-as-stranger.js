/**
 * The judge's-eye test.
 *
 * Everything a stranger can do with nothing but the public URL — no repo, no
 * credentials, no local setup. If any of this fails, the submission fails for
 * someone who never opens the code.
 *
 * Deliberately uses only global fetch and the public endpoints. It imports
 * nothing from the project, so it cannot accidentally pass by using our own
 * database connection or a cached client.
 *
 * Run: npm run test:stranger
 */
const API =
  process.env.PUBLIC_API_URL ||
  "https://wpvk3ox2bxo2w3zhxmx54ssjf40rakuz.lambda-url.us-east-1.on.aws/";
const SITE = process.env.PUBLIC_SITE_URL || "https://d3dgn014prmcy8.cloudfront.net";

const ok = (s) => `\x1b[32mPASS\x1b[0m  ${s}`;
const bad = (s) => `\x1b[31mFAIL\x1b[0m  ${s}`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const b = (s) => `\x1b[1m${s}\x1b[0m`;

let failures = 0;
const check = (pass, msg, detail) => {
  console.log(pass ? ok(msg) : bad(msg));
  if (detail) console.log(dim(`      ${detail}`));
  if (!pass) failures++;
};

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * This AWS account is capped at 10 concurrent Lambda executions -- below the
 * 1000 default and shared with other projects -- so firing every check at once
 * throttles us and measures the account limit rather than the service. Space
 * them out: the goal is to test what a visitor experiences, not to DoS it.
 */
const SPACING_MS = Number(process.env.TEST_SPACING_MS ?? 2500);

/**
 * fetch that retries a PLATFORM throttle but not our own rate limit.
 *
 * Both arrive as 429 and they mean opposite things. A Lambda throttle is
 * transient and retrying is correct. Our own quota is a deliberate refusal, and
 * retrying past it would be both rude and a lie about what the service does.
 *
 * Telling them apart needs care. The obvious test — "does it have a JSON
 * body?" — is wrong, and quietly disabled these retries for a while: a Lambda
 * function URL answers a throttle with {"Message":"Rate Exceeded."}, which is
 * JSON too.
 *
 * The reliable discriminator is the shape. Our refusals always carry an
 * `error` field and `ok: false`; AWS's carries `Message` and nothing else.
 *
 * Without this the test reports failures that are really just this account's
 * 10-execution cap — which trains you to ignore red output, the one thing a
 * smoke test must never do.
 */
const isOurRefusal = (parsed) =>
  !!parsed && typeof parsed === "object" && "error" in parsed;

async function req(url, init = {}, attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(url, init);
    if (res.status !== 429) return res;

    const parsed = await res.clone().json().catch(() => null);
    if (isOurRefusal(parsed)) return res; // a deliberate refusal — respect it
    if (i === attempts - 1) return res;

    await pause(1500 * (i + 1));
  }
}

const t = async (fn) => {
  await pause(SPACING_MS);
  const s = Date.now();
  const r = await fn();
  return [r, Date.now() - s];
};

/* ------------------------------------------------------------------ site */
console.log(b("\n1. The demo page\n"));
{
  const [res, ms] = await t(() => fetch(SITE));
  const html = await res.text();
  check(res.ok, `page loads (HTTP ${res.status}, ${ms}ms, ${(html.length / 1024).toFixed(0)}KB)`);
  check(
    html.includes("INTERLOCK") && html.includes("Watch two agents collide"),
    "page contains the demo section",
  );
}

/* ---------------------------------------------------------------- health */
console.log(b("\n2. Service health — no key needed\n"));
let health;
{
  const [res, ms] = await t(() => req(`${API}v1/health`));
  health = await res.json();
  check(res.ok && health.ok, `GET /v1/health (${ms}ms)`);
  check(
    health.topology?.regions?.length >= 3,
    `${health.topology?.regions?.length} regions, survival "${health.topology?.survivalGoal}"`,
    health.topology?.regions?.join(", "),
  );
  check(
    health.quota?.callsToday < health.quota?.callLimit,
    `quota available: ${health.quota?.callsToday}/${health.quota?.callLimit} calls, $${health.quota?.usdToday?.toFixed(4)}/$${health.quota?.usdLimit}`,
  );
}

/* ------------------------------------------------------------------ demo */
console.log(b("\n3. Run a real adjudication — no key needed\n"));
{
  const [res, ms] = await t(() =>
    req(`${API}v1/demo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
  const d = await res.json();
  check(res.ok && d.ok, `POST /v1/demo (${ms}ms)`);
  const ruling = d.trace?.find((x) => x.step === "adjudicate");
  check(!!ruling, `a ruling was produced: ${ruling?.label}`, ruling?.detail?.slice(0, 96));
  check(
    typeof d.summary?.preservedPct === "number",
    `${d.summary?.stepsPreserved}/${d.summary?.stepsPreserved + d.summary?.stepsRepaired} steps preserved (${d.summary?.preservedPct}%)`,
  );
  check(d.cost?.usd > 0, `cost reported: $${d.cost?.usd?.toFixed(6)}, ${d.cost?.energyWh} Wh`);
}

/* --------------------------------------------------------------- stream */
await pause(SPACING_MS);
console.log(b("\n4. Stream it, and watch the working\n"));
{
  const res = await req(`${API}v1/demo/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  check(res.ok, `POST /v1/demo/stream (HTTP ${res.status})`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const kinds = new Set();
  let events = 0;
  let sqlSeen = 0;
  let vectorDims = 0;
  let promptChars = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const l of lines) {
      if (!l.trim()) continue;
      try {
        const e = JSON.parse(l);
        events++;
        kinds.add(e.t);
        if (e.t === "sql") sqlSeen++;
        if (e.t === "vector") vectorDims = e.dims;
        if (e.t === "prompt") promptChars = e.prompt?.length ?? 0;
      } catch {
        /* partial line */
      }
    }
  }

  check(events > 20, `${events} events streamed`, [...kinds].join(", "));
  check(sqlSeen >= 3, `${sqlSeen} SQL statements exposed — the memory layer is visible`);
  check(vectorDims === 1024, `real ${vectorDims}-dimension embedding shown`);
  check(promptChars > 200, `adjudicator prompt shown (${promptChars} chars)`);
}

/* ------------------------------------------------------------ audit feed */
await pause(SPACING_MS);
console.log(b("\n5. Read the audit feed\n"));
{
  const res = await req(`${API}v1/adjudications`);
  const d = await res.json();
  check(res.ok && Array.isArray(d.adjudications), `GET /v1/adjudications`);
  check(
    d.adjudications?.length > 0,
    `${d.adjudications?.length} historical rulings visible`,
    d.adjudications?.[0] &&
      `latest: ${d.adjudications[0].verdict} via ${d.adjudications[0].detected_by}`,
  );
}

/* -------------------------------------------------------- self-serve key */
await pause(SPACING_MS);
console.log(b("\n6. Get a key and use it\n"));
{
  const res = await req(`${API}v1/keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Stranger Test", label: "smoke" }),
  });
  const k = await res.json();

  // Hitting our own issuance cap is the limiter working, not the service
  // failing. Reporting it as a failure would train us to ignore red output,
  // which is the one thing a smoke test must never do.
  if (res.status === 429) {
    console.log(dim(`SKIP  issuance quota reached for this address today — the limiter is working`));
    console.log(dim(`      ${k.error ?? ""}`));
  } else {
    check(res.ok && k.ok && k.key?.startsWith("ilk_"), `POST /v1/keys issued ${k.prefix}…`);
    check(!!k.tenant?.slug, `isolated tenant created: ${k.tenant?.slug}`);
    check(
      k.limits?.dailyCalls > health.quota.callLimit,
      `keyed limits are higher than anonymous (${k.limits?.dailyCalls} vs ${health.quota.callLimit})`,
    );

    await pause(SPACING_MS);
    const authed = await req(`${API}v1/health`, {
      headers: { authorization: `Bearer ${k.key}` },
    });
    check(authed.ok, "the key authenticates");
  }

  // Independent of issuance: an invalid key must be rejected either way.
  await pause(SPACING_MS);
  const badKey = await req(`${API}v1/demo`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer ilk_not_a_real_key" },
    body: "{}",
  });
  check(badKey.status === 401, `an invalid key is rejected (HTTP ${badKey.status})`);
}

/* ------------------------------------------------------------------ CORS */
await pause(SPACING_MS);
console.log(b("\n7. Callable from a browser\n"));
{
  const res = await req(`${API}v1/health`, {
    method: "OPTIONS",
    headers: { origin: SITE, "access-control-request-method": "POST" },
  });
  check(
    res.status < 400 && !!res.headers.get("access-control-allow-origin"),
    `CORS preflight (HTTP ${res.status}, allow-origin: ${res.headers.get("access-control-allow-origin")})`,
  );
}

/* --------------------------------------------------------------- verdict */
console.log(
  failures === 0
    ? b("\n  Everything a stranger can do, works.\n")
    : b(`\n  ${failures} check(s) failed.\n`),
);
process.exit(failures === 0 ? 0 : 1);
