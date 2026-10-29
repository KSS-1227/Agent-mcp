import Nav from "@/components/Nav";
import Benchmark, { BenchmarkTiles } from "@/components/Benchmark";
import Crossover from "@/components/Crossover";
import Verified from "@/components/Verified";
import ArchitectureDiagram from "@/components/ArchitectureDiagram";
import LiveDemo from "@/components/LiveDemo";
import HeroVisual from "@/components/HeroVisual";
import UseIt from "@/components/UseIt";
import WhatYouGet from "@/components/WhatYouGet";
import ReproduceIt from "@/components/ReproduceIt";
import InfoButton from "@/components/InfoButton";
import { Card, Disclosure, Pill, Section, SectionHead } from "@/components/ui";
import { CITATIONS, REPO_URL, STEPS, WHY_CRDB } from "@/lib/content";

export default function Page() {
  return (
    <>
      <Nav />
      <main id="main" className="flex-1">
        <Hero />
        <Section id="try">
          <SectionHead
            eyebrow="Try it"
            title="Watch two agents collide"
            lede="This runs against the production cluster, right now. Not a recording — real embeddings, a real serializable commit, a real ruling, and the cost of producing it."
          />
          <div className="mt-10">
            <LiveDemo />
          </div>
        </Section>
        <Problem />
        <PriorArt />
        <Mechanism />
        <WhyCockroachDB />
        <Section id="benchmark" tone="raised">
          <SectionHead
            eyebrow="Benchmark"
            title="Where this pays, and where it doesn't"
            lede="Every figure carries its provenance. Published means somebody else measured it and we cite them. Measured means our harness produced it on a live cluster, and you can re-run it."
          />
          <BenchmarkTiles />

          {/* The curve leads. It is the actual result — including the region
              where this approach loses — and it used to sit below two bar charts
              that compare the same three approaches at a single point on it. */}
          <div className="mt-4">
            <Crossover />
          </div>

          {/* A cost claim should come with the command that reproduces it, in
              the same eyeline as the claim. */}
          <ReproduceIt />

          <Disclosure
            className="mt-4"
            summary="Head-to-head against both baselines"
            hint="throughput and token cost, at the top of the curve"
          >
            <Benchmark />
          </Disclosure>

          <Verified />
        </Section>
        <Architecture />
        <Section id="use-it" tone="raised">
          <SectionHead
            eyebrow="Use it"
            title="A referee for your agents, not a place to run them"
            lede="You keep your models, your prompts and your tools. INTERLOCK arbitrates the state two agents both touch — and nothing else."
          />
          <WhatYouGet />
          <UseIt />
        </Section>
        <ChaosDrill />
      </main>
      <Footer />
    </>
  );
}

/* -------------------------------------------------------------------------- */

function Hero() {
  return (
    <section
      id="top"
      className="relative overflow-hidden px-5 pb-16 pt-14 sm:px-8 sm:pb-20 sm:pt-20"
    >
      {/* Ambient field. Decorative only, and behind everything. */}
      <div className="gridlines" aria-hidden="true" />
      <div className="aura" aria-hidden="true" />

      <div className="relative z-10 mx-auto grid w-full max-w-6xl grid-cols-1 items-start gap-10 lg:grid-cols-[minmax(0,1fr)_400px] lg:gap-12">
        <div>
        <div className="rise pill">
          <span className="pill-dot pill-dot-live" aria-hidden="true" />
          CockroachDB × AWS — Build with Agentic Memory
        </div>

        <h1
          className="rise mt-7 text-[2rem] font-semibold leading-[1.08] text-ink sm:text-[3rem] lg:text-[3.5rem]"
          style={{ animationDelay: "60ms" }}
        >
          Parallel agents that think for forty seconds{" "}
          <span className="text-gradient">without corrupting each other.</span>
        </h1>

        <p
          className="rise mt-6 max-w-xl text-base leading-relaxed text-ink-2 sm:text-lg"
          style={{ animationDelay: "120ms" }}
        >
          An LLM agent reads shared memory, thinks for forty seconds, then acts.
          The world changed while it was thinking. Today you get two bad options:
          lock everything, or throw the thinking away. INTERLOCK adds a third.
        </p>

        <div
          className="rise mt-9 flex flex-wrap items-center gap-3"
          style={{ animationDelay: "180ms" }}
        >
          {/* The primary action is to *use* it, not to read about it. Everything
              else on this page argues; this one hands over a key. */}
          <a href="#use-it" className="btn btn-primary btn-lg">
            Get an API key
            <span aria-hidden="true">→</span>
          </a>
          <a href="#try" className="btn btn-secondary btn-lg">
            Watch two agents collide
          </a>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="btn btn-ghost btn-lg"
          >
            Source ↗
          </a>
        </div>

        <p
          className="rise mt-4 text-[12px] text-muted"
          style={{ animationDelay: "220ms" }}
        >
          Free, self-serve, no signup — the key is issued by the same cluster
          this page runs on.
        </p>
        </div>

        {/* Show the thing before explaining it. */}
        <div className="rise lg:pt-2" style={{ animationDelay: "240ms" }}>
          <HeroVisual />
        </div>
      </div>

      <div className="relative z-10 mx-auto w-full max-w-6xl">
        {/* The single stat that reframes the whole problem. */}
        <div
          className="rise card card-accent mt-12 p-6 sm:p-8"
          style={{ animationDelay: "300ms" }}
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-accent">
              The finding that started this
            </p>
            <InfoButton
              title="Where this number comes from"
              what="A measured comparison of concurrency-control strategies across ten workloads where multiple LLM agents contend for the same shared state."
              how="Each strategy ran the same workloads. Optimistic concurrency — the approach almost everything uses today — finished at 0.93× the speed of running the agents one at a time, while consuming 1.83× the tokens."
              note={`${CITATIONS.coagent.title} — ${CITATIONS.coagent.id}`}
            />
          </div>
          <p className="mt-4 max-w-4xl text-xl font-medium leading-snug text-ink sm:text-2xl">
            Running AI agents in parallel today is{" "}
            <span className="text-accent">slower</span> than running them one at
            a time &mdash; and costs{" "}
            <span className="text-accent">83% more</span>.
          </p>
          <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-2">
            You pay nearly double to go backwards. That is not a tuning problem;
            it is the reason parallel agents do not scale.
          </p>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */

function Problem() {
  const beats = [
    {
      t: "t = 0s",
      title: "Read",
      body: "The agent reads shared memory and forms a plan against that snapshot.",
      tone: "neutral" as const,
    },
    {
      t: "t = 0–40s",
      title: "Think",
      body: "Inference runs. Meanwhile another agent commits a write that touches the same state.",
      tone: "warn" as const,
    },
    {
      t: "t = 40s",
      title: "Act",
      body: "The agent acts on a world that no longer exists. Nothing raised an error.",
      tone: "bad" as const,
    },
  ];

  return (
    <Section id="problem" tone="raised">
      <SectionHead
        eyebrow="The problem"
        title="An agent's transaction is not a database transaction"
        lede={
          <>
            A database transaction is measured in milliseconds and its read-set
            is knowable up front. An agent&rsquo;s is measured in minutes of
            inference, and its read-set is broad and opaque. Classical
            concurrency control was not built for that shape.
          </>
        }
        info={{
          title: "Why the read-set matters",
          what: "The read-set is the collection of data a transaction depended on when it made its decision.",
          how: "Traditional concurrency control needs the read-set declared or inferable in advance so it can detect conflicts. With an LLM agent the read-set emerges from reasoning and is rarely knowable ahead of time — which is precisely why static write-partitioning fails here.",
          note: "INTERLOCK sidesteps this by having the agent state its dependencies in natural language, then embedding them.",
        }}
      />

      <ol className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-3">
        {beats.map((b, i) => (
          <li key={b.title}>
            <Card className="h-full">
              <div className="flex flex-wrap items-center gap-2">
                <span className="tabular font-mono text-[11px] text-muted">
                  {b.t}
                </span>
                {b.tone !== "neutral" && (
                  <span
                    className={`inline-flex items-center gap-1 text-[11px] font-medium ${
                      b.tone === "bad" ? "text-critical" : "text-serious"
                    }`}
                  >
                    <span aria-hidden="true">
                      {b.tone === "bad" ? "✕" : "!"}
                    </span>
                    {b.tone === "bad" ? "Silent corruption" : "World changes"}
                  </span>
                )}
              </div>
              <h3 className="mt-3 text-lg font-semibold text-ink">
                {i + 1}. {b.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-2">{b.body}</p>
            </Card>
          </li>
        ))}
      </ol>

      <p className="mt-6 max-w-3xl text-sm leading-relaxed text-ink-2">
        Nothing in that sequence throws an exception. The agent did exactly what
        it decided to do, and what it decided to do was wrong. Monitoring built
        to catch crashes will report a zero error rate the whole way through.
      </p>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */

function PriorArt() {
  const options = [
    {
      name: "Two-phase locking",
      what: "Hold locks for the duration of the task.",
      why: "An agent holds its locks for the entire minutes-long task, blocking every other agent that touches overlapping state.",
      cost: "0.81 deadlocks per trial · 1.04× speedup",
    },
    {
      name: "Optimistic concurrency",
      what: "Detect the conflict at commit and abort.",
      why: "A single conflict discards the agent's entire reasoning — and re-running it costs more than the parallelism ever saved.",
      cost: "0.95 aborts per trial · 0.93× speedup at 1.83× cost",
    },
    {
      name: "Fork and merge",
      what: "Give every agent its own git worktree.",
      why: "This is what mainstream systems actually ship. It offers only weak isolation, and if two agents edit the same file the merge simply fails.",
      cost: "Cannot prevent anomalies",
    },
  ];

  return (
    <Section id="prior-art">
      <SectionHead
        eyebrow="What everyone does instead"
        title="The state of the art is a merge conflict"
        lede="Parallel agents are shipping at scale right now — sub-agent teams, background agents, swarms coordinating a hundred agents on one job. The industry's answer to shared-state conflict is a git worktree."
      />

      <div className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-3">
        {options.map((o) => (
          <Card key={o.name} className="flex h-full flex-col">
            <h3 className="text-base font-semibold text-ink">{o.name}</h3>
            <p className="mt-1.5 text-[13px] text-muted">{o.what}</p>
            <p className="mt-4 flex-1 text-sm leading-relaxed text-ink-2">
              {o.why}
            </p>
            <p className="mt-5 border-t border-hairline pt-4 text-[12px] text-muted">
              {o.cost}
            </p>
          </Card>
        ))}
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */

function Mechanism() {
  return (
    <Section
      id="mechanism"
      tone="raised"
      head={
        <SectionHead
          eyebrow="The mechanism"
          title="Validation becomes reasoning; abort becomes repair"
          lede={
            <>
              The insight is that{" "}
              <em>most conflicts are semantically irrelevant</em>. An agent can
              read the conflicting write and judge whether it actually breaks its
              plan. A real conflict needs repair of only the dependent steps
              &mdash; not the whole task.
            </>
          }
          info={{
            title: "MVCC with a brain",
            what: "Optimistic concurrency control in which the validation step is a judgement rather than a version check.",
            how: "Classical OCC asks 'did any version I read change?' and aborts if so. INTERLOCK asks 'does what changed actually invalidate my plan?' — and when the answer is yes, it repairs precisely the steps that depended on the changed fact.",
            note: "The final commit is still a real serializable transaction, so correctness never rests on the model's judgement.",
          }}
        />
      }
    >
      {/* A numbered rail rather than five stacked cards. The steps are a
          sequence, and a connecting line says so more economically than five
          bordered boxes with their own padding. */}
      <ol className="relative flex flex-col gap-5 pl-8">
        <span
          className="absolute bottom-3 left-[15px] top-3 w-px bg-hairline-strong"
          aria-hidden="true"
        />
        {STEPS.map((s) => (
          <li key={s.n} className="relative">
            <span className="tabular absolute -left-8 top-0 flex h-8 w-8 items-center justify-center rounded-full border border-hairline-strong bg-surface font-mono text-[12px] text-accent">
              {s.n}
            </span>
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <h3 className="text-[15px] font-semibold text-ink">{s.name}</h3>
              <InfoButton {...s.info} />
              <Pill>{s.feature}</Pill>
            </div>
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">
              {s.summary}
            </p>
          </li>
        ))}
      </ol>

      {/* The audit feed is public and it disagrees with the claim above. Better
          to say so here than to let a reader find it and conclude the claim was
          decorative. */}
      <p className="mt-6 rounded-lg border border-hairline bg-surface px-4 py-3 text-[12.5px] leading-relaxed text-ink-2">
        <strong className="font-semibold text-ink">
          Our own audit feed disagrees with that
        </strong>{" "}
        &mdash; about seven in ten rulings on{" "}
        <code className="font-mono text-[12px] text-ink-2">/v1/adjudications</code>{" "}
        are <em>invalidating</em>. That feed is not production traffic: every row
        in it came from a demo, a test or the benchmark, and all three construct a
        real conflict on purpose. Nobody writes a demo where nothing happens. The
        claim rests on the benchmark workload, where writes are drawn
        realistically &mdash; and the endpoint returns this caveat next to the
        counts rather than waiting to be caught.
      </p>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */

function WhyCockroachDB() {
  return (
    <Section
      id="why-cockroachdb"
      head={
        <SectionHead
          eyebrow="Why this database"
          title="Not convenient — load-bearing"
          lede="Every one of these is doing work the system could not do without it. Swap the database and the mechanism stops functioning, rather than merely getting slower."
        />
      }
    >
      {/* Cards, not a six-row table. Each row was a full-width band with a
          three-word cell beside a three-line one, so the table was as tall as
          its longest cell in every single row. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {WHY_CRDB.map((row) => (
          <div key={row.feature} className="card p-4">
            <p className="font-mono text-[12px] font-medium text-accent">
              {row.feature}
            </p>
            <p className="mt-1.5 text-[13.5px] font-medium text-ink">{row.need}</p>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
              {row.detail}
            </p>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */

function Architecture() {
  const crdb = [
    {
      tool: "Distributed Vector Indexing",
      use: "A C-SPANN index over intent embeddings finds which in-flight agents are semantically threatened by a commit — the ones that share meaning but no rows.",
    },
    {
      tool: "Managed MCP Server",
      use: "Not a human console — a tool belt for the adjudicating agent. Before ruling, it may request one read-only lookup: has this resource been churning all morning, or is this the first change in an hour? Because the server is read-only by default, an agent investigating an incident is structurally incapable of altering it, and every lookup is audit-logged outside our own logging. A model that cannot look things up has to guess.",
    },
    {
      tool: "ccloud / Cloud control plane",
      use: "A continuity agent that refuses to let adjudication run if resilience is not actually configured. It reads cluster state from the control plane, verifies three regions and a region-survival goal, and reports gc.ttlseconds per table — the real ceiling on how far back a diff can read, which turned out to be 75 minutes by default and is now a day on the decision tables.",
    },
    {
      tool: "Agent Skills Repo",
      // Said "contribute one back upstream" until someone checked. The skill is
      // real and it is in this repo; there is no pull request. A claim nobody
      // verified is exactly the kind of thing this project spends its time
      // deleting elsewhere.
      use: "We consume the published skills for schema and index design, and wrote one in return for serializable agent intents — skills/managing-long-running-agent-transactions. It ships in this repo and is not upstream; we would rather say that than imply a merge that has not happened.",
    },
  ];

  // Only services this project actually runs on. An earlier version of this
  // list also claimed ECS Fargate, which was designed for and never wired, so
  // it came out. Listing the services we genuinely run on beats a longer list
  // we half-use — "meaningfully integrated, not just initialized" is a
  // pass/fail rule, and a judge can check.
  const aws = [
    {
      tool: "Amazon Bedrock",
      // Said "three tiers" while the runtime role granted two. The third was
      // published as available, ordered by a caller, and returned an IAM denial
      // as a 500 with our account id in it.
      use: "Titan Text Embeddings V2 for the vector path, and Claude on two caller-selectable tiers — pass `adjudicator` on a commit, named by role rather than model id so your code survives the id moving. The cheap tier is the default because the provenance graph has already narrowed the question before a model sees it.",
    },
    {
      tool: "AWS Lambda",
      use: "Two functions. The public API declares intents, commits and streams the demo. A separate SQS worker adjudicates off the queue with partial-batch failure reporting and its own concurrency.",
    },
    {
      tool: "Amazon EventBridge + SQS",
      use: "A CockroachDB changefeed on commit_log posts to the API, which publishes to EventBridge; a rule routes to SQS, and the worker adjudicates in parallel. Commits return as soon as they are durable instead of blocking on everyone they threatened. Three retries, then a dead-letter queue.",
    },
    {
      tool: "Amazon S3 + CloudFront",
      use: "Hosts this page as a static export with a private origin — CloudFront-only read via Origin Access Control, no public bucket policy.",
    },
    {
      tool: "Amazon CloudWatch",
      use: "The logs, which caught a cold-start failure and a cross-region IAM denial during build.",
    },
    {
      tool: "AWS Budgets",
      use: "A $20 monthly cap on the account, alerting at 50%, 80% and 100%. Alert-only by design, because Budgets can only email — the enforcement that actually refuses to spend sits in the API handler, ahead of every Bedrock call.",
    },
    {
      tool: "AWS IAM",
      use: "A runtime role scoped to nine specific model and inference-profile ARNs rather than bedrock:*, with explicit denies on deleting evidence and altering model access. Nine rather than two because a us. inference profile dispatches across regions, so least privilege means naming the underlying model in every region it may route to.",
    },
  ];

  return (
    <Section id="architecture">
      <SectionHead
        eyebrow="Architecture"
        title="What each piece actually does"
        lede="The hackathon asks for at least two CockroachDB tools and one AWS service. We use all four CockroachDB tools — and only the AWS services we genuinely run on, because claiming more than you use is worse than claiming less."
      />

      <div className="mt-8">
        <ArchitectureDiagram />
      </div>

      {/* The diagram is the answer. This is the annex behind it — every service
          with a paragraph on what it does — which is exactly the material a
          reader should be able to skip and a judge should be able to open. */}
      <Disclosure
        className="mt-4"
        summary="What every service is doing, and why it is there"
        hint={`${crdb.length} CockroachDB tools · ${aws.length} AWS services`}
      >
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="card p-5 sm:p-6">
            <h3 className="text-sm font-semibold text-ink">
              CockroachDB &mdash; all four tools
            </h3>
            <ul className="mt-4 flex flex-col gap-4">
              {crdb.map((r) => (
                <li key={r.tool}>
                  <p className="font-mono text-[12px] text-accent">{r.tool}</p>
                  <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
                    {r.use}
                  </p>
                </li>
              ))}
            </ul>
          </div>

          <div className="card p-5 sm:p-6">
            <h3 className="text-sm font-semibold text-ink">
              AWS &mdash; only what we run on
            </h3>
            <ul className="mt-4 flex flex-col gap-4">
              {aws.map((r) => (
                <li key={r.tool}>
                  <p className="font-mono text-[12px] text-accent">{r.tool}</p>
                  <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
                    {r.use}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Disclosure>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */

function ChaosDrill() {
  return (
    <Section
      id="chaos"
      head={
        <SectionHead
          eyebrow="Resilience"
          title="Kill a region mid-adjudication"
          lede="If the memory arbitrating conflicts is unavailable, every agent in the fleet is unsafe at the same moment. So the test is not whether it works — it is whether it keeps working while a region is being taken away from it."
          info={{
            title: "The chaos drill",
            what: "A deliberate failure injected while the system is mid-decision, to show the guarantee holds under loss rather than only under calm.",
            how: "We start a multi-region cluster, drive a contended workload until an adjudication is in flight, then remove a region. The adjudication completes from the surviving region, exactly once, still serializable — no decision is lost and none is applied twice.",
            note: "This is also where the production write-up comes from: we intend to break it, record what broke, and document the fix.",
          }}
        />
      }
    >
      <div className="card p-6 sm:p-8">
        <p className="text-[15px] leading-relaxed text-ink-2">
          An agent whose memory goes offline does not degrade gracefully. It
          stops. That is the premise of this hackathon, and it is the one claim a
          demo can actually prove rather than assert.
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Pill>SURVIVE REGION FAILURE</Pill>
          <Pill>exactly-once adjudication</Pill>
          <Pill>no lost decisions</Pill>
        </div>
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */

function Footer() {
  return (
    <footer className="border-t border-hairline px-5 py-12 sm:px-8">
      <div className="mx-auto w-full max-w-6xl">
        <div className="flex flex-col gap-10 sm:flex-row sm:justify-between">
          <div className="max-w-sm">
            <p className="font-mono text-sm font-semibold text-ink">INTERLOCK</p>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
              Agent memory as a concurrency substrate. Built on CockroachDB and
              AWS for the Build with Agentic Memory hackathon.
            </p>
            <p className="mt-4 text-[12px] text-muted">MIT licensed. Open source.</p>
          </div>

          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
              References
            </p>
            <ul className="mt-3 flex max-w-md flex-col gap-2.5">
              {Object.values(CITATIONS).map((c) => (
                <li key={c.id} className="text-[13px] leading-snug">
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-ink-2 underline decoration-hairline-strong underline-offset-2 transition-colors hover:text-ink"
                  >
                    {c.id}
                  </a>
                  <span className="ml-2 text-[12px] text-muted">{c.title}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </footer>
  );
}
