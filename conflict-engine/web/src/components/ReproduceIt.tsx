import CodeBlock from "./CodeBlock";
import InfoButton from "./InfoButton";
import { REPO_URL } from "@/lib/content";

/**
 * The command that reproduces the chart above it.
 *
 * A cost comparison is only worth as much as a reader's ability to check it,
 * and "clone the repo and read the benchmark harness" is not that. This runs
 * against the live service in about fifteen seconds and needs nothing but Node
 * — no database, no AWS account, no configuration.
 *
 * The second command is the one that matters. It sets the reasoning cost below
 * the crossover, where INTERLOCK loses, and the output says so in red. Publishing
 * the losing case beside the winning one is the only thing that makes the
 * winning one believable.
 */

const CMD = `git clone ${REPO_URL} && cd interlock && npm install

npm run compare                     # two collisions, priced, ~15s
npm run compare -- --reasoning 400  # below the crossover — prints a loss`;

export default function ReproduceIt() {
  return (
    <div className="card mt-4 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
            Reproduce this in fifteen seconds
            <InfoButton
              title="What is measured and what is assumed"
              what="A live run against the public API that prices the same collision with and without INTERLOCK."
              how="Measured on the spot: whether the conflict is detected and by which path, the verdict, exactly which plan steps it invalidates, and the tokens the adjudication itself cost. Assumed and printed on screen: how many tokens your agent spent reasoning before it was interrupted."
              note="That last figure is a property of your agent, not of this service — we never see your reasoning. --reasoning moves it, and the conclusion moves with it."
            />
          </h3>
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-ink-2">
            Node only &mdash; no database, no AWS account, no configuration. It
            issues a throwaway key if you do not have one.
          </p>
        </div>
      </div>

      <CodeBlock className="mt-4" wrap copyText={CMD}>
        {CMD}
      </CodeBlock>

      <p className="mt-3 text-[12.5px] leading-relaxed text-muted">
        The second command is the one worth running. It sets the task below the
        crossover, where this approach costs{" "}
        <strong className="font-semibold text-ink-2">more</strong> than simply
        retrying, and the output says so in red. A demo that can only produce
        good news is not evidence.
      </p>
    </div>
  );
}
