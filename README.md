# Agent Safety MCP

**Two guarantees for agents that act: every consequential action is exactly-once, and every concurrent plan is repaired instead of discarded.**

A Model Context Protocol server that puts a durable action protocol and a conflict engine in front of PostgreSQL + pgvector (Supabase compatible). Agents declare what they are about to do, commit through the server, and recover from their own crashes without double-acting.

![status](https://img.shields.io/badge/status-implemented%2C%20offline--verified-informational)
![runtime](https://img.shields.io/badge/node-%E2%89%A518-3c873a)
![protocol](https://img.shields.io/badge/transport-stdio%20%7C%20http-4b5563)
![license](https://img.shields.io/badge/license-MIT-blue)

---

## Contents

- [Project origin and scope](#project-origin-and-scope)
- [The problem](#the-problem)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Guarantee 1 — exactly-once external actions](#guarantee-1--exactly-once-external-actions)
- [Guarantee 2 — conflict-safe concurrency](#guarantee-2--conflict-safe-concurrency)
- [MCP tool surface](#mcp-tool-surface)
- [Data model](#data-model)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [Testing](#testing)
- [Changes relative to upstream Anchor](#changes-relative-to-upstream-anchor)
- [Design decisions and trade-offs](#design-decisions-and-trade-offs)
- [Security](#security)
- [Current limitations](#current-limitations)
- [Documentation](#documentation)
- [License and credits](#license-and-credits)

---

## Project origin and scope

> **Disclosure.** The only upstream repository taken into this project is
> **`recovery-engine`** — *Anchor* (`github.com/virajchogle/anchor`, MIT). It is the
> project's baseline: its three-phase exactly-once protocol, idempotency-key
> derivation, verifier contract, effect-state model, and schema were taken as the
> starting point and **modified as required by this project** — ported from Go to
> TypeScript, retargeted from CockroachDB to PostgreSQL/Supabase with pgvector, and
> resurfaced as MCP tools with authorization and a conflict engine around it.
>
> The original Go tree is kept under [`recovery-engine/`](recovery-engine/) as the
> reference of record for side-by-side comparison. The modified implementation —
> the actual deliverable — lives in [`agent-safety-mcp/`](agent-safety-mcp/), and
> the per-concern change ledger is in
> [Changes relative to upstream Anchor](#changes-relative-to-upstream-anchor).

No other repository is part of this project's build. `conflict-engine/` is an
unmodified reference copy of published prior art kept for comparison only; nothing
under it is imported, compiled, or shipped. The conflict engine in
`agent-safety-mcp/src/conflict-engine/` is part of this project's implementation.

---

## The problem

Agent workloads fail in two ways that ordinary databases do not address.

| Failure | What goes wrong | What this project does |
|---|---|---|
| **Parallel agents, long reasoning** | Agent A reads a row, thinks for 40 seconds, writes. Agent B changed that row mid-flight. Classic optimistic concurrency discards all of A's work; locking makes B wait out a full inference. | Detects *who is actually threatened*, replays what changed, and repairs only the plan steps that the change invalidates. |
| **Crash between acting and recording** | The external API call succeeded, the process died before committing. Retrying acts twice; not retrying leaves memory blind to a change that really happened. | A durable intent log plus an external verifier establish ground truth. If the outcome cannot be attributed, the action escalates instead of retrying. |

The shared premise: **an agent's record of what it did must match what actually
happened in the world.** Writing the record correctly is not the hard part. Making
the record and the external effect agree — across crashes, retries, and concurrent
writers — is.

---

## Architecture

```mermaid
flowchart LR
    subgraph clients["MCP clients"]
        A["Agent runtime · IDE · CLI"]
    end

    subgraph server["agent-safety-mcp"]
        M["MCP server<br/>27 tools · fail-closed authorization"]
        C["Conflict engine<br/>declare · watch · diff · adjudicate"]
        P["Action protocol<br/>intend · execute · commit"]
        R["Reconciler<br/>claim · verify · resolve"]
        H["Health server"]
        S["Core model<br/>agents · resources · tasks"]
    end

    A -->|"stdio, or HTTP + Supabase JWT"| M
    M --> C
    M --> P
    M --> S
    P --> R
    C --> DB[("PostgreSQL + pgvector<br/>Supabase")]
    P --> DB
    R --> DB
    S --> DB
    C -.->|"only when the graph cannot rule"| L["Adjudicator<br/>Nemotron · Grok · Nebius · NVIDIA · none"]
    P -->|"github.create_issue"| X["External system<br/>GitHub REST API"]
    R -->|"outcome query by correlation marker"| X
    R -->|"episode embeddings"| O["Amazon Bedrock Titan Text Embeddings V2<br/>1024 dimensions"]
    H --> DB
```

Layers, top to bottom:

1. **Transport** — `stdio` for local MCP clients, `http` for remote clients with a
   Supabase JWT. A health server starts for both.
2. **Tool layer** — 27 MCP tools, every one wrapped by an authorization layer that
   fails closed: unknown tools, unauthenticated calls, and unauthorized agents are
   refused before any handler runs.
3. **Services** — a shared agent/resource/task model, a conflict engine, and the
   action protocol (coordinator + reconciler + verifier registry).
4. **Storage** — PostgreSQL with pgvector. Durable intents, leases, effect state,
   episodes, provenance, and embeddings all live in the same database, so the
   action record, the world state, and the memory row commit together.

---

## Repository layout

```text
.
├── agent-safety-mcp/            # The deliverable — TypeScript MCP server
│   ├── src/
│   │   ├── actions/             # Exactly-once protocol: coordinator, reconciliation,
│   │   │                        #   idempotency, verifier registry, GitHub verifier
│   │   ├── conflict/            # Conflict engine: intents, detection, provenance, vectors
│   │   ├── core/                # Shared agent / resource / task model
│   │   ├── mcp/                 # Server, transports, tool registrations, authorization
│   │   ├── auth/                # JWT verification, user→agent mapping, permissions
│   │   ├── providers/           # Adjudication providers (Grok, Nebius, NVIDIA, Nemotron)
│   │   ├── config/              # Environment validation, entrypoint-only .env loading
│   │   ├── database/            # PostgreSQL client
│   │   ├── health/              # Health server and checks
│   │   └── scripts/             # Migration runner
│   ├── supabase/migrations/     # 18 schema migrations (pgvector, tables, constraints)
│   ├── scripts/demo.ts          # End-to-end demo / seed entrypoint
│   └── tests/                   # Offline suites by default; live DB suites are opt-in
│
├── recovery-engine/              # Original Anchor upstream baseline (Go, MIT)
├── conflict-engine/              # Original Interlock reference copy — not built, not shipped
├── design.md                    # Durable external-effect protocol design (effect states)
└── migrate-direct.mjs           # One-off operator helper for the effect-state migration
```

---

## Guarantee 1 — exactly-once external actions

Ported from Anchor. The three phases are exposed as three MCP tools, so an agent
cannot skip the intent write by forgetting to call it.

```mermaid
flowchart LR
    I["prepare_action<br/>INTEND"] --> E["external call<br/>EXECUTE"]
    E --> C["complete_action<br/>COMMIT<br/>intent + world + memory<br/>one transaction"]
    E -. "process dies here" .-> X{{"World may have changed.<br/>Nothing recorded it."}}
    X --> V["reconcile_action<br/>ask the external system"]
    V -->|"attributable proof"| C
    V -->|"no proof"| U{{"UNKNOWN → ESCALATED<br/>a human decides"}}
```

### Phase 1 — Intend (`prepare_action`)

- `idem_key = sha256(length-prefixed(episode_id, action_type, canonical_json(args)))`.
  Keys are byte-identical across processes, so
  `INSERT ... ON CONFLICT DO NOTHING` is a real deduplication primitive rather than
  a best effort. Canonical JSON sorts keys by byte order, normalizes number
  spelling, and rejects non-ASCII keys.
- The caller receives a **disposition** and may act only on `OWNED`:

| Disposition | Meaning | Permitted next step |
|---|---|---|
| `OWNED` | This caller inserted the intent and holds a live lease. | Execute the external call. |
| `ALREADY_COMMITTED` | An identical action already completed. The recorded outcome is returned. | Nothing; return the outcome. |
| `BUSY` | Another agent holds a live lease. | Back off and re-read. |
| `ORPHANED` | A `PENDING` intent exists whose lease expired — someone began it and died. | Only the reconciler may resolve it. |
| `FAILED` | A previous attempt was verified as not applied, or could not be resolved. | Surface to an operator; never silently retry. |

Before any episode or action row is written, `prepare_action` also runs the
**deterministic conflict gate** (see below). Model availability cannot authorize an
action or clear a conflict.

### Phase 2 — Execute (`execute_github_issue`)

The external call may change the world and still return an error. That possibility
is why phase 3 cannot be assumed to run. The shipped end-to-end action is
`github.create_issue`, verified through the GitHub REST API.

### Phase 3 — Commit (`complete_action`)

Intent resolution, world-state mutation, and the episode row with its embedding are
written in **one transaction**. A commit that may or may not have landed raises
`AmbiguousCommitError` and is routed to the reconciler rather than retried blindly.

### Effect state is tracked separately from status

Action status (`PENDING → COMMITTED | FAILED | ESCALATED`) answers *is this action
done?* Effect state answers *what happened to the external call?*

```text
status:  PENDING ──────────────────────────────▶ COMMITTED | FAILED | ESCALATED
effect:  NOT_STARTED → IN_PROGRESS → { APPLIED, NOT_APPLIED, UNKNOWN }
```

Keeping them separate is what makes the awkward window recoverable: a crash after
the effect landed but before the commit leaves `effect_state=APPLIED` with
`status=PENDING`, and recovery can re-commit without calling the external system
again. The full state machine, crash-window analysis, and schema are in
[`design.md`](design.md) and migration `20240101000015_phase_10f_effect_state.sql`.

### Verdicts are three-valued, and that is the point

| Verdict | Evidence | Resolution |
|---|---|---|
| `APPLIED` | The external system confirms *this* intent ran. | Commit to `COMMITTED`. |
| `NOT_APPLIED` | The external system confirms it did not run. | Mark `FAILED`. |
| `UNKNOWN` | No attributable evidence: timeout, incomplete listing, unsupported query. | Escalate to a human. **Never retry.** |

A verifier that reads "the resource exists" cannot attribute the change to this
call. Returning `APPLIED` there manufactures false history; returning `NOT_APPLIED`
causes a double action. So the GitHub verifier matches on a marker embedded in the
issue body and returns `UNKNOWN` whenever an incomplete listing cannot prove
non-application.

### Retry policy

- **Retriable serialization failures**: replay the SQL only — never the external call.
- **Ambiguous commit / connection loss after send**: do not replay. Route to the
  reconciler, which establishes ground truth first.
- **`UNKNOWN`**: never retried, by construction. `effect_state` has no transition
  back to `NOT_STARTED` or `IN_PROGRESS`.

---

## Guarantee 2 — conflict-safe concurrency

The conflict engine treats a conflict as a question about the plan, not about row
versions: *does what changed actually invalidate my work?* Most of the time it does
not, and when it does, usually only part of the plan breaks.

| Step | Tool | What happens |
|---|---|---|
| 1. **Declare** | `declare_intent` | The agent records what it read (`intent_reads` with observed versions), its plan steps, and a one-sentence statement — before acting. |
| 2. **Watch** | `check_threatened` | Given a resource change, find which open intents are threatened: exact version match, provenance-graph descendants, and semantic similarity over embeddings. |
| 3. **Diff** | `diff_intent_vs_resource` | Show what moved under the intent relative to the version it observed. |
| 4. **Adjudicate** | `check_conflict`, `adjudicate_conflict` | Rule the conflict `irrelevant`, `invalidating`, or `fatal`, naming affected steps versus preserved steps. The provenance graph rules first and free; a model is consulted only when the graph cannot settle it. |
| 5. **Resolve** | caller | The ruling is returned with step granularity. The MCP layer analyzes and reports; the agent repairs the steps that died. |

**The gate.** `prepare_action` refuses a step that is invalidated or that the
deterministic analysis (provenance + version tracking only) lists as affected by a
change since the intent was declared. Conflict handling therefore cannot be skipped
by asking a different endpoint, and a model's opinion cannot wave an action through.

---

## MCP tool surface

27 tools, all authorization-wrapped. `register_agent` and `reconcile_action` are
system-only, gated by `SYSTEM_AGENT_IDS`.

**Agents**

| Tool | Purpose |
|---|---|
| `register_agent` | Register a new agent (system-only). |
| `get_agent` / `list_agents` / `update_agent` | Read and update agent records. |

**Resources and tasks**

| Tool | Purpose |
|---|---|
| `register_resource` | Register a resource agents may read or modify. |
| `get_resource` / `list_resources` / `update_resource` | Read and update versioned resources. |
| `create_task` / `get_task` / `list_tasks` / `update_task_status` | Task lifecycle. |

**Intents and conflicts**

| Tool | Purpose |
|---|---|
| `declare_intent` | DECLARE: plan, reads, and statement, before acting. |
| `get_intent` / `list_intents` / `append_intent_steps` | Inspect and extend an intent. |
| `check_threatened` | WATCH: who is threatened by a resource version change. |
| `diff_intent_vs_resource` | DIFF: what changed for an intent since it was declared. |
| `check_conflict` | WATCH → DIFF → ADJUDICATE for a single intent. |
| `adjudicate_conflict` | Rule a conflict and name affected/preserved steps. |

**Actions**

| Tool | Purpose |
|---|---|
| `prepare_action` | INTEND: dedupe, lease, conflict gate, durable intent. |
| `execute_github_issue` | EXECUTE: perform a prepared `github.create_issue` once, then verify. |
| `complete_action` | COMMIT: atomic intent + world + memory write. |
| `get_action_status` | Status, effect state, and verifier evidence. |
| `reconcile_action` | Verify external ground truth and resolve an orphan (system-only). |

**Operational**

| Tool | Purpose |
|---|---|
| `get_intent_status` | Detailed status of one intent. |
| `query_open_work` | Summary of open intents and in-flight actions. |

---

## Data model

18 migrations in `agent-safety-mcp/supabase/migrations/`, applied in order. The
load-bearing invariants:

| Invariant | Where |
|---|---|
| One action row per logical action | `UNIQUE(idempotency_key)` on `actions` |
| A lease has exactly one owner | `lease_owner`, `lease_expires_at`, expiry index for the reconciler |
| Status and effect progress cannot drift into impossible states | `CHECK` constraints on `actions.status` and `actions.effect_state` |
| Verifier evidence is all-or-nothing | `verifier_response` and `verified_at` must both be set or both be null |
| Plans are replayable at step granularity | `intents`, `intent_reads`, `intent_steps`, `conflicts` |
| Resource versions are snapshotted at prepare time | `action_resource_versions` |
| Memory is written with the action, not after it | `episodes` (narrative, outcome, embedding), committed in the phase-3 transaction |

Core tables: `agents`, `tasks`, `resources`, `intents`, `intent_reads`,
`intent_steps`, `conflicts`, `actions`, `action_evidence`, `episodes`,
`managed_clusters`, `auth_users`, `action_resource_versions`. A dedicated
`test_external_ledger` table exists so external-effect behavior can be exercised
without touching a real external system.

---

## Getting started

### Prerequisites

- Node.js 18+
- PostgreSQL with the `pgvector` extension — a Supabase project is supported
- A database role able to create extensions and tables; the migrations also expect
  the Supabase `anon` and `service_role` roles to exist

### 1. Install

```powershell
cd agent-safety-mcp
npm install
```

### 2. Configure

```powershell
Copy-Item .env.example .env
```

Fill in `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and (only if you
want LLM adjudication) a provider key. `.env` is read by the server entrypoint only;
`scripts/demo.ts` never reads it and never prints the connection string.

### 3. Apply the schema

Migrations are gated — they refuse to run unless explicitly enabled.

```powershell
$env:RUN_DATABASE_MIGRATIONS = "1"
$env:DATABASE_URL = "postgresql://user:pass@host:5432/db"
npm run db:migrate
```

The runner refuses to replay migrations against a schema that already has
application tables but no migration history. Point it at a clean database.

### 4. Seed and run the demo

```powershell
$env:RUN_DEMO = "1"; npm run db:seed   # bootstrap the system agent, prints its ID
$env:RUN_DEMO = "1"; npm run demo      # intent → prepare → complete → replay → conflict gate
```

Both commands write rows that they do not clean up. Use a disposable database.

### 5. Start the server

```powershell
npm run build
$env:SYSTEM_AGENT_IDS = "<system agent id>"
npm start
```

Transport defaults to `stdio`. For remote clients set `MCP_TRANSPORT=http`; the HTTP
transport requires a Supabase JWT and binds to `127.0.0.1` on `MCP_HTTP_PORT` (8080).
The health server listens on `HEALTH_PORT` (8081) for both transports.

### 6. Point an MCP client at it

```json
{
  "mcpServers": {
    "agent-safety": {
      "command": "node",
      "args": ["C:/path/to/agent-safety-mcp/dist/start-server.js"],
      "env": {
        "DATABASE_URL": "postgresql://user:pass@host:5432/db",
        "SUPABASE_URL": "https://your-project.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "<service-role-key>",
        "SYSTEM_AGENT_IDS": "<system agent id>"
      }
    }
  }
}
```

---

## Configuration

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | Yes (runtime) | PostgreSQL connection string (`postgresql://`). Must be present in the process environment. |
| `SUPABASE_URL` | Yes (`npm start`) | Supabase project URL; must be HTTPS. |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes (`npm start`) | Service-role key used by the Supabase client. |
| `SUPABASE_ANON_KEY` | Optional | Anon key for clients that need it. |
| `MCP_TRANSPORT` | Optional | `stdio` (default) or `http`. |
| `MCP_HTTP_PORT` / `HEALTH_PORT` | Optional | HTTP transport port (8080) and health port (8081). |
| `CONFLICT_LLM_PROVIDER` | Optional | Conflict Engine only; defaults to `nemotron`. Choose `nemotron`, `grok`, `nebius`, `nvidia`, or `none` to select the conflict adjudicator. This setting is independent of `LLM_PROVIDER`. |
| `LLM_PROVIDER` | Optional | Generic/legacy provider resolver; defaults to `grok`. The existing Grok 4.3 client continues to use AWS Bedrock Mantle with the existing model and credential settings. |
| `NEMOTRON_BASE_URL` | Required for Nemotron | Base URL of a separately deployed OpenAI-compatible Hugging Face Space or Inference Endpoint. No endpoint is assumed. |
| `NEMOTRON_MODEL`, `NEMOTRON_TIMEOUT_MS`, `NEMOTRON_MAX_OUTPUT_TOKENS`, `NEMOTRON_TEMPERATURE`, `NEMOTRON_SYSTEM_PROMPT` | Optional | Nemotron model and request controls. |
| `HF_TOKEN` | Optional | Hugging Face bearer token for endpoints that require authentication; keep server-side and out of frontend variables. |
| `BEDROCK_API_KEY` | Optional | Credential for the existing AWS Bedrock Mantle Grok 4.3 integration. `GROK_REASONING_EFFORT` and `GROK_TIMEOUT_MS` retain their existing behavior. |
| `NEBIUS_API_KEY` / `NVIDIA_API_KEY` | Optional | Credentials for their respective optional chat providers. A selected provider failure retains deterministic conflict handling. |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `BEDROCK_MODEL_EMBEDDINGS` | Optional | Existing AWS SDK credentials/region and Titan Text Embeddings V2 model used for recovery episode vectors. Titan continues to emit 1024 dimensions for the existing pgvector columns. |
| `NEBIUS_BASE_URL`, `*_MODEL`, `*_TIMEOUT_MS`, `*_MAX_OUTPUT_TOKENS` | Optional | Other provider endpoints and limits. |
| `SEMANTIC_THRESHOLD`, `SEMANTIC_K` | Optional | Vector similarity cutoff (`0.58`) and neighbour count (`10`). |
| `GITHUB_TOKEN` | Optional | Required by `execute_github_issue` and production verification. Use a fine-grained token scoped only to the configured repository; issue creation requires Issues: write and verifier lookup requires Issues: read. |
| `GITHUB_REPOSITORY` | Optional | Exact `owner/repository` allowed for `github.create_issue`; required alongside `GITHUB_TOKEN` to register its production verifier. |
| `SYSTEM_AGENT_IDS` | Optional | Comma-separated agent IDs allowed to call system-only tools. |
| `RUN_DATABASE_MIGRATIONS` | Gate | Must be `1` for `npm run db:migrate` to apply migrations. |
| `RUN_DEMO` | Gate | Must be `1` for `npm run demo` and `npm run db:seed` to write demo rows. |
| `LOG_LEVEL` | Optional | `debug` in the example file; `info` by default. |

Secrets are never logged, and startup validation reports missing variables without
echoing their values.

---

## Testing

The default suite is **offline**: it exercises the MCP tool layer, authorization
activation, action lifecycle, conflict detection, providers, and configuration with
no database contact.

```powershell
npm run typecheck
npm run test:run
```

Layout:

| Directory | Covers |
|---|---|
| `tests/mcp/` | Tool registry, authorization, and each action/conflict tool end to end at the handler boundary |
| `tests/recovery-engine/` | Idempotency keys, protocol phases, effect states, verifier dispatch, resource-version snapshots |
| `tests/conflict-engine/` | Detection, provenance, persistence across restart, provider selection |
| `tests/auth/` | JWT verification, user→agent mapping, cross-agent read isolation |
| `tests/providers/` | Grok, Nebius, NVIDIA, Nemotron adapters |
| `tests/config/`, `tests/health.test.ts` | Environment validation, entrypoint-only `.env` loading, health checks |
| `tests/integration/` | Live-database and subprocess-crash suites, **opt-in** |

Live suites are gated: they stay disabled unless `RUN_LIVE_DB_TESTS=1` and
`TEST_DATABASE_URL` are set, and some recovery suites have additional cleanup gates.
This is deliberate — a test run must never reach a shared database by accident.

---

## Changes relative to upstream Anchor

Anchor is the only upstream codebase in this project. This ledger records what was
kept, what changed, and what was intentionally left behind.

| Concern | Upstream Anchor (source in `recovery-engine/`) | This project |
|---|---|---|
| **Language / runtime** | Go 1.24, single binary, Lambda entrypoint | TypeScript on Node.js 18+, ESM, bundled with esbuild |
| **Interface** | HTTP operator panel, Live-run and Recall views | 27 MCP tools over `stdio`/`http`, plus a health endpoint |
| **Database** | CockroachDB: `SERIALIZABLE`, `AS OF SYSTEM TIME`, C-SPANN vector index, TTL, multi-region survival | PostgreSQL + pgvector on Supabase; replay by resource-version comparison instead of time travel |
| **Action surface** | `ccloud` CLI: scoped diagnostic SQL users | `github.create_issue` through the GitHub REST API |
| **Verification** | `ccloud audit list`, matched on a username derived from the idempotency key | Paginated GitHub issue listing, matched on a correlation marker in the issue body; an incomplete listing yields `UNKNOWN` |
| **Embeddings** | Bedrock Titan Text Embeddings V2, 1024 dimensions | `episodes.embedding` / `intents.embedding` at 1024 dimensions; adjudication providers are pluggable |
| **Concurrency** | Out of scope | Conflict engine added (declare/watch/diff/adjudicate) with a deterministic gate inside `prepare_action` |
| **Identity and authorization** | Scope isolation in SQL, Secrets Manager for credentials | JWT verification, user→agent mapping, per-tool fail-closed authorization, system-only tool set |
| **Schema** | 6 tables | 13 application tables across 18 migrations, including effect-state columns, verifier evidence, resource-version snapshots, and an external-effect test ledger |
| **Protocol shape** | 3 phases + effect states, verbatim in Go | Same three phases, dispositions, effect states, and three-valued verdicts in TypeScript (`agent-safety-mcp/src/recovery-engine/idempotency.ts`, `coordinator.ts`, `reconciliation.ts`) |
| **Not carried** | Panel UI, `cmd/bench`/`cmd/compare`, payments example, control experiment, Lambda/API Gateway deploy | Out of scope by design; the protocol is what was taken, not the demo site |

Determinism-sensitive code was ported exactly rather than reinterpreted:
`generateIdempotencyKey` and `canonicalJson` reproduce Anchor's length-prefixed
SHA-256 derivation, because a single byte of drift turns deduplication into double
execution.

---

## Design decisions and trade-offs

1. **`UNKNOWN` beats a guess.** Uncertainty escalates. The alternative — inferring
   success from world state — writes false history; inferring failure causes a
   double action. Both are worse than asking a human.
2. **Effect state is separate from action status.** One column cannot express "the
   effect is durable but the commit is not recorded yet", which is exactly the crash
   window recovery needs.
3. **The conflict gate is deterministic.** Provenance and version tracking decide
   whether an action may start. A model can explain a conflict; it cannot authorize
   an action.
4. **Status is persisted, not inferred.** Dispositions and effect states are
   compared-and-set in SQL with `WHERE` guards, so concurrent reconcilers cannot
   both win and stale workers fail loudly rather than silently overwriting.
5. **PostgreSQL instead of CockroachDB.** The trade is explicit: no
   `AS OF SYSTEM TIME`, so diffs replay from recorded resource versions instead of
   arbitrary historical snapshots, and no multi-region survival claim is made. In
   exchange the system runs on a managed Postgres/Supabase project with pgvector.
6. **One production action type, wired end to end.** `github.create_issue` is the
   action with a real executor *and* a real verifier. Depth was chosen over breadth:
   a second action type without attributable verification would only be a demo.
7. **Two layers, one model.** Agents, resources, and tasks are shared, so an action
   prepared from a plan step is the same row the conflict engine reasons about.

---

## Security

- **Fail-closed authorization.** Every tool is wrapped; the wrapper decides before
  the handler runs. Unknown tools and unauthenticated calls are rejected.
- **System-only operations.** `register_agent` and `reconcile_action` require the
  caller to be one of `SYSTEM_AGENT_IDS`.
- **Transport separation.** `stdio` is treated as local and unauthenticated; `http`
  requires a Supabase JWT and binds to loopback.
- **Secrets.** `.env` is loaded only by the entrypoint, never by the demo script;
  connection strings and keys are never printed, and startup validation reports
  missing variables without their values.
- **Explicit write gates.** Migrations and demo/seed writes require
  `RUN_DATABASE_MIGRATIONS=1` / `RUN_DEMO=1`; live tests require
  `RUN_LIVE_DB_TESTS=1` plus `TEST_DATABASE_URL`.
- **Least data.** Agents submit a one-sentence intent, a read set, and plan steps —
  the server does not need the agent's reasoning.

---

## Current limitations

- **Live-database verification is an operator step.** The offline suite is green
  without a database; migrations, real concurrency, and recovery against real rows
  must be exercised with a real `DATABASE_URL` before production use.
- **Postgres ≠ CockroachDB.** Version-based replay replaces `AS OF SYSTEM TIME`;
  there is no region-failure guarantee to test or claim.
- **Crash recovery needs an embedder and a verifier.** The recovery loop refuses to
  start without a production embedder, and automatic recovery is only meaningful for
  action types that have a registered verifier (today: GitHub).
- **The demo is not idempotent with respect to rows.** Seed and demo leave persistent
  records behind and must run against a disposable database.
- **MCP resolves nothing on the agent's behalf.** Conflict rulings are returned at
  step granularity; repairing or aborting the plan remains the caller's decision.
- **No panel, benchmarks, or deployment automation** were carried over from upstream.

---

## Documentation

| Document | Contents |
|---|---|
| [`design.md`](design.md) | Durable external-effect protocol: effect states, crash windows, schema, verifier contract, testing plan |
| [`agent-safety-mcp/SUPABASE_SETUP_GUIDE.md`](agent-safety-mcp/SUPABASE_SETUP_GUIDE.md) | Supabase project setup: database, roles, and connection details |
| [`agent-safety-mcp/PHASE-10G-FINAL-SUMMARY.txt`](agent-safety-mcp/PHASE-10G-FINAL-SUMMARY.txt) | Effect-state implementation summary |

---

## License and credits

MIT.

- **Anchor** — `github.com/virajchogle/anchor`, MIT. The exactly-once action
  protocol, idempotency derivation, verifier contract, and effect-state model are
  derived from this repository, which is included here and modified for this
  project's requirements.
- Anchor itself states that exactness against a non-idempotent external API is not
  achievable by retrying alone; this project keeps that constraint rather than
  papering over it.
