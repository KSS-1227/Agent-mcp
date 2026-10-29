# Devpost submission — INTERLOCK

Paste-ready. Every number here is reproducible from the repo.

---

## Tagline

**Agent memory that lets parallel agents think for 40 seconds without corrupting each other's work.**

---

## Links

| Field | Value |
|---|---|
| Repository | https://github.com/usv240/interlock |
| Demo | https://d3dgn014prmcy8.cloudfront.net |
| Public API | https://wpvk3ox2bxo2w3zhxmx54ssjf40rakuz.lambda-url.us-east-1.on.aws/ |
| Video | *(paste after upload)* |
| Licence | MIT — detected in the repo About panel |

**Judges: three commands, no setup.** Node only — no database, no AWS account, no config.

```bash
git clone https://github.com/usv240/interlock && cd interlock && npm install
npm run quickstart     # the whole loop against the live service, ~15s
npm run compare        # two collisions priced with and without INTERLOCK
npm run verify         # proves a key is authenticated, isolated and metered
```

---

## Inspiration

An LLM agent's unit of work is not a database transaction. It **reads** shared memory, **thinks for forty seconds**, then **acts** — and the world changed while it was thinking.

Measured across ten contended workloads ([CoAgent, arXiv:2606.15376](https://arxiv.org/abs/2606.15376)), the standard fix runs at **0.93× the speed of running agents one at a time, at 1.83× the token cost.** Running agents in parallel today is *slower than not parallelising at all*, and you pay nearly double for the privilege.

Meanwhile parallel agents are shipping at scale, and the industry's answer to shared-state conflict is a **git worktree and a merge conflict**.

The insight the paper points at, and nobody had built: **most conflicts are semantically irrelevant.** An agent can read the conflicting write and judge whether it actually breaks its plan. A real conflict needs repair of only the *dependent steps*.

## What it does

INTERLOCK is optimistic concurrency where **validation is reasoning instead of a version check**, and **abort is a surgical repair instead of a rollback**.

1. **Declare** — an agent writes its plan and read-set before acting, as text *and* a 1024-dim embedding
2. **Watch** — when a commit lands, three paths in one query find who is threatened: exact row overlap, a recursive provenance walk, and an ANN search over intent embeddings that catches plans sharing *meaning* but no rows
3. **Diff** — `AS OF SYSTEM TIME` replays the exact snapshot the agent read
4. **Adjudicate** — the provenance graph rules first, for free; only its candidates reach a model
5. **Resolve** — the ruling is recorded exactly once, and only dependent steps are repaired

Correctness never rests on the model's judgement: the final write is a real `SERIALIZABLE` transaction, so a wrong ruling costs wasted work, not a lost update.

**It is a service, and it is not an inference proxy.** You keep your models, prompts, tools and framework; we never see your agent's reasoning. Self-serve keys, per-tenant isolation, a LangChain callback for fleets that already exist, and a dependency-free client for those that don't.

## How we built it

**CockroachDB — all four tools, none decorative.** Swap the database and the mechanism stops functioning, rather than merely getting slower.

| Tool | What the agent does with it |
|---|---|
| **Distributed Vector Indexing** | A **partial, tenant-prefixed** C-SPANN index over the intents *currently in flight* — because semantic detection never asks about resolved plans. At **roughly 1,700 live plans the planner selects it**; `npm run ai:vector` prints the plan and names the tenant it probed. Threshold **measured, not guessed** (`npm run ai:calibrate`) |
| **Managed MCP Server** | Not a human console — a **read-only tool belt for the adjudicating agent**. Before ruling it may request one lookup: has this resource churned all morning, or is this the first change in an hour? The channel cannot express a mutation, and every lookup is audit-logged outside our own logging |
| **ccloud / Cloud API** | A continuity agent that **refuses to let adjudication run** if the cluster is not actually configured to survive a region, and reports `gc.ttlseconds` per table — the real ceiling on how far back a diff can read |
| **Agent Skills** | Consumed for schema and index design. We wrote one in return — `skills/managing-long-running-agent-transactions/` — carrying the traps that cost us real time. It ships in this repo; it is **not** upstream, and we would rather say so than imply a merge that has not happened |

Plus **changefeeds**, **row-level TTL**, **recursive CTEs**, **follower reads** on the audit feed, **per-table `gc.ttlseconds`**, three distinct **localities** (`GLOBAL`, `REGIONAL BY TABLE IN PRIMARY REGION`, pinned), and a 3-region **`SURVIVE REGION FAILURE`** database. 11 migrations, 15 tables, and live data that grows with public demo use — roughly 1,900 intents, 1,600 provenance edges and 136 tenants at the time of writing.

**AWS — only what we actually run on**

Bedrock (Titan embeddings + Claude, with **caller-selectable tiers** — `adjudicator: "bulk" | "adjudicator"`, named by role so client code survives model ids moving) · Lambda (public API + SQS worker, capped concurrency so the worker cannot starve the API) · EventBridge + SQS (async adjudication with DLQ) · S3 + CloudFront (private origin via OAC) · CloudWatch · IAM (specific model ARNs, not `bedrock:*`, with explicit denies on destroying evidence).

We deliberately **removed** ECS Fargate from our claims — we designed for it and never wired it, and *"meaningfully integrated, not just initialized"* is a pass/fail rule.

## Challenges we ran into

Every one of these was found by measurement and is documented in the source. The pattern that connects them is the one this product exists to attack: **a check that appears to exist, reads as authoritative, and never fires.**

- **A cosine/L2 mismatch silently disabled semantic detection.** The threshold was scaled for cosine, the operator was L2. Real conflicts measure 0.52 in cosine and 1.02 in L2, so the vector path never once fired — and the "detected by both" label hid it.
- **The vector index was serving a query nobody runs.** Fixing the metric was necessary and not sufficient: *any* `WHERE` clause sent the production query to a full scan. Removing every filter selected the index. Migration 010 replaced it with a partial index whose predicate *is* the query's predicate.
- **The corpus seeded to prove the index works was outside the index.** It was written with status `aborted` so it could never be adjudicated by accident — but the partial index covers only in-flight plans. 1,741 seeded rows, 20 in the index. Isolation never came from the status; it comes from the tenant filter inside the detection query.
- **The global spend cap was decorative.** Every request was metered against its own tenant bucket and nothing checked the sum. `/v1/health` displayed a `global` figure that nothing ever read back to refuse anything. Now enforced across all tenants, checked *before* the caller's own allowance.
- **Then the ledger it read turned out to be dead.** `recordSpend` charged the `global` bucket with `UPDATE … WHERE`, and nothing anywhere creates that row — so it matched zero rows on every call since the file was written. An `UPDATE` that matches nothing is not an error in SQL. 116 model-backed rulings, service-wide total `$0.0000`, and two ceilings reading a number that could only ever be zero while reporting healthy. Both buckets are upserted now, and the test suite asserts the *delta* rather than that a request succeeded.
- **The one path that spends automatically had no ceiling at all.** The SQS worker calls a model and has no HTTP caller, so none of the API's quota checks applied to it. 62 worker invocations had spent real tokens, uncounted. It was also the path that fires by itself on every commit, at whatever rate traffic arrives.
- **A chaos-drill invariant was checking the whole database.** "Nothing stuck mid-flight" counted every `threatened` intent, not the drill's own — so it reported 15 on a run that left 4, and had been passing because the cluster happened to be clean rather than because the property held.
- **Two CORS headers merged into one invalid one.** The function URL sets CORS and so did our handler, producing `access-control-allow-origin: *,https://…`. The preflight passed (function URLs answer `OPTIONS` themselves), `curl` passed, the SDK suite passed — only browsers failed, because CORS is enforced by browsers and nothing else. Every check we had was on the wrong side of it.
- **Our own SDK manufactured a phantom conflict.** It retried a 5xx on a commit that had already applied; the retry hit the version guard, saw its own write, and reported "someone else moved this row". Retries are now GET-only.
- **`INT8` arrives as a string** in node-postgres, so `version + 1` produced `"11"` from `"1"`. The guard we added then threw on CockroachDB's own job ids (~1.2e18); it now returns BigInt.
- **Changefeeds do an initial scan by default**, so the first run re-adjudicated all of history: 22 batches, 25,000 tokens. Nothing broke — the unique index made every replay a no-op — but it was real money on a no-op.
- **`us.` inference profiles dispatch cross-region.** A least-privilege policy allowing only `us-east-1` model ARNs is denied when the profile lands in `us-east-2`.

## Accomplishments we're proud of

**We published where it loses.** Below the crossover, adjudicating costs more than retrying — so don't use this, just retry. That region is shaded on the chart rather than cropped out, and `npm run compare -- --reasoning 400` prints, in red, that INTERLOCK costs *more*. A demo that can only produce good news is not evidence.

**We publish the number that contradicts us.** Our own audit feed is ~70% `invalidating` while the page claims most conflicts are irrelevant. Both are true — every row in that feed came from a demo, a test or the benchmark, and all three construct a real conflict on purpose. `/v1/adjudications` returns that caveat *next to the counts*, so a judge who checks finds it already explained.

**Exactly-once is structural, not conventional.** A `UNIQUE (commit_id, intent_id)` index means a double-apply fails loudly. It survived a chaos drill that destroys every in-flight connection mid-adjudication — 12 kill waves, all four invariants held — then paid for itself again by making SQS's at-least-once delivery safe with no extra code.

**Tenant isolation is proven, not asserted.** `npm run test:isolation` runs two tenants whose intents measure **cosine distance 0.0000** — identical text the vector path would certainly have matched across tenants had the filter been outside the query. `npm run verify` re-proves it on any key in fifteen seconds.

## What we learned

The economics are the opposite of what the pitch assumed. Adjudication costs roughly a fixed amount per conflict; re-running a task costs in proportion to how much reasoning it discards. So the honest claim is a **regime**, not a win — and finding the crossover took three legitimate optimisations and one workload redesign, all published.

The deeper lesson is the one in the bug list. Most of those twelve were *silent*: the code ran, returned plausible results, and was wrong. That is exactly the failure mode an agent hits when the world moves underneath it — which is the whole thesis, arrived at the hard way, in our own build.

## What's next

Bring-your-own-key, so a tenant can use their own model and their own bill — the honest ceiling on this today. Step-level semantic matching (the plumbing exists, off by default because it costs more than it returns on the hot path). Adjudicator distillation, since the graph pre-filter already narrows the question far enough that a much smaller model should suffice.

---

## Judging-criteria checklist

| Criterion | Evidence |
|---|---|
| **Agentic Memory Design** | Memory *is* the mechanism, not the storage: intents, read-sets, a recursive provenance graph, embeddings, MVCC snapshots, bitemporal validity. 11 migrations, 15 tables, **~1,700 in-flight plans where the planner selects the vector index**, 3-region topology. Swap the database and the product stops existing |
| **Technological Implementation** | Recursive CTE ⨝ ANN ⨝ time-travel in one serializable transaction; async pipeline with DLQ and partial-batch failure; 13 SDK contract tests and 14 stranger tests against the deployed endpoint; twelve documented bug hunts, most of them silent failures |
| **Real-World Impact** | Not "agent fleets" abstractly — **any system where an LLM writes to shared state**: coding agents touching one repo, ops automations touching one runbook, support bots touching one queue. Public API, self-serve keys, LangChain callback, and a published crossover so adopters know when *not* to use it |
| **Product Readiness** | 3 regions + `SURVIVE REGION FAILURE`; chaos drill; exactly-once by constraint; **enforced** per-tenant *and* service-wide spend ceilings; least-privilege IAM with explicit denies; credential rotation with env sync; `npm run pipeline` health check; browser-level CORS regression harness |
| **Creativity & Originality** | First open-source implementation of semantic concurrency control, benchmarked against the paper's own numbers. Two uses of CockroachDB we have not seen elsewhere: **MCP as the adjudicating agent's read-only tool belt**, and a **partial vector index scoped to the working set** rather than the archive |

## Feedback on the CockroachDB AI tools

- The **managed MCP server accepting a service-account API key** as a bearer token — not just OAuth — is what made a headless auditor console possible. Worth documenting more prominently; the console only shows the OAuth flow.
- **Follower reads fail through MCP** with `inconsistent AS OF SYSTEM TIME timestamp`, even though the same query works on a direct connection. We applied it to our own connection instead.
- `CREATE CHANGEFEED` defaulting to an **initial scan** is the correct default for replication and an expensive one for event-driven work. A louder warning would have saved us 25,000 tokens.
- **Vector index selection is invisible until it isn't.** Ours was unusable for two distinct reasons (wrong opclass, then a filter it could not serve) and both looked identical from the outside: a plan that quietly says `scan`. A `SHOW VECTOR INDEX` diagnostic, or an `EXPLAIN` hint saying *why* a vector index was rejected, would have saved days.
- `ADD REGION IF NOT EXISTS` being idempotent while `SET PRIMARY REGION` is not made writing a re-runnable migration slightly awkward.
