# INTERLOCK API

Base URL

```
https://wpvk3ox2bxo2w3zhxmx54ssjf40rakuz.lambda-url.us-east-1.on.aws/
```

Everything is JSON. Authentication is `Authorization: Bearer ilk_…` where noted.
Errors always carry `{ "ok": false, "error": "<human-readable sentence>" }` — if a
response has an `error` field, it came from us and not from the platform.

---

## What you are actually buying

Worth stating plainly before the endpoint list, because it decides whether this
fits your architecture at all.

**INTERLOCK runs the inference.** You do not bring a model, and you do not bring
an API key for one. When a commit threatens an in-flight plan, we call Bedrock on
our account to judge whether the plan actually broke, and you are billed nothing
— you are metered instead (see [Quotas](#quotas)).

**You keep your agents.** Your prompts, your models, your tools, your framework.
INTERLOCK never sees your agent's reasoning. It sees a one-sentence statement of
intent, a list of what you read, and a list of steps — and it arbitrates the
shared state those steps depend on.

**Most conflicts never reach a model.** The provenance graph settles them for
free; `model: "provenance-graph"` on a ruling means no inference happened and
nothing was spent. That is the design, not an optimisation.

**What this is not.** It is not a place to run your agents, not an inference
proxy, and not a vector store you query directly. If you want somewhere to host
model calls, this is the wrong service.

---

## Quickstart

```bash
# 1. no key needed
curl -s $BASE/v1/health

# 2. get a key — returned once, only a SHA-256 is stored
curl -s -X POST $BASE/v1/keys \
  -H 'content-type: application/json' -d '{"name":"My Fleet"}'

# 3. register an agent
curl -s -X POST $BASE/v1/agents \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"name":"Scheduler"}'
```

Or `npm run quickstart -- $KEY` from the repo, which does the whole loop and
prints each stage. To check a key you already hold:

```bash
npm run verify -- ilk_your_key_here
```

That authenticates it, runs a real declare→commit→ruling, confirms a stranger
cannot reach your intents, and confirms a garbage key is refused.

### On Windows PowerShell, the curl above will not work

`curl` in PowerShell is an **alias for `Invoke-WebRequest`**, which takes
different flags entirely. Worse, the real `curl.exe` mangles a JSON body passed
inline — single quotes, escaped quotes and `--%` all produce malformed JSON,
because PowerShell rewrites the argument before curl sees it.

Three things that do work:

```powershell
# 1. PowerShell's own client — simplest
Invoke-RestMethod -Uri "$base/v1/keys" -Method Post `
  -ContentType "application/json" -Body '{"name":"My Fleet"}'

# 2. real curl.exe, with the body in a file
'{"name":"My Fleet"}' | Set-Content -Encoding ascii body.json
curl.exe -s -X POST "$base/v1/keys" -H "content-type: application/json" -d "@body.json"

# 3. skip the shell entirely
npm run quickstart
```

Git Bash, WSL and macOS/Linux run the `curl` commands in this document as
written.

---

## Endpoints

### `GET /v1/health`

No key. No quota. Returns live topology, how far back time travel reaches, the
quota state, and which adjudicator tiers are available.

```json
{
  "ok": true,
  "topology": {
    "regions": ["aws-us-east-1", "aws-us-east-2", "aws-us-west-2"],
    "primary": "aws-us-east-1",
    "survivalGoal": "region",
    "timeTravelReach": "1h"
  },
  "quota": { "callsToday": 0, "callLimit": 400, "usdToday": 0, "usdLimit": 3,
             "globalUsdToday": 0, "globalUsdLimit": 12 },
  "adjudicators": { "default": "bulk", "available": ["bulk", "adjudicator"] }
}
```

Read `adjudicators.available` at runtime rather than hard-coding tier names.

---

### `POST /v1/keys`

No key required — this is the endpoint you use when you do not have one.

```json
{ "name": "My Fleet", "label": "prod" }
```

Returns `{ key, prefix, tenant: { id, slug }, limits }`. **The key is shown
once.** Only a SHA-256 is stored, so it cannot be recovered or re-sent.

A key gives you an isolated tenant: no other caller's commits can adjudicate your
intents, and no other caller can see your rulings. The tenant filter is inside
the detection query, not wrapped around it.

Rate limited per IP address, generously, resetting at midnight UTC.

---

### `POST /v1/agents` · auth · no quota

Register an agent. **Idempotent by name within your tenant** — call it on every
boot rather than persisting the id somewhere and keeping it in sync.

```json
{ "name": "Scheduler", "role": "capacity-planner" }
```

→ `{ "ok": true, "agent": { "id": "…", "name": "Scheduler", "tenant": "…" } }`

---

### `POST /v1/resources` · auth · no quota

Register a piece of shared state — the thing agents contend over. **Idempotent by
`(kind, key)` within your tenant.** Two tenants may use the same key without
colliding.

```json
{ "key": "support-eu", "kind": "queue", "body": { "open_tickets": 118 } }
```

→ `{ "ok": true, "resource": { "id": "…", "version": 1, "body": {…} } }`

Keep the `version`. You pass it back as `expectedVersion` on commit, and that is
what makes a lost update impossible.

---

### `POST /v1/intents` · auth · metered

Declare what an agent is about to do, **before it does it**. This is the whole
mechanism: an intent that is not declared cannot be protected.

```json
{
  "agentId": "…",
  "taskId": "optional, defaults to a fresh uuid",
  "statement": "Rebalance the EU support queue overnight: compute the overflow above six staffed responders and hand it to the APAC rota.",
  "reads": [{ "resourceId": "…", "observedVersion": 1 }],
  "steps": [{ "description": "compute overflow", "dependsOn": ["<resourceId>"] }]
}
```

→ `{ "ok": true, "intent": { "id": "…", "read_hlc": "…" }, "cost": {…} }`

Notes that matter:

- `statement` is embedded, and that embedding is how semantically-related plans
  are found even when they share no rows. Write it as you would explain the task
  to a colleague — a terse label detects nothing.
- `reads` is the read-set: what this plan depends on and at which version.
- `steps` carry `dependsOn`, which is what lets a conflict be repaired at step
  granularity instead of discarding the task. **An intent with no steps has no
  provenance edges, so every conflict against it resolves to `irrelevant`.**
  If your plan is not known up front, declare the intent anyway and add steps as
  they happen with the endpoint below.

---

### `POST /v1/intents/steps` · auth · no quota

Append steps to an intent that is already open, for agents whose plan unfolds as
they work. `seq` continues from what is stored, and the chain edge is drawn from
the real predecessor, so a plan built across several calls has the same
provenance shape as one declared in a single shot.

```json
{ "intentId": "…", "steps": [{ "description": "draft handover", "dependsOn": ["…"] }] }
```

Appending to another tenant's intent returns 404, not 403 — you are not told it
exists.

---

### `POST /v1/commits` · auth · metered

Commit a change to shared state, and receive a ruling for every agent your write
threatened.

```json
{
  "agentId": "…",
  "intentId": "optional — your own intent, if this commit fulfils one",
  "resourceId": "…",
  "expectedVersion": 1,
  "body": { "open_tickets": 131 },
  "statement": "Depth rose to 131 after a billing incident.",
  "adjudicator": "bulk"
}
```

`adjudicator` is optional and picks which model rules on the conflicts this
commit causes. Named by role, not by model id, so your code survives the id
changing. Unknown values are **refused with 400**, never silently downgraded —
being quietly given a cheaper answer than you asked for is worse than an error.

**409 on a version mismatch:**

```json
{ "ok": false, "conflict": true, "expected": 1, "actual": 2 }
```

Someone moved the row since you read it. Re-read and decide.

**200 with rulings:**

```json
{
  "ok": true,
  "commit": { "id": "…", "version": 2 },
  "adjudications": [{
    "intentId": "…",
    "agent": "Scheduler",
    "detectedBy": "exact+graph+vector",
    "verdict": "invalidating",
    "rationale": "Queue depth rose 118 → 131, which changes the overflow calculation.",
    "model": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    "affectedSteps": [1, 2],
    "stepsTotal": 4,
    "stepsRepaired": 2,
    "stepsPreserved": 2
  }],
  "cost": { "usd": 0.0009, "tokensTotal": 812 }
}
```

| verdict | meaning | what to do |
|---|---|---|
| `irrelevant` | Your plan does not depend on what changed. | Carry on. |
| `compatible` | It changed, but your plan still holds. | Carry on. |
| `invalidating` | Some steps are now wrong. | Re-run **only** `affectedSteps`. |
| `fatal` | The premise of the plan is gone. | Abandon and re-plan. |

`affectedSteps` holds `seq` numbers. `model` tells you who ruled —
`"provenance-graph"` means no model was needed and nothing was spent.

**Commits are not idempotent.** There is no request id to deduplicate on, so a
failed commit must not be blindly retried: the write may have landed and only the
adjudication failed. The official client retries `GET` only, for this reason.

---

### `GET /v1/adjudications` · auth · no quota

Recent rulings, read-only. Served as a **follower read** — a few seconds stale by
design, because an audit feed should never make a writer wait.

---

## Quotas

Three ceilings, all held in CockroachDB inside a serializable transaction rather
than in Lambda memory. Instances are ephemeral and concurrent, so per-instance
counters undercount exactly when it matters.

| Scope | Default | Applies to |
|---|---|---|
| Anonymous, per IP | 400 calls · $3/day | Callers with no key |
| Per tenant | 2,000 calls · $5/day | Each issued key |
| **Whole service** | **$12/day** | Everyone combined |

The third is the one that bounds the bill. A tenant with budget remaining is
still refused when the service as a whole is out — otherwise per-tenant limits
multiply by the number of tenants, which is not a limit.

All reset at midnight UTC. `GET /v1/health` and `POST /v1/keys` keep working when
the inference budget is spent, because neither costs inference.

---

## Errors

| Status | Meaning |
|---|---|
| 400 | Malformed request, or an unknown `adjudicator`. |
| 401 | Missing, unknown or revoked key. |
| 404 | Not found, or belongs to another tenant. |
| 409 | Version mismatch on commit. |
| 429 | A quota was reached. The message says which and when it resets. |
| 500 | Ours. The message is the actual error, not a generic. |

Telling our 429 from the platform's: ours has an `error` field, a Lambda
function-URL throttle has `Message`. The official client keys on that shape and
declines to retry past our own refusal.

---

## Clients

- `sdk/client.js` — dependency-free `fetch`. Node, Deno, Bun, workers, browsers.
- `sdk/langchain.js` — a `BaseCallbackHandler`; add one callback, no rewrite.

See the README for both, and `npm run quickstart` for a runnable tour.
