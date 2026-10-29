"use client";

import { useEffect, useRef, useState } from "react";
import { API_URL } from "@/lib/content";

/**
 * What is running right now, and how we know.
 *
 * A status light is only worth having if it can be red. This one is fed by
 * /v1/health, which derives every entry from state the database already holds —
 * so a stopped changefeed or a cold Bedrock ledger shows here without anyone
 * editing the page.
 *
 * Every row carries its evidence. That is the difference between a status panel
 * and a decoration: a reader who doubts the dot can read the observation behind
 * it, and open the same endpoint themselves.
 *
 * Fails visible, not silent. If the fetch dies the dot goes grey and says the
 * endpoint is unreachable, because a status widget that shows green when it
 * cannot reach anything is the worst possible version of this component.
 */

type Service = {
  name: string;
  vendor: "cockroachdb" | "aws";
  status: "live" | "idle" | "on-demand" | "unknown";
  evidence: string;
};

const DOT: Record<Service["status"], string> = {
  live: "bg-good",
  idle: "bg-warning",
  "on-demand": "bg-accent",
  unknown: "bg-muted",
};

export default function ServiceStatus() {
  const [services, setServices] = useState<Service[] | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_URL}v1/health`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setServices(d.services ?? []);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Close on outside click and on Escape — a panel that traps you is worse than
  // no panel.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const live = services?.filter((s) => s.status === "live").length ?? 0;
  const total = services?.length ?? 0;

  const label = error
    ? "API unreachable"
    : services
      ? `${live}/${total} services live`
      : "checking…";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`Service status: ${label}`}
        className="pill cursor-pointer !py-1 transition-colors hover:border-hairline-strong"
      >
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            error ? "bg-muted" : services ? "bg-good" : "bg-warning"
          } ${services && !error ? "pill-dot-live" : ""}`}
          aria-hidden="true"
        />
        <span className="hidden sm:inline">{label}</span>
        <span className="sm:hidden">{error ? "offline" : `${live}/${total}`}</span>
      </button>

      {open && (
        <div className="card absolute right-0 z-40 mt-2 w-[min(22rem,calc(100vw-2rem))] p-4 shadow-elev-lg">
          <div className="flex items-baseline justify-between gap-2">
            <p className="eyebrow">Live now</p>
            <a
              href={`${API_URL}v1/health`}
              target="_blank"
              rel="noreferrer"
              className="text-[11px] text-muted underline decoration-hairline-strong underline-offset-2 hover:text-ink"
            >
              /v1/health ↗
            </a>
          </div>

          {error && (
            <p className="mt-3 text-[12.5px] leading-relaxed text-serious">
              Could not reach the API. This panel reports what it can see, and
              right now it cannot see anything — which is the point of it.
            </p>
          )}

          {!services && !error && (
            <p className="mt-3 text-[12.5px] text-muted">Asking the service…</p>
          )}

          {services && (
            <>
              <ul className="mt-3 flex flex-col gap-2.5">
                {services.map((s) => (
                  <li key={s.name} className="flex gap-2.5">
                    <span
                      className={`mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full ${DOT[s.status]}`}
                      aria-hidden="true"
                    />
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-baseline gap-x-1.5 text-[12.5px] font-medium text-ink">
                        {s.name}
                        <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
                          {s.vendor === "aws" ? "AWS" : "CockroachDB"}
                        </span>
                      </p>
                      <p className="mt-0.5 text-[11.5px] leading-snug text-ink-2">
                        {s.evidence}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
              <p className="mt-3.5 border-t border-hairline pt-3 text-[11px] leading-relaxed text-muted">
                Each line is derived from state the cluster already holds, not
                from a list in the page. Two are marked on-demand because they
                are opened per adjudication rather than held open — saying so is
                more useful than showing green.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
