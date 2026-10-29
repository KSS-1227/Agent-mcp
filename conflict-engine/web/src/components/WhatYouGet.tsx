import CodeBlock from "./CodeBlock";

/**
 * What this is, stated by what changes in your code.
 *
 * Two readers in a row asked whether signing up gets them model access. It does
 * not, and nothing on this page had said so — the page described a mechanism
 * and left "so what do I actually receive" to be inferred. If that inference
 * fails for a reader who already knows the project, it fails for everyone.
 *
 * The before/after is the clearest form available: same agent, same model, same
 * tools, four lines different. It also makes the boundary concrete — the model
 * call in the snippet is *theirs*, and stays theirs.
 */

const BEFORE = `// your agent, today
const state = await db.getQueue("support-eu");     // read
const plan  = await llm.plan(state);               // think, 40s
await db.setQueue("support-eu", plan.result);      // act`;

const AFTER = `// the same agent, refereed
const q     = await il.registerResource({ key: "support-eu" });
const plan  = await llm.plan(q.body);              // your model, untouched

const { intent } = await il.declare({              // + say what you're doing
  agentId, statement: plan.summary,
  reads: [{ resourceId: q.id, observedVersion: q.version }],
  steps: plan.steps,
});

const { adjudications } = await il.commit({        // + commit through us
  agentId, intentId: intent.id, resourceId: q.id,
  expectedVersion: q.version, body: plan.result,
  statement: "Rebalanced the overnight rota.",
});

for (const a of adjudications) {                   // + act on the ruling
  if (a.verdict === "invalidating") redo(a.affectedSteps);
}`;

export default function WhatYouGet() {
  return (
    <div className="mt-8">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="card card-accent p-5">
          <p className="eyebrow">You keep</p>
          <ul className="mt-3 flex flex-col gap-2 text-[13.5px] leading-relaxed text-ink-2">
            <li>Your models, prompts and tools.</li>
            <li>Your framework — LangChain or none.</li>
            <li>Your data. We never see your agent&rsquo;s reasoning.</li>
          </ul>
        </div>

        <div className="card p-5">
          <p className="eyebrow">You get</p>
          <ul className="mt-3 flex flex-col gap-2 text-[13.5px] leading-relaxed text-ink-2">
            <li>A referee for state two agents both touch.</li>
            <li>A ruling naming <em>which steps</em> died, not just that something did.</li>
            <li>Serializable commits, an audit feed, and the bill for each decision.</li>
          </ul>
        </div>

        <div className="card p-5">
          <p className="eyebrow">You do not get</p>
          <ul className="mt-3 flex flex-col gap-2 text-[13.5px] leading-relaxed text-ink-2">
            <li>
              <strong className="font-semibold text-ink">Model access.</strong> This
              is not an inference proxy — you cannot send it a prompt.
            </li>
            <li>Somewhere to host or run your agents.</li>
            <li>A vector store you query directly.</li>
          </ul>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <p className="eyebrow mb-2">Your agent today</p>
          <CodeBlock copyText={BEFORE}>{BEFORE}</CodeBlock>
          <p className="mt-2 text-[12.5px] leading-relaxed text-muted">
            Reads at t=0, acts at t=40s. If anything moved in between, this
            overwrites it and nothing raises an error.
          </p>
        </div>
        <div>
          <p className="eyebrow mb-2">The same agent, refereed</p>
          <CodeBlock copyText={AFTER}>{AFTER}</CodeBlock>
          <p className="mt-2 text-[12.5px] leading-relaxed text-muted">
            The <code className="font-mono text-ink-2">llm.plan</code> call is still
            yours. Three additions: say what you are about to do, commit through
            us, act on the ruling.
          </p>
        </div>
      </div>
    </div>
  );
}
