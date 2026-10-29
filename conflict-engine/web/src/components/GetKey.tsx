"use client";

import { useState } from "react";
import { API_URL } from "@/lib/content";
import CodeBlock from "./CodeBlock";

/**
 * Self-serve key issuance, on the page.
 *
 * A service that requires a conversation before anyone can evaluate it does not
 * get evaluated. This issues a real key against the real API — the same call
 * the curl example makes.
 *
 * The key is shown once and never again, because only a SHA-256 of it is
 * stored. That is worth saying plainly at the moment of issuance rather than
 * burying in docs, since it is the one instruction a user cannot recover from
 * ignoring.
 */
export default function GetKey() {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [name, setName] = useState("");
  const [result, setResult] = useState<{
    key: string;
    tenant: { slug: string };
    limits: { dailyCalls: number; dailyUsd: number };
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function issue(e: React.FormEvent) {
    e.preventDefault();
    setState("loading");
    setError(null);
    try {
      const res = await fetch(`${API_URL}v1/keys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name || "Anonymous", label: "web" }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error ?? `Request failed (${res.status})`);
        setState("error");
        return;
      }
      setResult(data);
      setState("done");
    } catch {
      // Deliberately not "the endpoint may be cold-starting". It said that for a
      // while during a CORS misconfiguration, and the guess sent everyone
      // looking in the wrong place — including us. A fetch that throws tells you
      // nothing about why; say that, and offer the check that does.
      setError("Could not reach the API.");
      setState("error");
    }
  }

  async function copy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked; the key is visible and selectable anyway */
    }
  }

  if (state === "done" && result) {
    // The key, already substituted into a command that works. Handing someone a
    // credential and stopping there leaves them to assemble a first request out
    // of an endpoint list — which is the moment most people close the tab.
    const firstCall =
      `curl -s -X POST ${API_URL}v1/agents \\\n` +
      `  -H 'authorization: Bearer ${result.key}' \\\n` +
      `  -H 'content-type: application/json' \\\n` +
      `  -d '{"name":"My Scheduler"}'`;

    return (
      <div className="mt-4 rounded-lg border border-accent/40 bg-surface-2 p-4">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-accent">
          Your key — shown once
        </p>

        <div className="mt-3 flex items-center gap-2">
          <code className="scroll-slim min-w-0 flex-1 overflow-x-auto rounded border border-hairline bg-surface px-3 py-2 font-mono text-[12px] text-ink">
            {result.key}
          </code>
          <button
            type="button"
            onClick={copy}
            className="btn btn-secondary shrink-0 !px-3 !py-2 !text-[12px]"
          >
            {copied ? "copied" : "copy"}
          </button>
        </div>

        <p className="mt-3 text-[12px] leading-relaxed text-ink-2">
          Tenant <span className="font-mono text-ink">{result.tenant.slug}</span> ·{" "}
          {result.limits.dailyCalls.toLocaleString()} calls and $
          {result.limits.dailyUsd}/day.
        </p>
        <p className="mt-2 text-[12px] leading-relaxed text-muted">
          Only a SHA-256 of this key is stored, so it cannot be recovered or
          shown again. Your agents get their own isolated tenant — no other
          caller&rsquo;s commits can adjudicate your intents.
        </p>

        <div className="mt-4 border-t border-hairline pt-4">
          <CodeBlock wrap label="Next: register your first agent" copyText={firstCall}>
            <span className="text-muted"># your key is already in this command</span>
            {"\n"}
            {firstCall}
          </CodeBlock>
          <p className="mt-2 text-[12px] leading-relaxed text-muted">
            It returns an <span className="font-mono text-ink-2">agent.id</span>.
            Declare an intent with it, commit through{" "}
            <span className="font-mono text-ink-2">/v1/commits</span>, and every
            agent your write threatened gets a ruling.
          </p>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={issue} className="mt-4">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your team or project name"
          maxLength={80}
          className="h-10 min-w-0 flex-1 rounded-lg border border-hairline bg-surface-2 px-3 text-[13px] text-ink placeholder:text-muted"
        />
        <button
          type="submit"
          disabled={state === "loading"}
          className="btn btn-primary shrink-0 disabled:cursor-wait"
        >
          {state === "loading" ? "issuing…" : "Get an API key"}
        </button>
      </div>
      {error && (
        <div className="mt-2.5 rounded-lg border border-serious/40 bg-serious/5 px-3 py-2.5">
          <p className="text-[12px] font-medium text-serious">{error}</p>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-2">
            Press the button again — the first call can be slow while the
            function starts. If it keeps failing,{" "}
            <a
              href={`${API_URL}v1/health`}
              target="_blank"
              rel="noreferrer"
              className="underline decoration-hairline-strong underline-offset-2 hover:text-ink"
            >
              open /v1/health
            </a>{" "}
            — if that returns JSON, the service is up and the problem is in your
            browser rather than ours.
          </p>
        </div>
      )}
      {/* The number here was wrong — it said five while the API allowed
          twenty-five, which is the kind of small false claim that costs more
          credibility than the fact it misstates. It is now a hundred, and this
          sentence stays deliberately vague rather than re-inviting the drift. */}
      <p className="mt-2 text-[12px] text-muted">
        Free, instant, no signup. Generous per-address limit, reset daily.
      </p>
    </form>
  );
}
