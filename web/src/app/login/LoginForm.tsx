"use client";

import React, { useState } from "react";
import { Shield, Lock, AlertCircle } from "lucide-react";

interface LoginFormProps {
  configured: boolean;
  nextPath: string;
  unconfigured: boolean;
}

export const LoginForm: React.FC<LoginFormProps> = ({
  configured,
  nextPath,
  unconfigured,
}) => {
  const [accessToken, setAccessToken] = useState("");
  const [error, setError] = useState<string | null>(
    unconfigured
      ? "This dashboard has no authentication configured, so every protected route is refused."
      : null
  );
  const [pending, setPending] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!configured || pending) return;

    setPending(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(data.error || "Sign-in failed.");
        setPending(false);
        return;
      }

      // Full navigation so the new httpOnly cookie is presented to middleware.
      window.location.assign(nextPath || "/");
    } catch {
      setError("Could not reach the dashboard API. Confirm the web server is running.");
      setPending(false);
    }
  };

  return (
    <div className="w-full max-w-md bg-white border border-[#E5E4DE] rounded-md shadow-sm overflow-hidden">
      <div className="bg-[#242622] px-5 py-4 flex items-center gap-3">
        <div className="w-8 h-8 rounded bg-[#52745B] flex items-center justify-center text-white">
          <Shield className="w-4 h-4" />
        </div>
        <div>
          <div className="text-sm font-semibold text-white">Agent Safety MCP</div>
          <div className="text-[11px] text-[#9B9E96] font-mono">Operational Control Plane</div>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="p-5 space-y-4">
        <div className="flex items-start gap-2 bg-[#FAF4E8] border border-[#E9D8B4] rounded p-2.5 text-[11px] text-[#8C631B]">
          <Lock className="w-3.5 h-3.5 shrink-0 mt-0.5 text-[#B58533]" />
          <p className="leading-relaxed">
            This control plane exposes agent identities, action arguments and audit telemetry.
            Access requires the operator access token configured on the web server
            (<span className="font-mono">DASHBOARD_ACCESS_TOKEN</span>). Sessions are signed,
            expiring, httpOnly cookies.
          </p>
        </div>

        <div className="space-y-1.5">
          <label
            htmlFor="access-token"
            className="text-xs font-medium text-[#252722] block"
          >
            Operator access token
          </label>
          <input
            id="access-token"
            type="password"
            autoComplete="current-password"
            value={accessToken}
            onChange={(event) => setAccessToken(event.target.value)}
            disabled={!configured || pending}
            placeholder={configured ? "Enter access token" : "Not configured"}
            className="w-full text-xs bg-[#F9F8F5] border border-[#E5E4DE] rounded px-3 py-2 font-mono focus:outline-none focus:ring-1 focus:ring-[#52745B] focus:border-[#52745B] disabled:opacity-60"
          />
        </div>

        {error && (
          <div className="flex items-start gap-2 text-[11px] text-[#872B28] bg-[#F9ECEB] border border-[#E5BCB9] rounded p-2.5">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span className="leading-relaxed">{error}</span>
          </div>
        )}

        {!configured && (
          <div className="text-[11px] text-[#777A73] space-y-1.5 border-t border-[#E5E4DE] pt-3">
            <p className="font-semibold text-[#252722]">Configuration required</p>
            <p className="leading-relaxed">
              Add both variables to <span className="font-mono">web/.env.local</span> (see{" "}
              <span className="font-mono">web/.env.example</span>) and restart the web server:
            </p>
            <ul className="font-mono text-[10.5px] space-y-0.5 pl-3">
              <li>DASHBOARD_ACCESS_TOKEN (16+ chars)</li>
              <li>DASHBOARD_SESSION_SECRET (32+ chars)</li>
            </ul>
            <p className="leading-relaxed">
              Generate values locally, for example with{" "}
              <span className="font-mono">node -e &quot;console.log(require(&apos;crypto&apos;).randomBytes(32).toString(&apos;hex&apos;))&quot;</span>.
              These are server-only secrets: never prefix them with{" "}
              <span className="font-mono">NEXT_PUBLIC_</span>.
            </p>
          </div>
        )}

        <button
          type="submit"
          disabled={!configured || pending || accessToken.trim().length === 0}
          className="w-full py-2 text-xs font-semibold text-white bg-[#52745B] rounded hover:bg-[#44624C] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {pending ? "Verifying..." : "Sign in"}
        </button>
      </form>
    </div>
  );
};
