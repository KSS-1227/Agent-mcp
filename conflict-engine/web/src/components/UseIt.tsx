import type { ReactNode } from "react";
import { API_URL, REPO_URL } from "@/lib/content";
import InfoButton from "./InfoButton";
import GetKey from "./GetKey";
import CodeBlock from "./CodeBlock";
import { Disclosure } from "./ui";

const HEALTH_CMD = `curl -s ${API_URL}v1/health`;
const DEMO_CMD =
  `curl -s -X POST ${API_URL}v1/demo \\\n` +
  `  -H 'content-type: application/json' -d '{}'`;
const QUICKSTART_CMD = `git clone ${REPO_URL} && cd interlock && npm install
npm run quickstart -- ilk_your_key_here`;
const LANGCHAIN_SNIPPET = `import { InterlockCallback } from "interlock/langchain";

const guard = new InterlockCallback({ apiKey, agentId, resources });
await executor.invoke(input, { callbacks: [guard] });

// names which steps died, not just that something did
if (guard.wasInvalidated) redo(guard.stepsToRedo);`;

/** A numbered step. The number is the point — it says "there is an order". */
function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="flex gap-3.5">
      <span
        className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-accent/40 bg-accent-soft font-mono text-[11px] font-semibold text-accent"
        aria-hidden="true"
      >
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <h4 className="text-[13.5px] font-semibold text-ink">{title}</h4>
        <div className="mt-1.5">{children}</div>
      </div>
    </li>
  );
}

/**
 * INTERLOCK is a service, not only a demonstration.
 *
 * The same endpoints the page above calls are open to any agent fleet. Showing
 * the actual curl commands matters more than describing them: a reader can
 * verify the service exists by pasting one line, which is a stronger claim than
 * any amount of prose about an architecture.
 */

const ENDPOINTS = [
  {
    method: "POST",
    path: "/v1/keys",
    what: "Self-serve. Creates an isolated tenant and returns a key, shown once.",
    free: true,
  },
  {
    method: "GET",
    path: "/v1/health",
    what: "Topology, survival goal, time-travel reach, and quota remaining.",
    free: true,
  },
  {
    method: "POST",
    path: "/v1/agents",
    what: "Register an agent. Idempotent by name, so a fleet can call it on every boot.",
    free: true,
  },
  {
    method: "POST",
    path: "/v1/resources",
    what: "Register a piece of shared state for agents to contend over.",
    free: true,
  },
  {
    method: "POST",
    path: "/v1/intents",
    what: "Declare what an agent is about to do, and what it read, before it acts.",
    free: false,
  },
  {
    method: "POST",
    path: "/v1/intents/steps",
    what: "Add steps as a plan unfolds — for agents that discover their plan while working.",
    free: true,
  },
  {
    method: "POST",
    path: "/v1/commits",
    what: "Commit a change. Returns a ruling for every agent the commit threatened.",
    free: false,
  },
  {
    method: "GET",
    path: "/v1/adjudications",
    what: "The audit feed — recent rulings, read-only.",
    free: true,
  },
];

export default function UseIt() {
  return (
    <div className="mt-8">
      <div>
        <div className="card p-5 sm:p-6">
          <h3 className="text-sm font-semibold text-ink">Start here</h3>
          <p className="mt-1 text-[13px] text-ink-2">
            The first three take about a minute and need nothing but a terminal.
          </p>

          {/* Two columns on wide screens. These four steps are independent
              things you can do, not a chain where each depends on the last, so
              stacking them just made the section twice as tall. */}
          <ol className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2 lg:gap-x-8">
            <Step n={1} title="See that it is real">
              <p className="mb-2.5 text-[13px] leading-relaxed text-ink-2">
                No key needed. Returns the live topology, the survival goal, and
                how much quota is left today.
              </p>
              <CodeBlock wrap copyText={HEALTH_CMD}>
                <span className="text-muted"># no key needed</span>
                {"\n"}
                {HEALTH_CMD}
              </CodeBlock>
            </Step>

            <Step n={2} title="Watch a real conflict get adjudicated">
              <p className="mb-2.5 text-[13px] leading-relaxed text-ink-2">
                Creates real rows, embeds a real statement, and calls a real
                model. The response is the full trace, including what it cost.
              </p>
              <CodeBlock wrap copyText={DEMO_CMD}>{DEMO_CMD}</CodeBlock>
            </Step>

            <Step n={3} title="Point your own agents at it">
              <p className="mb-2.5 text-[13px] leading-relaxed text-ink-2">
                A key gives you an isolated tenant. No other caller&rsquo;s
                commits can adjudicate your intents &mdash; the tenant filter
                sits inside the detection query, not around it.
              </p>
              <GetKey />
            </Step>

            <Step n={4} title="Run the whole loop in one command">
              <p className="mb-2.5 text-[13px] leading-relaxed text-ink-2">
                Two agents, one queue, a real ruling — declared, contended and
                adjudicated, printed step by step. Needs Node and nothing else:
                no database, no AWS account, no configuration. Pass your key, or
                leave it off and it issues a throwaway one.
              </p>
              <CodeBlock wrap copyText={QUICKSTART_CMD}>
                {QUICKSTART_CMD}
              </CodeBlock>
            </Step>
          </ol>

          <div className="mt-6 grid grid-cols-1 gap-3 border-t border-hairline pt-6 lg:grid-cols-2">
          <Disclosure
            summary="Already on LangChain? Add a callback."
            hint="one wrapper, no rewrite"
          >
            <div className="rounded-lg border border-hairline p-4">
            <h4 className="flex items-center gap-2 text-[13px] font-semibold text-ink">
              A guard, not a rewrite
              <InfoButton
                title="Why a callback, not a memory class"
                what="LangChain already tells its callbacks what a chain is about to do, and which tool it is about to call. That is exactly what INTERLOCK needs to declare an intent and record plan steps."
                how="Pass the handler to invoke(). It declares one intent on the outermost chain start, records each tool call as a plan step, and exposes the ruling. Your prompts, model and tools are untouched."
                note="If declaring fails it warns and lets the run continue. A guard that breaks the run it is guarding is worse than no guard."
              />
            </h4>
            <CodeBlock className="mt-3" copyText={LANGCHAIN_SNIPPET}>
              <span className="text-accent">import</span> {"{ InterlockCallback }"}{" "}
              <span className="text-accent">from</span>{" "}
              <span className="text-ink">&quot;interlock/langchain&quot;</span>;
              {"\n\n"}
              <span className="text-accent">const</span> guard ={" "}
              <span className="text-accent">new</span> InterlockCallback({"{"} apiKey,
              agentId, resources {"}"});
              {"\n"}
              <span className="text-accent">await</span> executor.invoke(input, {"{"}{" "}
              callbacks: [guard] {"}"});
              {"\n\n"}
              <span className="text-muted">
                // names which steps died, not just that something did
              </span>
              {"\n"}
              <span className="text-accent">if</span> (guard.wasInvalidated)
              redo(guard.stepsToRedo);
            </CodeBlock>
            <p className="mt-2 text-[12px] leading-relaxed text-muted">
              Tool calls become plan steps as they happen, which is what lets a
              conflict be repaired at step granularity instead of throwing the
              task away.
            </p>
            </div>
          </Disclosure>

          <Disclosure
            summary="Full API reference"
            hint={`${ENDPOINTS.length} endpoints`}
          >
            <div className="rounded-lg border border-hairline p-4">
              <h4 className="flex items-center gap-2 text-[13px] font-semibold text-ink">
                Every endpoint
                <InfoButton
                  title="Why this is public"
                  what="An unauthenticated HTTP API exposing the same mechanism the demo above uses."
                  how="Declare intents before acting, commit through /v1/commits, and receive a ruling for every agent your write threatened. Your agents keep their own logic; INTERLOCK only arbitrates the shared state."
                  note="Rate limited by a ceiling held in CockroachDB rather than in Lambda memory — instances are ephemeral and concurrent, so per-instance counters undercount exactly when it matters."
                />
              </h4>
              <ul className="mt-3 flex flex-col gap-3">
                {ENDPOINTS.map((e) => (
                  <li key={e.path}>
                    <p className="font-mono text-[12px]">
                      <span className="text-accent">{e.method}</span>{" "}
                      <span className="text-ink">{e.path}</span>
                      {e.free && (
                        <span className="ml-2 rounded-full border border-hairline px-1.5 py-0.5 text-[10px] text-muted">
                          no quota
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-2">
                      {e.what}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          </Disclosure>
          </div>

          <p className="mt-5 border-t border-hairline pt-5 text-[12px] leading-relaxed text-muted">
            Your agents keep their own reasoning and their own tools. INTERLOCK
            arbitrates only the shared state — declare an intent, commit through
            it, and act on the ruling.
          </p>
        </div>
      </div>
    </div>
  );
}
