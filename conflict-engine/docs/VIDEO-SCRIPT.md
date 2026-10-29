# 3-minute demo video — shot list

**Hard rules from the submission requirements:** under 3 minutes · shows the project functioning · **must include footage showing the CockroachDB memory layer at work** · public on YouTube or Vimeo · no third-party trademarks or copyrighted music.

**Before recording**
- `npm run cdc:start` so the async pipeline is live
- Two browser tabs: the demo page, and a terminal
- Terminal font ≥ 16pt — judges may watch on a laptop
- Dark theme (the page defaults to system; force dark for contrast on video)
- Record at 1080p minimum. No music. Your voice only.

**Total target: 2:45.** Leaving 15s of headroom means an overrun doesn't cost you the ending.

---

## 0:00 – 0:22 · The problem

**Screen:** the hero, then scroll slowly to the stat card.

> "An AI agent reads shared memory. Thinks for forty seconds. Then acts. But the world changed while it was thinking.
>
> Measured across ten contended workloads, the standard fix — optimistic concurrency — runs at **0.93 times** the speed of running agents one at a time, at **1.83 times** the token cost. Running agents in parallel today is slower than not parallelising at all.
>
> Meanwhile the industry's answer to two agents editing the same state is a git merge conflict."

*Don't rush this. The 0.93× is the whole reason the project exists.*

---

## 0:22 – 1:20 · The live demo ⭐ **this is the required footage**

**Screen:** click **Run it**. Let it stream. Do not cut.

> "This runs against the production cluster right now. Nothing is pre-recorded.
>
> The Scheduler agent declares an intent before acting — its plan, its read-set, and a real 1024-dimension embedding from Titan. Twelve and a half thousand tokens of reasoning are now at risk.
>
> The Triage agent commits into the same queue. Depth goes 118 to 131, serializable.
>
> Now watch the memory layer work."

**Expand the `SQL that ran` panel on the detect step. Hold for 4 seconds.**

> "One query, three detection paths, one snapshot. A recursive CTE walks the provenance graph. An approximate-nearest-neighbour search over a C-SPANN vector index finds plans threatened by **meaning** — plans that share no rows at all. Both run inside the same transaction, so there is no consistency gap between them.
>
> It found the Scheduler by all three paths. Cosine distance 0.486.
>
> Then `AS OF SYSTEM TIME` replays the exact snapshot the agent read and diffs it against now."

**Expand the `prompt` panel briefly.**

> "The graph has already narrowed the question, so the model only judges the candidates that actually descend from the change.
>
> Verdict: invalidating. Two steps repaired. **Two steps preserved.** Under optimistic concurrency all four would have been thrown away and re-run."

---

## 1:20 – 1:50 · The honest result

**Screen:** scroll to the crossover chart.

> "But this does not always win, and the curve says where it does not.
>
> Below about fifteen thousand tokens of reasoning per task, adjudicating costs more than simply retrying — so don't use this, just retry. That region is shaded on the chart rather than cropped out.
>
> Above it, the saving grows with the cost of the task: 1.28× against optimistic concurrency's 2.01×. Zero lost updates at every point, in every mode.
>
> Every number here came from `npm run bench:sweep` on a live cluster. You can re-run it."

*This section is worth 30 seconds. Publishing the failure region is the most credible thing in the submission.*

---

## 1:50 – 2:15 · Resilience

**Screen:** terminal — `npm run chaos`

> "Three regions, survival goal region. Three is the minimum: with two there is no quorum left when one dies.
>
> This drill destroys every in-flight database connection at random moments while agents are mid-adjudication."

**Let the PASS lines land on screen.**

> "Twelve kill waves. Exactly-once adjudication held — enforced by a unique index, not by convention. No orphaned repairs. The counter arithmetic still balances. Nothing stuck."

---

## 2:15 – 2:40 · It is a service

**Screen:** the *Use it* section. Type a name, click **Get an API key**.

> "This isn't just a demo. It's an API. Self-serve key, isolated tenant, instantly.
>
> The tenant filter lives **inside** the detection query, not around it — because a missed filter here wouldn't just leak a row, it would let one customer's commit adjudicate another customer's in-flight plans."

**Cut to terminal:** `npm run pipeline`

> "And commits don't block on adjudication. A CockroachDB changefeed streams to Lambda, EventBridge, SQS, and a worker that adjudicates in parallel. The event exists if and only if the row does."

---

## 2:40 – 2:45 · Close

**Screen:** the architecture diagram.

> "Agent memory as a concurrency substrate. Serializable by default, MVCC time travel, and a vector index in the same transaction — on CockroachDB, because nothing else gives you all three."

---

## Recording notes

- **If a live run fails on camera, keep it in.** The endpoint occasionally cold-starts. Saying "that's a cold start, running again" is more credible than a suspiciously perfect take.
- Speak about 15% slower than feels natural.
- The most important 10 seconds are the expanded **SQL panel** — that is literally the "memory layer at work" the rules require. Do not rush past it.
- Upload **unlisted first**, watch it once end to end, then make it public.

## After recording

- [ ] Under 3:00
- [ ] SQL panel clearly legible
- [ ] No music, no third-party logos beyond the AWS/CockroachDB names in our own UI
- [ ] Public on YouTube or Vimeo
- [ ] `npm run cdc:stop` to stop the changefeed and stop spending
