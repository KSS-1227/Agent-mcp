/**
 * Single source of truth for every number and claim on the site.
 *
 * INTEGRITY RULE: each figure carries an explicit `provenance`.
 *   "published" — measured by someone else, cited
 *   "measured"  — measured by our own benchmark harness on real runs
 *   "target"    — what we are aiming for; NOT yet measured
 *
 * The UI renders that label next to the number. We never let a target read as
 * a result. When the harness produces real numbers, flip provenance to
 * "measured" and paste them in — nothing else changes.
 */

export type Provenance = "published" | "measured" | "target";

export const CITATIONS = {
  coagent: {
    id: "arXiv:2606.15376",
    title: "CoAgent: Concurrency Control for Multi-Agent Systems",
    url: "https://arxiv.org/abs/2606.15376",
  },
  atm: {
    id: "arXiv:2607.00041",
    title: "ATM: CID-Brokered Pre-Write Admission for Multi-Agent Code Co-Synthesis",
    url: "https://arxiv.org/pdf/2607.00041",
  },
  anomalies: {
    id: "arXiv:2606.17182",
    title:
      "Verified Detection and Prevention of Concurrency Anomalies in Multi-Agent LLM Systems",
    url: "https://arxiv.org/pdf/2606.17182",
  },
  wasted: {
    id: "arXiv:2606.01365",
    title:
      "Early Diagnosis of Wasted Computation in Multi-Agent LLM Systems via Failure-Aware Observability",
    url: "https://arxiv.org/html/2606.01365v2",
  },
} as const;

/** The three approaches, as measured in CoAgent across 10 contended workloads. */
export type Approach = {
  key: string;
  name: string;
  blurb: string;
  /** Multiple of serial execution speed. >1 is faster than running one at a time. */
  speedup: number;
  /** Multiple of serial execution token cost. 1.0 = no overhead. */
  tokenCost: number;
  failure: string;
  provenance: Provenance;
  /** True for the row the chart is about — drives the emphasis encoding. */
  emphasis?: boolean;
};

export const APPROACHES: Approach[] = [
  {
    key: "2pl",
    name: "Two-phase locking",
    blurb: "Hold locks for the whole task.",
    speedup: 1.04,
    tokenCost: 1.0,
    failure: "0.81 deadlocks per trial",
    provenance: "published",
  },
  {
    key: "occ",
    name: "Optimistic concurrency",
    blurb: "Abort and re-run the entire task on any conflict.",
    speedup: 0.93,
    tokenCost: 1.83,
    failure: "0.95 aborts per trial",
    provenance: "published",
  },
  {
    key: "interlock",
    name: "INTERLOCK",
    blurb: "Adjudicate semantically; repair only the dependent steps.",
    speedup: 1.4,
    tokenCost: 1.28,
    failure: "0 lost updates",
    provenance: "measured",
    emphasis: true,
  },
];

/**
 * Our own measured crossover, from `npm run bench:sweep` on the live cluster.
 *
 * The honest claim is a regime, not a win. Adjudication costs roughly a fixed
 * amount per conflict; re-running a task costs in proportion to how much
 * reasoning it discards. Below the crossover there is nothing worth protecting
 * and retrying is the better engineering choice — so that region is published
 * too, rather than cropped out.
 */
export const CROSSOVER = {
  unit: "tokens of reasoning per task",
  // Re-measured after the adjudicator changes (cheap tier by default, the
  // provenance pre-filter answering "irrelevant" with no inference). Four
  // points now rather than three, because the extra one at 9,780 is the
  // interesting one: it is where the two approaches are almost level, and a
  // curve that jumps straight from -76% to +27% hides where the decision
  // actually gets difficult.
  points: [
    { reasoning: 3_357, occ: 2.06, interlock: 3.61, winner: "occ" as const },
    { reasoning: 9_780, occ: 2.03, interlock: 2.12, winner: "occ" as const },
    { reasoning: 23_531, occ: 2.01, interlock: 1.47, winner: "interlock" as const },
    { reasoning: 37_307, occ: 2.01, interlock: 1.31, winner: "interlock" as const },
  ],
  // Interpolated between the two points that straddle it: at 9,780 INTERLOCK is
  // 0.09x worse, at 23,531 it is 0.54x better. Published as ~12,000 rather than
  // the precise interpolation, because four sampled points do not justify four
  // significant figures.
  crossoverAt: 12_000,
  anomalies: 0,
  provenance: "measured" as Provenance,
};

/** Verified against the live cluster by `npm run db:verify` / `npm run continuity`. */
export const VERIFIED = [
  { claim: "Isolation", value: "serializable", how: "SHOW default_transaction_isolation" },
  { claim: "Regions", value: "3 (us-east-1, us-east-2, us-west-2)", how: "SHOW REGIONS FROM DATABASE" },
  { claim: "Survival goal", value: "region", how: "SHOW DATABASES" },
  // Reported as a range on purpose. The probe walks backwards until a read
  // fails, so the answer moves with the garbage-collection window and how
  // recently the table was rewritten — 24h on a quiet table, 1h on a busy one.
  // Quoting the flattering number would misrepresent what a reader would see.
  {
    claim: "Time-travel reach",
    value: "1–24h, bounded by the GC window",
    how: "npm run continuity",
  },
  { claim: "Embedding dimensions", value: "1024 (Titan V2)", how: "live Bedrock invocation" },
  // The claim this table existed to make and could not, until there was enough
  // volume to make it. The index is partial and tenant-prefixed, so selection
  // is a per-tenant question — the probe names the tenant it asked about.
  {
    claim: "Vector index actually selected",
    value: "yes, at ~1,700 in-flight plans",
    how: "npm run ai:vector",
  },
  {
    claim: "Tenant isolation",
    value: "0.0000 cosine, still not matched across tenants",
    how: "npm run test:isolation",
  },
  {
    claim: "Spend ceiling",
    value: "enforced per tenant and service-wide",
    how: "GET /v1/health",
  },
  { claim: "Lost updates", value: "0 across every benchmark mode", how: "counter arithmetic" },
  { claim: "Exactly-once adjudication", value: "held under repeated connection kills", how: "npm run chaos" },
] as const;

/** Headline figures for the KPI row. */
export type Kpi = {
  label: string;
  value: string;
  unit?: string;
  caption: string;
  provenance: Provenance;
  tone?: "neutral" | "bad" | "good";
  info: { title: string; what: string; how: string; note?: string };
};

export const KPIS: Kpi[] = [
  {
    label: "Parallel vs serial speed",
    value: "0.93",
    unit: "×",
    caption: "Optimistic concurrency is slower than not parallelising at all",
    provenance: "published",
    tone: "bad",
    info: {
      title: "Speedup below 1.0",
      what: "How fast a fleet of parallel agents finishes compared with running the same agents one after another.",
      how: "Anything below 1.0 means parallelism is actively hurting. Optimistic concurrency measures 0.93× because aborted agents re-run from the beginning, and the re-runs cost more than the parallelism saved.",
      note: `Measured across 10 contended workloads in ${CITATIONS.coagent.id}.`,
    },
  },
  {
    label: "Token cost of parallelism",
    value: "1.83",
    unit: "×",
    caption: "83% more inference spend, for negative speedup",
    provenance: "published",
    tone: "bad",
    info: {
      title: "1.83× token cost",
      what: "Total tokens consumed by the parallel fleet relative to running the same work serially.",
      how: "When an agent aborts, every token it already spent reasoning is discarded and re-spent. At a 0.95 abort rate per trial, most of that 83% overhead is re-doing thinking that was already done.",
      note: "This is the number INTERLOCK exists to remove.",
    },
  },
  {
    label: "Failures from misalignment",
    value: ">1/3",
    caption: "Share of multi-agent failures traced to inter-agent conflict",
    provenance: "published",
    tone: "bad",
    info: {
      title: "Inter-agent misalignment",
      what: "Failures caused not by a bad model or a bad prompt, but by two agents acting on incompatible views of shared state.",
      how: "An audit of over 200 multi-agent traces attributed more than a third of all observed failures to this class. It is the single largest failure category that better prompting cannot fix.",
      note: `Reported in ${CITATIONS.coagent.id}.`,
    },
  },
  {
    label: "Tokens burned after the warning",
    value: "58.1",
    unit: "%",
    caption: "Spend that continues after a run is already doomed",
    provenance: "published",
    tone: "bad",
    info: {
      title: "Post-warning spend",
      what: "In runs that ultimately failed, the proportion of tokens spent after the first detectable warning sign appeared.",
      how: "Nothing stops the run at the warning, so the agent keeps reasoning confidently toward a result that will be thrown away. Detecting the conflict at the moment it happens is what converts this waste into a repair.",
      note: `Reported in ${CITATIONS.wasted.id}.`,
    },
  },
];

/** The five-step mechanism. */
export type Step = {
  n: number;
  name: string;
  summary: string;
  feature: string;
  info: { title: string; what: string; how: string; note?: string };
};

export const STEPS: Step[] = [
  {
    n: 1,
    name: "Declare",
    summary:
      "Before acting, an agent writes an intent: what it read, and what it plans to do — as text and as an embedding.",
    feature: "Serializable write + vector column",
    info: {
      title: "Intents",
      what: "A durable, queryable record of what an agent is about to do and what it is depending on, written before it acts.",
      how: "The agent emits a short natural-language statement of its plan and read-set. We embed it with Amazon Titan and store text, embedding and a provenance link in one CockroachDB row, inside a serializable transaction.",
      note: "Classical concurrency control needs the read-set up front and can rarely get it. An LLM can simply say what it is depending on.",
    },
  },
  {
    n: 2,
    name: "Watch",
    summary:
      "When any agent commits, we find which in-flight agents are actually threatened — by meaning, not by row overlap.",
    feature: "C-SPANN distributed vector index",
    info: {
      title: "Semantic conflict detection",
      what: "Deciding which other agents a new write actually endangers.",
      how: "A recursive CTE walks the provenance graph for literal dependents, and an approximate-nearest-neighbour search over intent embeddings catches the paraphrased and derived ones that share no rows. Both run inside the same transaction.",
      note: "Because the vector index lives in the same database as the rows, there is no consistency gap between the graph query and the similarity query. A separate vector store cannot offer this.",
    },
  },
  {
    n: 3,
    name: "Diff",
    summary:
      "Show the threatened agent exactly what changed in the world since the snapshot it read.",
    feature: "AS OF SYSTEM TIME",
    info: {
      title: "Snapshot diffing",
      what: "A precise answer to 'what is different now versus when I looked?'",
      how: "Each agent records the timestamp of its read. We re-query that exact instant with AS OF SYSTEM TIME and diff it against the present, so the adjudicator sees only the delta rather than the whole world.",
      note: "The default garbage-collection window is 4 hours, so we also model validity intervals explicitly in the schema as the durable source of truth.",
    },
  },
  {
    n: 4,
    name: "Adjudicate",
    summary:
      "A model reads the diff and rules: irrelevant, invalidating, or fatal. Most conflicts are irrelevant.",
    feature: "Amazon Bedrock",
    info: {
      title: "Adjudication",
      what: "The judgement call that classical concurrency control cannot make — whether a conflicting write actually breaks this agent's plan.",
      how: "The diff, the intent and the plan go to Claude on Bedrock, which returns one of three verdicts. Irrelevant lets the agent proceed untouched. Invalidating triggers a repair of only the steps that depended on the changed fact. Fatal aborts.",
      note: "This is the substitution at the heart of the system: validation becomes reasoning instead of a version check.",
    },
  },
  {
    n: 5,
    name: "Commit",
    summary:
      "The final write lands as a genuine serializable transaction. Lost updates are impossible, not unlikely.",
    feature: "SERIALIZABLE by default",
    info: {
      title: "Serializable commit",
      what: "The guarantee that the concurrent execution is equivalent to some order of running the agents one at a time.",
      how: "CockroachDB defaults to SERIALIZABLE isolation, so the database itself refuses any interleaving that could produce a lost update. We do not implement this guarantee; we inherit it.",
      note: "PostgreSQL defaults to READ COMMITTED. Most vector databases have no transactions at all.",
    },
  },
];

/** Feature → why it is load-bearing. */
export const WHY_CRDB = [
  {
    feature: "SERIALIZABLE by default",
    need: "Two agents must never both win a write.",
    detail:
      "Correctness is inherited from the database rather than reimplemented in application code. PostgreSQL defaults to READ COMMITTED; most vector stores have no transactions at all.",
  },
  {
    feature: "MVCC + AS OF SYSTEM TIME",
    need: "Diff the agent's snapshot against the present.",
    detail:
      "This is the mechanism, not a convenience. Without point-in-time reads there is no way to show an agent what changed under it, and no way to reconstruct a past decision during review.",
  },
  {
    feature: "C-SPANN vector index",
    need: "Find semantically threatened agents.",
    detail:
      "Embeddings live in the same transactional database as the rows, so a similarity query and a graph query see identical state. A bolt-on vector store introduces exactly the consistency gap this system exists to close.",
  },
  {
    feature: "Multi-region survivability",
    need: "Adjudication cannot stop when a region does.",
    detail:
      "Agents contend across regions. If the arbiter's memory is unavailable, every agent in the fleet is unsafe at once — so the memory has to survive a region loss without losing a decision.",
  },
  {
    feature: "Changefeeds",
    need: "Notify without a second source of truth.",
    detail:
      "A changefeed on commit_log posts to Lambda, which publishes to EventBridge and on to an SQS worker. Publishing from the application instead would let 'the write succeeded' and 'the event was sent' disagree — a crash between them silently drops an adjudication. Reading the same durable log means an event exists if and only if the row does.",
  },
] as const;

export const REPO_URL = "https://github.com/usv240/interlock";

/**
 * The public API. INTERLOCK runs as a service, not just as a demo — this is the
 * same endpoint an external agent fleet would call, and the landing page is
 * simply its first consumer.
 */
export const API_URL =
  "https://wpvk3ox2bxo2w3zhxmx54ssjf40rakuz.lambda-url.us-east-1.on.aws/";
