"use client";

import { useEffect, useId, useRef, useState } from "react";

export type InfoButtonProps = {
  /** Short heading for the popover, e.g. "Semantic conflict detection". */
  title: string;
  /** Plain-language definition. Answers "what is this?" */
  what: string;
  /** The mechanism. Answers "how does it actually work?" */
  how: string;
  /** Optional third line — the CockroachDB feature, a citation, a caveat. */
  note?: string;
  /** Which edge the popover anchors to. Use "right" near a container's right edge. */
  align?: "left" | "right" | "center";
  /** Accessible label; defaults to "More about {title}". */
  label?: string;
};

/**
 * A small "i" affordance that explains one thing on the page.
 *
 * Every non-obvious element on this site carries one. The contract is always
 * the same — WHAT it is, HOW it works, and optionally which CockroachDB
 * feature does the work — so a reader can drill into any claim without us
 * cluttering the page with prose.
 */
export default function InfoButton({
  title,
  what,
  how,
  note,
  align = "left",
  label,
}: InfoButtonProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  // Close on outside click and on Escape. Escape returns focus to the trigger.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btnRef.current?.focus();
      }
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const anchor =
    align === "right"
      ? "right-0"
      : align === "center"
        ? "left-1/2 -translate-x-1/2"
        : "left-0";

  return (
    <span ref={wrapRef} className="relative inline-flex align-middle">
      <button
        ref={btnRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={label ?? `More about ${title}`}
        onClick={() => setOpen((v) => !v)}
        className={[
          "inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full",
          "border text-[11px] font-semibold leading-none transition-colors",
          "cursor-pointer select-none",
          open
            ? "border-accent bg-accent text-white"
            : "border-hairline-strong text-muted hover:border-accent hover:text-accent",
        ].join(" ")}
      >
        i
      </button>

      {open && (
        <span
          id={panelId}
          role="note"
          className={[
            "absolute top-7 z-40 block w-[min(22rem,calc(100vw-2rem))]",
            anchor,
            "rounded-lg border border-hairline-strong bg-surface p-4 text-left",
            "shadow-lg shadow-black/5",
          ].join(" ")}
        >
          <span className="block text-sm font-semibold text-ink">{title}</span>

          <span className="mt-3 block">
            <span className="block text-[10px] font-semibold uppercase tracking-wider text-accent">
              What it is
            </span>
            <span className="mt-1 block text-[13px] leading-relaxed text-ink-2">
              {what}
            </span>
          </span>

          <span className="mt-3 block">
            <span className="block text-[10px] font-semibold uppercase tracking-wider text-accent">
              How it works
            </span>
            <span className="mt-1 block text-[13px] leading-relaxed text-ink-2">
              {how}
            </span>
          </span>

          {note && (
            <span className="mt-3 block border-t border-hairline pt-3 text-[12px] leading-relaxed text-muted">
              {note}
            </span>
          )}
        </span>
      )}
    </span>
  );
}
