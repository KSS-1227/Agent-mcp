import type { ReactNode } from "react";
import type { Provenance } from "@/lib/content";
import InfoButton, { type InfoButtonProps } from "./InfoButton";

export function Section({
  id,
  children,
  head,
  className = "",
  tone = "page",
}: {
  id?: string;
  children: ReactNode;
  /**
   * The section heading. Passing it here rather than as a child moves it into a
   * sticky left rail on wide screens.
   *
   * Stacked headings cost twice: they add their own height to every section,
   * and they leave the right half of the measure empty while doing it — this
   * page is long enough that both matter. Beside the content, the heading also
   * stays visible while you read, so a reader who scrolled into the middle of a
   * section still knows which argument they are inside.
   *
   * Only for sections whose content is text or narrow cards. Charts and
   * diagrams keep the full measure and pass their heading as a child.
   */
  head?: ReactNode;
  className?: string;
  /**
   * Alternating grounds give a long page rhythm. Without it, fourteen sections
   * of identical background read as one undifferentiated scroll and the reader
   * loses track of where an argument started.
   */
  tone?: "page" | "raised";
}) {
  return (
    <section
      id={id}
      className={`border-t border-hairline px-5 py-12 sm:px-8 sm:py-14 lg:py-16 ${
        tone === "raised" ? "bg-page-2" : ""
      } ${className}`}
    >
      <div className="mx-auto w-full max-w-6xl">
        {head ? (
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:gap-12">
            {/* `self-start` is what makes sticky work here: a grid item stretches
                to the row height by default, which leaves nothing to stick. */}
            <div className="self-start lg:sticky lg:top-24">{head}</div>
            <div className="min-w-0">{children}</div>
          </div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

/**
 * Detail that most readers should not have to scroll past.
 *
 * Native `<details>`, so it is keyboard-accessible, findable by the browser's
 * own find-in-page in modern browsers, and correct with no JavaScript. The
 * summary states what is inside and how much of it, because "Show more" asks
 * the reader to gamble on whether it is worth the click.
 */
export function Disclosure({
  summary,
  hint,
  children,
  className = "",
}: {
  summary: string;
  /** e.g. "8 rows" — sets the expectation before the click. */
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details className={`group ${className}`}>
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg border border-hairline bg-surface px-4 py-3 text-[13px] font-medium text-ink transition-colors hover:border-hairline-strong [&::-webkit-details-marker]:hidden">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="shrink-0 text-muted transition-transform group-open:rotate-90"
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
        {summary}
        {hint && <span className="text-[12px] font-normal text-muted">{hint}</span>}
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

export function SectionHead({
  eyebrow,
  title,
  lede,
  info,
}: {
  eyebrow: string;
  title: string;
  lede?: ReactNode;
  info?: InfoButtonProps;
}) {
  return (
    <header className="max-w-3xl">
      <p className="flex items-center gap-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-accent">
        <span
          className="h-px w-6 bg-accent/50"
          aria-hidden="true"
        />
        {eyebrow}
      </p>
      {/* Not a flex row: as a flex item the heading text wraps as one block and
          pushes the info button onto a line of its own, which reads as a stray
          orphan under the title. Inline-block keeps it beside the last word. */}
      <h2 className="mt-3.5 text-[1.625rem] font-semibold text-balance text-ink sm:text-[2.125rem]">
        {title}
        {info && (
          <span className="ml-2 inline-block translate-y-[-0.15em] align-middle">
            <InfoButton {...info} />
          </span>
        )}
      </h2>
      {lede && (
        <p className="mt-4 text-base leading-relaxed text-ink-2 sm:text-[17px]">
          {lede}
        </p>
      )}
    </header>
  );
}

export function Card({
  children,
  className = "",
  interactive = false,
  accent = false,
}: {
  children: ReactNode;
  className?: string;
  /** Lifts on hover. Only for cards that actually do something when clicked. */
  interactive?: boolean;
  /** A lit hairline along the top edge, for the one card that carries the point. */
  accent?: boolean;
}) {
  return (
    <div
      className={`card p-5 sm:p-6 ${interactive ? "card-interactive" : ""} ${
        accent ? "card-accent" : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}

const PROVENANCE_COPY: Record<
  Provenance,
  { label: string; title: string; className: string }
> = {
  published: {
    label: "Published",
    title: "Measured by cited prior work, not by us",
    className: "border-hairline-strong text-muted",
  },
  measured: {
    label: "Measured",
    title: "Produced by our own benchmark harness on real runs",
    className: "border-good/40 text-good",
  },
  target: {
    label: "Target",
    title: "What we are aiming for — not yet measured",
    className: "border-warning/50 text-serious",
  },
};

/**
 * Renders next to every figure so a target can never be misread as a result.
 * Carries an icon-free but always-labelled treatment — the word does the work,
 * never the colour alone.
 */
export function ProvenanceBadge({ kind }: { kind: Provenance }) {
  const p = PROVENANCE_COPY[kind];
  return (
    <span
      title={p.title}
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${p.className}`}
    >
      {p.label}
    </span>
  );
}

export function Pill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-hairline bg-surface-2 px-2.5 py-1 font-mono text-[11px] text-ink-2">
      {children}
    </span>
  );
}
