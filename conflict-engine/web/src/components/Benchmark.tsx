"use client";

import { useState } from "react";
import { APPROACHES, KPIS, CITATIONS, type Approach } from "@/lib/content";
import InfoButton from "./InfoButton";
import { ProvenanceBadge } from "./ui";

/* -------------------------------------------------------------------------- */
/* KPI row                                                                     */
/* -------------------------------------------------------------------------- */

function StatTile({ kpi }: { kpi: (typeof KPIS)[number] }) {
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted">
          {kpi.label}
        </p>
        <InfoButton {...kpi.info} align="right" />
      </div>

      <p className="mt-3 flex items-baseline gap-0.5 text-4xl font-semibold tracking-tight text-ink">
        {kpi.value}
        {kpi.unit && (
          <span className="text-2xl font-medium text-ink-2">{kpi.unit}</span>
        )}
      </p>

      <p className="mt-2 text-[13px] leading-snug text-ink-2">{kpi.caption}</p>

      <div className="mt-4">
        <ProvenanceBadge kind={kpi.provenance} />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Emphasis bar chart                                                          */
/*                                                                             */
/* One series is the point and the rest are context, so this is the EMPHASIS   */
/* form: INTERLOCK in the accent hue, the two baselines in de-emphasis gray.   */
/* Every bar is direct-labelled, so identity is never carried by colour alone. */
/* -------------------------------------------------------------------------- */

type Metric = {
  key: "speedup" | "tokenCost";
  title: string;
  axisLabel: string;
  max: number;
  better: "higher" | "lower";
  format: (n: number) => string;
  info: { title: string; what: string; how: string; note?: string };
};

const METRICS: Metric[] = [
  {
    key: "speedup",
    title: "Throughput",
    axisLabel: "× serial execution speed",
    max: 1.6,
    better: "higher",
    format: (n) => `${n.toFixed(2)}×`,
    info: {
      title: "Throughput vs serial",
      what: "How fast the parallel fleet completes the workload compared with running the same agents one at a time.",
      how: "The 1.0× marker is the do-nothing baseline. A bar left of it means parallelism made things worse. Optimistic concurrency lands at 0.93× — the parallel fleet finishes later than the serial one.",
      note: `Baselines measured across 10 contended workloads in ${CITATIONS.coagent.id}.`,
    },
  },
  {
    key: "tokenCost",
    title: "Inference cost",
    axisLabel: "× serial execution token spend",
    max: 2.0,
    better: "lower",
    format: (n) => `${n.toFixed(2)}×`,
    info: {
      title: "Token cost vs serial",
      what: "Total tokens the parallel fleet consumes relative to the serial run.",
      how: "Everything above the 1.0× marker is overhead. Under optimistic concurrency almost all of that 0.83× overhead is re-reasoning: work that was already done, thrown away by an abort, and done again.",
      note: "Repairing only the dependent steps is what turns discarded work into retained work.",
    },
  },
];

function Bars({ metric }: { metric: Metric }) {
  const [active, setActive] = useState<string | null>(null);
  const baselinePct = (1 / metric.max) * 100;

  return (
    <div className="card p-5 sm:p-6">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold text-ink">{metric.title}</h4>
          <p className="mt-0.5 text-[12px] text-muted">{metric.axisLabel}</p>
        </div>
        <InfoButton {...metric.info} align="right" />
      </div>

      <div className="relative mt-6">
        {/* 1.0× reference — the serial baseline. Recessive by design. */}
        <div
          className="pointer-events-none absolute inset-y-0 z-0 border-l border-dashed border-baseline"
          style={{ left: `${baselinePct}%` }}
          aria-hidden="true"
        />

        <ul className="relative z-10 flex flex-col gap-3">
          {APPROACHES.map((a) => {
            const value = a[metric.key];
            const pct = Math.min((value / metric.max) * 100, 100);
            const isEmphasis = Boolean(a.emphasis);
            const isActive = active === a.key;

            return (
              <li key={a.key}>
                <div className="mb-1.5 flex items-baseline justify-between gap-3">
                  <span
                    className={`text-[13px] ${isEmphasis ? "font-semibold text-ink" : "text-ink-2"}`}
                  >
                    {a.name}
                  </span>
                  <span
                    className={`tabular text-[13px] ${isEmphasis ? "font-semibold text-ink" : "text-ink-2"}`}
                  >
                    {metric.format(value)}
                  </span>
                </div>

                <div
                  tabIndex={0}
                  role="img"
                  aria-label={`${a.name}: ${metric.format(value)} ${metric.axisLabel}. ${a.failure}.`}
                  onMouseEnter={() => setActive(a.key)}
                  onMouseLeave={() => setActive(null)}
                  onFocus={() => setActive(a.key)}
                  onBlur={() => setActive(null)}
                  className="relative h-7 cursor-default rounded-sm"
                >
                  <div className="absolute inset-0 rounded-sm bg-surface-2" />
                  <div
                    className="absolute inset-y-0 left-0 rounded-r-[4px] transition-[width] duration-500"
                    style={{
                      width: `${pct}%`,
                      background: isEmphasis
                        ? "var(--accent)"
                        : "var(--muted)",
                      opacity: isEmphasis ? 1 : isActive ? 0.85 : 0.6,
                    }}
                  />

                  {isActive && (
                    <div className="absolute -top-1 left-0 z-20 -translate-y-full rounded-md border border-hairline-strong bg-surface px-3 py-2 text-[12px] shadow-lg shadow-black/5">
                      <p className="font-semibold text-ink">{a.name}</p>
                      <p className="mt-0.5 text-ink-2">{a.blurb}</p>
                      <p className="mt-1 text-muted">{a.failure}</p>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        <p className="mt-3 text-[11px] text-muted" style={{ marginLeft: 0 }}>
          Dashed line marks <span className="tabular">1.0×</span> — running the
          agents one at a time.{" "}
          {metric.better === "higher"
            ? "Further right is better."
            : "Further left is better."}
        </p>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Table view — the accessibility fallback the chart owes the reader           */
/* -------------------------------------------------------------------------- */

function DataTable({ rows }: { rows: Approach[] }) {
  return (
    <div className="overflow-x-auto card">
      <table className="w-full min-w-[34rem] border-collapse text-left text-[13px]">
        <caption className="sr-only">
          Throughput, token cost and failure mode by concurrency-control
          approach
        </caption>
        <thead>
          <tr className="border-b border-hairline">
            {["Approach", "Throughput", "Token cost", "Failure mode", "Source"].map(
              (h) => (
                <th
                  key={h}
                  scope="col"
                  className="px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-muted"
                >
                  {h}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-b border-hairline last:border-0">
              <th
                scope="row"
                className={`px-4 py-3 font-medium ${r.emphasis ? "text-ink" : "text-ink-2"}`}
              >
                {r.name}
              </th>
              <td className="tabular px-4 py-3 text-ink-2">
                {r.speedup.toFixed(2)}×
              </td>
              <td className="tabular px-4 py-3 text-ink-2">
                {r.tokenCost.toFixed(2)}×
              </td>
              <td className="px-4 py-3 text-ink-2">{r.failure}</td>
              <td className="px-4 py-3">
                <ProvenanceBadge kind={r.provenance} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * The four headline figures.
 *
 * Split out from the comparison charts so the crossover curve — which is the
 * actual finding, losing region and all — can sit directly beneath them instead
 * of after two more charts.
 */
export function BenchmarkTiles() {
  return (
    <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {KPIS.map((k) => (
        <StatTile key={k.label} kpi={k} />
      ))}
    </div>
  );
}

export default function Benchmark() {
  const [showTable, setShowTable] = useState(false);

  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-[15px] font-semibold text-ink">
          Three ways to handle a conflict
        </h3>
        <button
          type="button"
          onClick={() => setShowTable((v) => !v)}
          aria-pressed={showTable}
          className="shrink-0 cursor-pointer rounded-md border border-hairline px-3 py-1.5 text-[12px] text-ink-2 transition-colors hover:border-hairline-strong hover:text-ink"
        >
          {showTable ? "Show charts" : "Show table"}
        </button>
      </div>

      <div className="mt-4">
        {showTable ? (
          <DataTable rows={APPROACHES} />
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {METRICS.map((m) => (
              <Bars key={m.key} metric={m} />
            ))}
          </div>
        )}
      </div>

      <p className="mt-5 max-w-3xl text-[13px] leading-relaxed text-muted">
        The two baseline rows are measured numbers from{" "}
        <a
          href={CITATIONS.coagent.url}
          target="_blank"
          rel="noreferrer"
          className="text-ink-2 underline decoration-hairline-strong underline-offset-2 hover:text-ink"
        >
          {CITATIONS.coagent.title} ({CITATIONS.coagent.id})
        </a>
        . The INTERLOCK row is{" "}
        <strong className="font-semibold text-ink-2">our own measurement</strong>
        , produced by <code className="font-mono text-[12px]">npm run bench</code>{" "}
        on the live cluster. It is taken at the top of the crossover curve below,
        where tasks are expensive enough for the approach to pay &mdash; at
        smaller task sizes it loses, which the curve shows rather than hides.
      </p>
    </div>
  );
}
