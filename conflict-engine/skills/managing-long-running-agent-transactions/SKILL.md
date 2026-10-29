---
name: managing-long-running-agent-transactions
description: Guides modelling LLM agent work as declared intents in CockroachDB so concurrent agents can share state safely without holding locks across inference. Covers provenance graphs, semantic conflict detection with vector indexes, point-in-time snapshot diffing, exactly-once adjudication, and the cost economics that decide whether this approach pays. Use when multiple AI agents write to the same rows, when agent tasks span seconds to minutes of model inference, when optimistic retry is discarding expensive reasoning, or when designing an agent memory layer on CockroachDB.
compatibility: "CockroachDB >= 25.2 for C-SPANN vector indexes. Serializable isolation (the default) is assumed throughout. Multi-region survival goals require at least 3 regions."
metadata:
  author: interlock
  version: "1.0"
---

# Managing Long-Running Agent Transactions

An LLM agent's unit of work is not a database transaction. It reads shared state, spends seconds to minutes on inference, then writes. Classical concurrency control assumes the gap between read and write is small and the read-set is knowable in advance; neither holds here.

This skill covers how to model that work in CockroachDB so concurrent agents stay correct without either blocking each other or discarding expensive reasoning.

## Core Concept

Two standard approaches both fail at agent timescales:

| Approach | Failure at agent timescales |
|---|---|
| **Two-phase locking** | The lock is held across a full inference. Every other agent touching that row waits out someone else's model call. |
| **Optimistic retry** | A single conflicting write discards the entire task, including all reasoning already paid for. |

The alternative rests on a property classical transactions never had: **an agent can read the conflicting write and judge whether it actually invalidates its plan.** Most conflicts do not. A real conflict usually invalidates only some of the plan's steps.

That reframes conflict handling as: detect precisely, judge cheaply, repair narrowly.

## Modelling the work

Declare the intent **before** acting, in a serializable transaction:

```sql
CREATE TABLE intent (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id   UUID NOT NULL REFERENCES agent (id),
  status     STRING NOT NULL DEFAULT 'open',
  statement  STRING NOT NULL,          -- the plan, in natural language
  embedding  VECTOR(1024),             -- the same plan, in vector space
  read_hlc   DECIMAL NOT NULL,         -- cluster_logical_timestamp() at read
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to   TIMESTAMPTZ
);

CREATE TABLE plan_step (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id UUID NOT NULL REFERENCES intent (id) ON DELETE CASCADE,
  seq       INT4 NOT NULL,
  status    STRING NOT NULL DEFAULT 'pending',
  UNIQUE (intent_id, seq)
);

-- (from_kind, from_id) -> (to_kind, to_id) expresses both
-- "step derived from resource" and "step derived from step"
CREATE TABLE provenance_edge (
  from_kind STRING NOT NULL, from_id UUID NOT NULL,
  to_kind   STRING NOT NULL, to_id   UUID NOT NULL,
  PRIMARY KEY (from_kind, from_id, to_kind, to_id),
  INDEX provenance_reverse_idx (to_kind, to_id)
);
```

**Capture `read_hlc` inside the same transaction as the reads.** `cluster_logical_timestamp()` returns a DECIMAL that can be fed directly to `AS OF SYSTEM TIME` later. If it is captured outside the transaction it describes a different snapshot than the one the agent saw, and every diff built on it is subtly wrong.

**Steps must be rows, not a JSON blob.** "Repair only the dependent steps" is only expressible if steps have their own identity and their own provenance edges.

## Detecting conflicts

Three paths, one query, one snapshot:

```sql
WITH RECURSIVE
  c AS (SELECT resource_id, new_version, embedding FROM commit_log WHERE id = $1),

  -- 1. Read this row at an older version
  exact AS (
    SELECT ir.intent_id, 'exact' AS how, NULL::FLOAT8 AS distance
    FROM intent_read ir JOIN c ON ir.resource_id = c.resource_id
    JOIN intent i ON i.id = ir.intent_id
    WHERE i.status = 'open' AND ir.observed_version < c.new_version
  ),

  -- 2. Anything transitively derived from the changed resource
  descendants AS (
    SELECT pe.to_kind, pe.to_id FROM provenance_edge pe
    JOIN c ON pe.from_id = c.resource_id WHERE pe.from_kind = 'resource'
    UNION
    SELECT pe.to_kind, pe.to_id FROM provenance_edge pe
    JOIN descendants d ON pe.from_kind = d.to_kind AND pe.from_id = d.to_id
  ),
  derived AS (
    SELECT DISTINCT ps.intent_id, 'graph', NULL::FLOAT8
    FROM descendants d JOIN plan_step ps ON d.to_kind = 'step' AND ps.id = d.to_id
  ),

  -- 3. Semantically close plans that share no rows at all
  semantic AS (
    SELECT i.id, 'vector', (i.embedding <=> (SELECT embedding FROM c))
    FROM intent i
    WHERE i.status = 'open' AND i.embedding IS NOT NULL
    ORDER BY i.embedding <=> (SELECT embedding FROM c)
    LIMIT $2
  )
SELECT * FROM exact
UNION ALL SELECT * FROM derived
UNION ALL SELECT * FROM semantic WHERE distance <= $3;
```

The third path is why this belongs in CockroachDB rather than beside it. The vector search and the graph walk execute against the **same transactional snapshot**. A separate vector store reintroduces exactly the consistency gap the system exists to close: a commit visible to one and not the other silently produces the wrong blast radius.

### Choose the distance operator before choosing the threshold

CockroachDB offers `<->` (L2), `<=>` (cosine) and `<#>` (negative inner product). **A threshold calibrated for one silently disables detection under another.** On normalised Titan embeddings, the same "directly conflicting" pair measures **0.52 in cosine and 1.02 in L2** — so a 0.58 cosine threshold applied to `<->` matches nothing, and the semantic path fails silently rather than loudly.

Calibrate against pairs whose relationship you already know:

| Relationship | cosine (`<=>`) |
|---|---|
| Same meaning, different words | 0.29 |
| Directly conflicting | 0.52 ← must catch |
| Same domain, unrelated | 0.64 ← must ignore |
| Different domain | 0.93 |

Put the threshold in the gap that matters (~0.58 here), and err toward adjudicating: a false positive costs one cheap model call, a false negative lets a corrupted plan commit.

## Diffing against the agent's snapshot

```sql
SELECT body, version FROM resource
AS OF SYSTEM TIME <read_hlc>
WHERE id = $1;
```

**The garbage-collection window bounds this.** When the snapshot is older than the GC window the read fails, so keep bitemporal columns (`valid_from`/`valid_to` alongside `recorded_at`) as the durable source of truth and treat `AS OF SYSTEM TIME` as the precise-but-bounded path. Report which source produced a diff rather than letting the fallback masquerade as the exact answer.

## Let the graph answer before the model does

Before invoking a model, ask the provenance graph which steps descend from the changed resource. **If none do, the answer is "irrelevant" and no inference is needed.** In practice this removes a large share of model calls outright, and narrows the prompt for the rest to the candidates the graph identified.

This is the division of labour worth preserving: exact machinery where exactness is available, judgement only where judgement is genuinely required.

## Make exactly-once structural

Adjudication must be idempotent, because retry-on-failure and never-double-apply are otherwise in direct tension — a connection that dies after the insert but before acknowledgement will be retried.

```sql
CREATE UNIQUE INDEX adjudication_once_idx ON adjudication (commit_id, intent_id);
```

```sql
INSERT INTO adjudication (...) VALUES (...)
ON CONFLICT (commit_id, intent_id) DO NOTHING
RETURNING id;
```

An empty `RETURNING` means an earlier attempt already ruled; treat that as a no-op rather than an error. A `UNIQUE` index turns "we try not to double-apply" into "we cannot".

## Multi-region locality

Survival and latency pull in opposite directions, so assign locality per table rather than globally:

```sql
ALTER DATABASE app SURVIVE REGION FAILURE;              -- needs >= 3 regions

ALTER TABLE agent        SET LOCALITY GLOBAL;                        -- read everywhere
ALTER TABLE adjudication SET LOCALITY REGIONAL BY TABLE IN PRIMARY REGION;
ALTER TABLE resource     SET LOCALITY REGIONAL BY TABLE IN "aws-us-east-1";
```

Decision records should survive a region loss — an adjudication that vanishes with a datacentre is the failure this design exists to prevent. Hot contended state can stay homed in one region so writes stay local. Two regions can only ever give you `SURVIVE ZONE FAILURE`; there is no quorum left when one of two dies.

## When NOT to use this

**This approach loses on cheap tasks, and the crossover is measurable.**

Adjudication costs roughly a fixed amount per conflict. Re-running a task costs in proportion to how much reasoning it discards. Below the point where those meet, optimistic retry is simply the better engineering choice.

In one measured workload the crossover sat near **15,000 tokens of reasoning per task**: below it, adjudication cost 3.57× serial against optimistic retry's 2.04×; above it, 1.28× against 2.01×.

Measure your own crossover before adopting this. If your agent tasks are short, do not build any of it — retry.

## Implementation traps

- **`INT8` arrives as a string in node-postgres.** `version + 1` on `"1"` yields `"11"`, silently, with no error and a plausible-looking result. Set a type parser with a `Number.isSafeInteger` guard.
- **Empty tables make the planner ignore vector indexes.** A full scan of a few rows is genuinely cheaper, so "is the index used?" is only a meaningful question at realistic volume.
- **Retry serialization failures with jittered backoff.** Without jitter, two conflicting agents retry in lockstep and collide again on exactly the same schedule.

## References

- [CockroachDB transaction retry errors](https://www.cockroachlabs.com/docs/stable/transaction-retry-error-reference)
- [AS OF SYSTEM TIME](https://www.cockroachlabs.com/docs/stable/as-of-system-time)
- [Vector indexes](https://www.cockroachlabs.com/docs/stable/vector-indexes)
- [Multi-region survival goals](https://www.cockroachlabs.com/docs/stable/multiregion-survival-goals)
- Reference implementation: [INTERLOCK](https://github.com/usv240/interlock)
