/**
 * The mechanism, as a picture, above the fold.
 *
 * The hero used to be a column of text against half a screen of nothing. That
 * empty half was doing real damage: a reader has to get four sections down
 * before anything shows them what the product *is*.
 *
 * This is the actual sequence — two agents, one resource, a ruling — drawn as
 * the timeline it is. Static SVG rather than an animation, because it has to be
 * readable in a screenshot, in a paused video frame, and by a screen reader.
 * Every number in it matches what `npm run demo` prints.
 */
export default function HeroVisual() {
  return (
    <div
      className="card relative overflow-hidden p-5 sm:p-6"
      role="img"
      aria-label="Timeline: the Scheduler reads a queue at 118 tickets and spends 40 seconds planning. At 12 seconds, Triage commits the same queue at 131 tickets. INTERLOCK rules the Scheduler's plan invalidating and marks 2 of its 4 steps for redo, preserving the other 2."
    >
      <div className="flex items-center justify-between gap-3">
        <p className="eyebrow">Live mechanism</p>
        <span className="pill !px-2.5 !py-1 !text-[11px]">
          <span className="pill-dot pill-dot-live" aria-hidden="true" />
          serializable
        </span>
      </div>

      <div className="mt-5 flex flex-col gap-3" aria-hidden="true">
        {/* --- agent A ------------------------------------------------- */}
        <Lane
          label="Scheduler"
          sub="reads queue @ v1 · 118 tickets"
          tone="accent"
        >
          <Bar from={0} to={100} tone="accent" />
          <Tick at={0} label="read" />
          <Tick at={100} label="act" align="end" />
        </Lane>

        {/* --- agent B ------------------------------------------------- */}
        <Lane label="Triage" sub="commits queue → v2 · 131 tickets" tone="warn">
          <Bar from={30} to={44} tone="warn" />
          <Tick at={44} label="commit" />
        </Lane>

        {/* --- the ruling ---------------------------------------------- */}
        <div className="mt-1 rounded-lg border border-hairline bg-surface-2 p-3.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-serious">
              invalidating
            </span>
            <span className="text-[11px] text-muted">
              detected by exact + graph + vector
            </span>
          </div>
          <p className="mt-2 text-[12.5px] leading-relaxed text-ink-2">
            &ldquo;Queue depth rose 118 → 131, which changes the overflow
            calculation and which tickets move.&rdquo;
          </p>

          <div className="mt-3 flex items-center gap-1.5">
            <StepChip state="keep" n={1} />
            <StepChip state="redo" n={2} />
            <StepChip state="redo" n={3} />
            <StepChip state="keep" n={4} />
            <span className="ml-1.5 text-[11px] text-muted">
              2 of 4 redone
            </span>
          </div>
        </div>
      </div>

      <p className="mt-4 border-t border-hairline pt-3.5 text-[11.5px] leading-relaxed text-muted">
        Optimistic concurrency would discard all four steps and re-run the whole
        task. Locking would have made Triage wait forty seconds.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function Lane({
  label,
  sub,
  tone,
  children,
}: {
  label: string;
  sub: string;
  tone: "accent" | "warn";
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span
          className={`text-[12.5px] font-semibold ${
            tone === "accent" ? "text-accent" : "text-serious"
          }`}
        >
          {label}
        </span>
        <span className="font-mono text-[10.5px] text-muted">{sub}</span>
      </div>
      <div className="relative mt-1.5 h-9">{children}</div>
    </div>
  );
}

/** A span of wall-clock time, positioned as a percentage of the same 40s axis. */
function Bar({
  from,
  to,
  tone,
}: {
  from: number;
  to: number;
  tone: "accent" | "warn";
}) {
  return (
    <>
      <div className="absolute inset-x-0 top-2.5 h-1.5 rounded-full bg-surface-3" />
      <div
        className="absolute top-2.5 h-1.5 rounded-full"
        style={{
          left: `${from}%`,
          width: `${to - from}%`,
          backgroundImage:
            tone === "accent"
              ? "linear-gradient(90deg, var(--accent), var(--accent-2))"
              : "linear-gradient(90deg, var(--status-warning), var(--status-serious))",
        }}
      />
    </>
  );
}

function Tick({
  at,
  label,
  align = "start",
}: {
  at: number;
  label: string;
  align?: "start" | "end";
}) {
  return (
    <div
      className="absolute top-0 flex flex-col items-center"
      style={{
        left: `${at}%`,
        transform:
          align === "end" ? "translateX(-100%)" : at === 0 ? "none" : "translateX(-50%)",
      }}
    >
      <span className="h-6 w-px bg-border-strong" />
      <span className="mt-0.5 font-mono text-[10px] text-muted">{label}</span>
    </div>
  );
}

function StepChip({ state, n }: { state: "keep" | "redo"; n: number }) {
  const keep = state === "keep";
  return (
    <span
      className={`inline-flex h-6 w-6 items-center justify-center rounded-md border font-mono text-[11px] ${
        keep
          ? "border-good/40 bg-good/10 text-good"
          : "border-serious/50 bg-serious/10 text-serious"
      }`}
      title={keep ? `Step ${n} preserved` : `Step ${n} must be redone`}
    >
      {n}
    </span>
  );
}
