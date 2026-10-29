"use client";

import { useState } from "react";
import { CROSSOVER } from "@/lib/content";
import InfoButton from "./InfoButton";
import { ProvenanceBadge } from "./ui";

/**
 * The crossover curve.
 *
 * Two series that cross, so this is a line chart rather than bars — the reader's
 * job is to find the point where one overtakes the other, and bars hide
 * crossings. INTERLOCK carries the accent because it is the subject; optimistic
 * concurrency is drawn in the de-emphasis gray because it is the context.
 *
 * The losing region is shaded and labelled rather than cropped. A curve that
 * only showed where we win would be a worse chart AND a worse argument.
 */

const W = 720;
const H = 300;
const PAD = { top: 24, right: 90, bottom: 52, left: 52 };

const points = CROSSOVER.points;
const maxCost = 4;

const plotW = W - PAD.left - PAD.right;
const plotH = H - PAD.top - PAD.bottom;

// Log scale on x: reasoning per task spans an order of magnitude.
const xs = points.map((p) => Math.log10(p.reasoning));
const xMin = Math.min(...xs) - 0.12;
const xMax = Math.max(...xs) + 0.12;

const xOf = (reasoning: number) =>
  PAD.left + ((Math.log10(reasoning) - xMin) / (xMax - xMin)) * plotW;
const yOf = (cost: number) => PAD.top + (1 - cost / maxCost) * plotH;

const path = (key: "occ" | "interlock") =>
  points.map((p, i) => `${i === 0 ? "M" : "L"} ${xOf(p.reasoning)} ${yOf(p[key])}`).join(" ");

/** Where the two series cross, interpolated between the bracketing points. */
function crossoverX() {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const da = a.interlock - a.occ;
    const db = b.interlock - b.occ;
    if (da > 0 && db < 0) {
      const t = da / (da - db);
      return xOf(a.reasoning) + t * (xOf(b.reasoning) - xOf(a.reasoning));
    }
  }
  return null;
}

export default function Crossover() {
  const [hover, setHover] = useState<number | null>(null);
  const cx = crossoverX();

  return (
    <div className="card p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
            Cost vs. optimistic concurrency
            <InfoButton
              title="Reading this chart"
              what="Both lines show cost relative to running the agents one at a time. Lower is better."
              how="Optimistic concurrency stays flat at about 2x regardless of task size — it always discards the whole task. INTERLOCK's cost falls as tasks get bigger, because adjudication is a roughly fixed price per conflict while re-running scales with how much reasoning you throw away."
              note="Produced by npm run bench:sweep on a live cluster. Every point is a real run."
              align="right"
            />
          </h3>
          <p className="mt-1 text-[12px] text-muted">
            relative to serial execution · lower is better
          </p>
        </div>
        <ProvenanceBadge kind={CROSSOVER.provenance} />
      </div>

      {/* Legend — required for two series, so identity is never colour-alone. */}
      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px]">
        <span className="inline-flex items-center gap-2">
          <span className="h-0.5 w-5 rounded-full bg-accent" aria-hidden="true" />
          <span className="font-medium text-ink">INTERLOCK</span>
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="h-0.5 w-5 rounded-full bg-muted" aria-hidden="true" />
          <span className="text-ink-2">Optimistic concurrency</span>
        </span>
      </div>

      <div className="mt-2 overflow-x-auto">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full min-w-[560px]"
          role="img"
          aria-label="Cost relative to serial execution as reasoning per task grows. Optimistic concurrency stays near 2x. INTERLOCK falls from 3.57x to 1.28x, crossing below optimistic concurrency at roughly 15,000 tokens per task."
        >
          {/* Gridlines — recessive */}
          {[1, 2, 3, 4].map((c) => (
            <g key={c}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={yOf(c)}
                y2={yOf(c)}
                stroke="var(--grid)"
                strokeWidth="1"
              />
              <text
                x={PAD.left - 10}
                y={yOf(c) + 4}
                textAnchor="end"
                fontSize="11"
                fill="var(--muted)"
                className="tabular"
              >
                {c}×
              </text>
            </g>
          ))}

          {/* The region where retrying is the better engineering choice. */}
          {cx !== null && (
            <>
              <rect
                x={PAD.left}
                y={PAD.top}
                width={cx - PAD.left}
                height={plotH}
                fill="var(--muted)"
                opacity="0.07"
              />
              <line
                x1={cx}
                x2={cx}
                y1={PAD.top}
                y2={PAD.top + plotH}
                stroke="var(--baseline)"
                strokeWidth="1"
                strokeDasharray="4 4"
              />
              {/* Sat at PAD.top + 16, which is exactly where the first data
                  point's value label lands — the leftmost point is also the
                  highest one, so the region label and "3.57×" were printed over
                  each other. Moved to the bottom of the shaded band, which is
                  empty because both series are climbing away from it. */}
              <text
                x={PAD.left + 8}
                y={H - PAD.bottom - 12}
                fontSize="11"
                fill="var(--muted)"
              >
                just retry — nothing worth protecting
              </text>
            </>
          )}

          {/* Series. Context first so the subject draws on top. */}
          <path d={path("occ")} fill="none" stroke="var(--muted)" strokeWidth="2" />
          <path d={path("interlock")} fill="none" stroke="var(--accent)" strokeWidth="2" />

          {points.map((p, i) => (
            <g key={p.reasoning}>
              {/* 2px surface ring keeps overlapping marks legible */}
              <circle cx={xOf(p.reasoning)} cy={yOf(p.occ)} r="5" fill="var(--surface)" />
              <circle cx={xOf(p.reasoning)} cy={yOf(p.occ)} r="4" fill="var(--muted)" />
              <circle cx={xOf(p.reasoning)} cy={yOf(p.interlock)} r="5" fill="var(--surface)" />
              <circle cx={xOf(p.reasoning)} cy={yOf(p.interlock)} r="4" fill="var(--accent)" />

              {/* Direct labels on the subject series */}
              <text
                x={xOf(p.reasoning)}
                y={yOf(p.interlock) - 12}
                textAnchor="middle"
                fontSize="12"
                fontWeight="600"
                fill="var(--ink)"
                className="tabular"
              >
                {p.interlock.toFixed(2)}×
              </text>

              <text
                x={xOf(p.reasoning)}
                y={H - PAD.bottom + 20}
                textAnchor="middle"
                fontSize="11"
                fill="var(--muted)"
                className="tabular"
              >
                {(p.reasoning / 1000).toFixed(0)}k
              </text>

              <rect
                x={xOf(p.reasoning) - 26}
                y={PAD.top}
                width="52"
                height={plotH}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              />
            </g>
          ))}

          {/* End-of-line labels instead of a floating legend on the plot */}
          <text
            x={W - PAD.right + 10}
            y={yOf(points[points.length - 1].interlock) + 4}
            fontSize="12"
            fontWeight="600"
            fill="var(--ink)"
          >
            INTERLOCK
          </text>
          <text
            x={W - PAD.right + 10}
            y={yOf(points[points.length - 1].occ) + 4}
            fontSize="12"
            fill="var(--ink-2)"
          >
            OCC
          </text>

          <text
            x={PAD.left + plotW / 2}
            y={H - 8}
            textAnchor="middle"
            fontSize="11"
            fill="var(--muted)"
          >
            tokens of reasoning per task
          </text>

          {hover !== null && (
            <g>
              <rect
                x={Math.min(xOf(points[hover].reasoning) - 78, W - PAD.right - 70)}
                y={PAD.top + 26}
                width="156"
                height="54"
                rx="6"
                fill="var(--surface)"
                stroke="var(--border-strong)"
              />
              <text
                x={Math.min(xOf(points[hover].reasoning) - 66, W - PAD.right - 58)}
                y={PAD.top + 46}
                fontSize="12"
                fill="var(--ink)"
                className="tabular"
              >
                {points[hover].reasoning.toLocaleString()} tokens
              </text>
              <text
                x={Math.min(xOf(points[hover].reasoning) - 66, W - PAD.right - 58)}
                y={PAD.top + 66}
                fontSize="12"
                fill="var(--ink-2)"
              >
                {points[hover].winner === "interlock"
                  ? "INTERLOCK cheaper"
                  : "retry is cheaper"}
              </text>
            </g>
          )}
        </svg>
      </div>

      <p className="mt-4 text-[13px] leading-relaxed text-ink-2">
        Below roughly{" "}
        <strong className="font-semibold text-ink">
          {CROSSOVER.crossoverAt.toLocaleString()} tokens of reasoning per task
        </strong>
        , don&rsquo;t use this — just retry. There is nothing expensive enough to
        be worth protecting. Above it, the saving grows with the cost of the task.
      </p>
      <p className="mt-2 text-[12px] text-muted">
        <strong className="font-medium text-ink-2">
          {CROSSOVER.anomalies} lost updates
        </strong>{" "}
        at every point on this curve, in every mode. Serializable isolation holds
        regardless of which approach is cheaper.
      </p>
    </div>
  );
}
