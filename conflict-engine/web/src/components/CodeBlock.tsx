"use client";

import { useState, type ReactNode } from "react";

/**
 * A code block you can actually use.
 *
 * Every snippet on this page is meant to be run, and a snippet that has to be
 * selected by hand out of a horizontally-scrolling box mostly does not get run.
 * The commands here are long — a Lambda function URL is 60 characters before
 * the path — so selection is genuinely awkward and the copy button is not a
 * nicety.
 *
 * `copyText` is separate from `children` because the rendered version carries
 * syntax colouring and comments, while the copied version should be exactly
 * what a shell wants.
 */
export default function CodeBlock({
  children,
  copyText,
  label,
  wrap = false,
  className = "",
}: {
  children: ReactNode;
  copyText: string;
  /** Shown above the block; also names what gets copied. */
  label?: string;
  /**
   * Wrap instead of scrolling sideways.
   *
   * For shell commands, which are one long line ending in a function URL and
   * were being cut off mid-hostname — a reader could not see what they were
   * being asked to run. Shell already treats a wrapped line as one line, so
   * nothing is lost. Left off for source code, where wrapping breaks the
   * indentation that carries the structure.
   */
  wrap?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* Clipboard blocked (insecure context, or the user said no). The text is
         still on screen and selectable, so there is nothing to recover from. */
    }
  }

  return (
    <div className={`group relative ${className}`}>
      {label && (
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="eyebrow">{label}</span>
        </div>
      )}

      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Copied" : `Copy ${label ?? "code"}`}
        /* Always visible, not hover-revealed. A hover-only control does not
           exist on a touch screen, and this is the main thing you do with a
           code block. */
        className="absolute right-2 top-2 z-10 inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-hairline bg-surface px-2 py-1 text-[11px] text-ink-2 opacity-80 shadow-elev-sm transition-all hover:border-hairline-strong hover:text-ink hover:opacity-100 focus-visible:opacity-100"
        style={label ? { top: "1.9rem" } : undefined}
      >
        {copied ? (
          <>
            <CheckIcon /> copied
          </>
        ) : (
          <>
            <CopyIcon /> copy
          </>
        )}
      </button>

      <pre
        className={`scroll-slim rounded-lg border border-hairline bg-surface-2 p-4 pr-16 text-[12px] leading-relaxed ${
          wrap ? "whitespace-pre-wrap break-words" : "overflow-x-auto"
        }`}
      >
        <code className="font-mono text-ink-2">{children}</code>
      </pre>
    </div>
  );
}

function CopyIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="text-good"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
