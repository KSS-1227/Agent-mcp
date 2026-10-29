## Inspiration

An AI agent does not work like a database transaction. It reads some shared state, thinks for forty seconds, and then acts. The problem is what happens in those forty seconds. Another agent can change the very thing it was reasoning about, and the first agent has no idea. It goes ahead and acts on a world that no longer exists.

We wanted to know how bad this actually is, so we went looking for measurements instead of opinions. We found them in the CoAgent paper, [arXiv:2606.15376](https://arxiv.org/abs/2606.15376). Measured across ten contended workloads, the standard fix (optimistic concurrency, where you detect the clash afterwards and retry) runs at 0.93x the speed of just running the agents one at a time, and costs 1.83x the tokens.

Read that again, because it is the whole reason this project exists. Running agents in parallel today can be slower than not running them in parallel at all, and you pay almost double for the privilege.

Meanwhile, parallel agents are already shipping everywhere. And the industry's current answer to two agents touching the same state is a git worktree and a merge conflict.

The paper points at an insight that nobody had built into a working system: most conflicts do not actually matter. If another agent changes a row your plan never depended on, your reasoning is still perfectly good. And even when a change does matter, it usually breaks only part of your plan, not all of it.

So the question became simple. Instead of throwing away forty seconds of reasoning every time something moves, can we work out exactly which parts of the plan died, and redo only those?

## What it does

INTERLOCK is a referee for agents that share state. It is optimistic concurrency, with two things swapped out. Validation becomes reasoning instead of a version check. And an abort becomes a surgical repair instead of throwing everything away.

It works in five steps.

1. **Declare.** Before an agent acts, it writes down what it read and what it plans to do. This is stored as text and as a 1024 dimension embedding, in one transaction.
2. **Watch.** When any commit lands, we look for plans it might have broken. Three methods run inside a single query: exact row overlap, a recursive walk through the provenance graph, and a vector similarity search that catches plans sharing meaning even when they share no rows at all.
3. **Diff.** Using `AS OF SYSTEM TIME`, we replay the exact snapshot the agent originally read and compare it to now. This is how the agent gets shown what moved underneath it.
4. **Adjudicate.** The provenance graph rules first, and it is free. If no step in the plan descends from the changed row, the answer is "irrelevant" and no model is ever called. Only the cases the graph cannot settle reach a model.
5. **Resolve.** The ruling is recorded exactly once, and only the dependent steps are repaired. The rest of the reasoning survives.

Something important: correctness never depends on the model being right. The final write is a real `SERIALIZABLE` transaction. If the model makes a bad call, you lose some wasted work. You never lose an update.

INTERLOCK is a service, and it is deliberately not an inference proxy. You keep your own models, prompts, tools and framework. We never see your agent's reasoning. We only need the intent, the read set, and the plan steps needed to arbitrate shared state.

You can use it today. Keys are self serve, every tenant is isolated, there is a LangChain callback for fleets that already exist, and a dependency free client for those that do not.

## How we built it

**CockroachDB is the mechanism, not the storage.** If you swap the database out, this product stops working. That was our test for whether we were using it honestly.

We used all four of the sponsor tools:

* **Distributed Vector Indexing.** A partial, tenant prefixed C-SPANN index covering only the plans currently in flight, because there is no reason to ask semantic questions about plans that already resolved. At roughly 1,700 live plans the query planner starts selecting it. We measured that threshold rather than guessing it.
* **Managed MCP Server.** Not a human console. It is a read only tool belt for the adjudicating agent. Before ruling, the agent can ask one question, such as whether this resource has been changing all morning or whether this is the first edit in an hour. The channel cannot express a mutation, and every lookup is audit logged.
* **ccloud and the Cloud API.** A continuity agent that refuses to let adjudication run if the cluster is not genuinely configured to survive a region failure. It also reports `gc.ttlseconds` per table, which is the real ceiling on how far back a time travel diff can read.
* **Agent Skills.** We used them for schema and index design, and wrote one back covering the traps that cost us real time. It ships in this repo. It is not upstream, and we would rather say that plainly than imply a merge that has not happened.

We also lean on changefeeds, row level TTL, recursive CTEs, follower reads, per table `gc.ttlseconds`, three different table localities, and a three region database with `SURVIVE REGION FAILURE`. That comes to 11 migrations and 15 tables. The data itself keeps growing as people use the public demo, and sits at roughly 1,900 intents and 1,600 provenance edges as I write this.

**On AWS we used only what we actually run on.** Bedrock for Titan embeddings and Claude, with caller selectable tiers named by role rather than model id, so client code survives models being replaced. Lambda for the public API and an SQS worker, with capped concurrency so the worker cannot starve the API. EventBridge and SQS for async adjudication, with a dead letter queue. S3 and CloudFront for the site, with a private origin. CloudWatch for logs. IAM scoped to specific model ARNs rather than `bedrock:*`, with explicit denies on destroying evidence.

We removed ECS Fargate from our claims. We designed for it and never wired it up, and "meaningfully integrated, not just initialized" is a pass or fail rule.

## Challenges we ran into

We found twelve real bugs, and almost all of them were silent. The code ran, returned believable results, and was wrong. One pattern connects nearly every one: a check that appears to exist, reads as authoritative, and never actually fires.

* **A cosine and L2 mismatch quietly switched off semantic detection.** Our threshold was tuned for cosine distance, but the operator was L2. A real conflict measures about 0.52 in cosine and 1.02 in L2, so the vector path never fired even once. A label saying "detected by both" hid it from us.
* **The vector index was serving a query nobody runs.** Fixing the metric was necessary but not enough. Any `WHERE` clause sent the real query to a full scan. We replaced it with a partial index whose predicate is the query's predicate.
* **The corpus we seeded to prove the index works was outside the index.** We wrote it with status `aborted` so it could never be adjudicated by accident, but the partial index only covers in flight plans. We had seeded 1,741 rows and indexed 20 of them.
* **The global spend cap was decorative.** Every request was metered against its own tenant, and nothing ever checked the total.
* **Then the ledger it read turned out to be dead.** The code charged the global bucket with an `UPDATE ... WHERE`, and nothing anywhere creates that row, so it matched zero rows on every single call. An `UPDATE` that matches nothing is not an error in SQL. We had recorded 116 model backed rulings with a service wide total of $0.0000, and two spending ceilings reading a number that could only ever be zero, while reporting healthy.
* **The one path that spends money automatically had no ceiling at all.** The SQS worker calls a model and has no HTTP caller, so none of the API's quota checks applied to it.
* **Two CORS headers merged into one invalid header.** The Lambda function URL sets CORS, and so did our handler. `curl` passed, the preflight passed, our whole SDK suite passed. Only real browsers failed, because CORS is enforced by browsers and nothing else. Every check we had was on the wrong side of it.
* **Our own SDK invented a conflict that never happened.** It retried a 5xx on a commit that had already applied. The retry hit the version guard, saw its own earlier write, and reported that someone else had moved the row. Retries are GET only now.
* **Changefeeds do an initial scan by default**, so our first run re adjudicated all of history: 22 batches and 25,000 tokens. Nothing broke, because a unique index made every replay a no op, but it was real money spent on nothing.

## Accomplishments that we're proud of

**We published where it loses.** Below a certain amount of reasoning per task, adjudicating costs more than simply retrying. So we say plainly: below that line, do not use this. That losing region is shaded on our chart instead of cropped out of it, and `npm run compare -- --reasoning 400` prints in red that INTERLOCK costs more. A demo that can only produce good news is not evidence.

**We publish the number that contradicts us.** Our own audit feed is about 70% "invalidating", while our page says most conflicts are irrelevant. Both are true, because every row in that feed came from a demo, a test or a benchmark, and all three construct a real conflict on purpose. Our API returns that caveat right next to the counts, so anyone who checks finds it already explained.

**Exactly once is structural, not conventional.** A unique index on the commit and intent pair means a double apply fails loudly rather than quietly doing damage. It survived a chaos drill that kills every in flight connection mid adjudication, across 12 kill waves, with all four invariants holding. It then paid for itself again by making SQS at least once delivery safe with no extra code.

**Tenant isolation is proven, not asserted.** We run two tenants whose intents measure a cosine distance of 0.0000, meaning identical text. The vector path would certainly have matched across tenants if the filter lived outside the query. Anyone can re prove this on their own key in about fifteen seconds.

## What we learned

The economics turned out to be the opposite of what we assumed when we started. Adjudicating a conflict costs roughly a fixed amount. Re running a task costs in proportion to how much reasoning you are throwing away. So the honest claim is not "this is always cheaper". It is a regime. Above a certain amount of reasoning per task, this wins, and below it you should just retry. Finding that crossover took three legitimate optimisations and one workload redesign, and we published all of it.

The deeper lesson is sitting in our own bug list. Most of those twelve failures were silent. The code ran, gave plausible answers, and was wrong the whole time. That is exactly the failure an agent hits when the world moves underneath it while it is thinking. We arrived at our own thesis the hard way, in our own build, which is not the way we would have chosen to learn it.

## What's next for INTERLOCK

The most useful next step is bring your own key, so a tenant can use their own model on their own bill. That is the honest ceiling on this service today.

After that, step level semantic matching. The plumbing already exists, but it is off by default because it currently costs more than it returns on the hot path. And adjudicator distillation, because the provenance graph already narrows the question so far before a model sees it that a much smaller model should be enough.

The impact we are actually chasing is broader than "agent fleets" in the abstract. This matters in any system where a language model writes to shared state. Coding agents working in one repository. Ops automations touching one runbook. Support bots working one ticket queue. All of these are shipping right now, and all of them currently handle collisions by either locking everything or throwing work away.

Every one of those is a place where a forty second thought is currently being discarded because one row moved. We would like that to stop being normal.
