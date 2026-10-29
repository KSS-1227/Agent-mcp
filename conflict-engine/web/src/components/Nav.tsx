"use client";

import { useEffect, useState } from "react";
import ThemeToggle from "./ThemeToggle";
import ServiceStatus from "./ServiceStatus";
import { REPO_URL } from "@/lib/content";

const LINKS = [
  { href: "#try", label: "Try it" },
  { href: "#problem", label: "Problem" },
  { href: "#mechanism", label: "How it works" },
  { href: "#why-cockroachdb", label: "Why CockroachDB" },
  { href: "#benchmark", label: "Benchmark" },
  { href: "#architecture", label: "Architecture" },
  { href: "#use-it", label: "Use it" },
];

export default function Nav() {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string>("");
  const [progress, setProgress] = useState(0);

  /**
   * Where am I, and how much is left?
   *
   * Both questions get sharper the longer the page, and this one is long even
   * after cutting a quarter of its height. The progress bar answers the second
   * continuously; the highlighted link answers the first.
   *
   * Progress is read from scroll position rather than from the observer,
   * because a section-based estimate jumps in uneven steps — sections are not
   * the same height, so the bar would move fast through short ones and stall
   * through the benchmark.
   */
  useEffect(() => {
    const ids = LINKS.map((l) => l.href.slice(1));
    const sections = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);

    const onScroll = () => {
      const doc = document.documentElement;
      const scrollable = doc.scrollHeight - doc.clientHeight;
      setProgress(scrollable > 0 ? Math.min(1, doc.scrollTop / scrollable) : 0);
    };

    // The topmost section whose start is above the reading line wins. An
    // intersection-ratio approach picks whichever section is *most* visible,
    // which flickers between two when a short one sits fully inside the
    // viewport next to a tall one.
    //
    // The line sits high deliberately. At 35% of the viewport it was far enough
    // down that a short section handed the highlight to its successor while the
    // reader was still inside it: scroll 200px into a 500px section and the next
    // section's top has already crossed a 315px line. Sections here run from
    // ~450px to ~1800px, so the line has to clear the shortest of them.
    const READING_LINE = 0.16;
    const onSpy = () => {
      const line = window.innerHeight * READING_LINE;
      let current = "";
      for (const el of sections) {
        if (el.getBoundingClientRect().top <= line) current = el.id;
      }
      setActive(current);
    };

    const onBoth = () => {
      onScroll();
      onSpy();
    };
    onBoth();
    window.addEventListener("scroll", onBoth, { passive: true });
    window.addEventListener("resize", onBoth);
    return () => {
      window.removeEventListener("scroll", onBoth);
      window.removeEventListener("resize", onBoth);
    };
  }, []);

  return (
    <header className="sticky top-0 z-30 border-b border-hairline bg-page/70 backdrop-blur-xl backdrop-saturate-150 relative">
      <nav
        aria-label="Main"
        className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-5 sm:px-8"
      >
        <a href="#top" className="flex items-center gap-2.5">
          <Mark />
          <span className="font-mono text-sm font-semibold tracking-tight text-ink">
            INTERLOCK
          </span>
        </a>

        <ul className="hidden items-center gap-7 lg:flex">
          {LINKS.map((l) => {
            const isActive = active === l.href.slice(1);
            return (
              <li key={l.href}>
                <a
                  href={l.href}
                  aria-current={isActive ? "true" : undefined}
                  className={`relative text-[13px] transition-colors ${
                    isActive ? "text-ink" : "text-ink-2 hover:text-ink"
                  }`}
                >
                  {l.label}
                  {isActive && (
                    <span
                      className="absolute -bottom-1.5 left-0 h-px w-full bg-accent"
                      aria-hidden="true"
                    />
                  )}
                </a>
              </li>
            );
          })}
        </ul>

        <div className="flex items-center gap-2">
          {/* Live, not decorative — see ServiceStatus. */}
          <ServiceStatus />
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="hidden h-9 items-center rounded-md px-2.5 text-[13px] text-ink-2 transition-colors hover:text-ink lg:inline-flex"
          >
            GitHub
          </a>
          {/* The bar carries the primary action too, so it survives the scroll
              past the hero — by section three the reader has the argument and
              nowhere to act on it. */}
          <a
            href="#use-it"
            className="btn btn-primary hidden !px-3.5 !py-2 text-[13px] sm:inline-flex"
          >
            Get a key
          </a>
          <ThemeToggle />
          <button
            type="button"
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((v) => !v)}
            className="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-md border border-hairline text-ink-2 lg:hidden"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              {open ? (
                <path d="M18 6 6 18M6 6l12 12" />
              ) : (
                <path d="M3 6h18M3 12h18M3 18h18" />
              )}
            </svg>
          </button>
        </div>
      </nav>

      {/* How much is left. Sits on the header's bottom edge so it reads as part
          of the chrome rather than as content. */}
      <div
        className="absolute inset-x-0 bottom-0 h-px bg-transparent"
        aria-hidden="true"
      >
        <div
          className="h-full origin-left bg-accent transition-transform duration-150 ease-out"
          style={{ transform: `scaleX(${progress})` }}
        />
      </div>

      {open && (
        <div id="mobile-nav" className="border-t border-hairline lg:hidden">
          <ul className="mx-auto w-full max-w-6xl px-5 py-2 sm:px-8">
            {LINKS.map((l) => (
              <li key={l.href}>
                <a
                  href={l.href}
                  onClick={() => setOpen(false)}
                  className="block border-b border-hairline py-3 text-sm text-ink-2 last:border-0"
                >
                  {l.label}
                </a>
              </li>
            ))}
            <li>
              <a
                href={REPO_URL}
                target="_blank"
                rel="noreferrer"
                className="block py-3 text-sm text-ink-2"
              >
                GitHub ↗
              </a>
            </li>
            <li className="pb-3 pt-1">
              <a
                href="#use-it"
                onClick={() => setOpen(false)}
                className="btn btn-primary w-full"
              >
                Get an API key
              </a>
            </li>
          </ul>
        </div>
      )}
    </header>
  );
}

/** Two offset bars that cannot pass through each other — a mechanical interlock. */
function Mark() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <rect x="1.5" y="4" width="10" height="4" rx="2" fill="var(--accent)" />
      <rect
        x="8.5"
        y="12"
        width="10"
        height="4"
        rx="2"
        fill="var(--muted)"
      />
    </svg>
  );
}
