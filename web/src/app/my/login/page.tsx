"use client";

import { useState } from "react";
import { AlertCircle, CheckCircle2, Eye, EyeOff, Loader2, Lock, Mail, Shield } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Mode = "signin" | "signup";

const inputClass =
  "w-full rounded-lg border border-[#DAD8CF] bg-[#FAF9F6] py-2.5 pl-10 pr-10 text-sm text-[#252722] placeholder:text-[#9B9E96] focus:border-[#4F6F52] focus:outline-none focus:ring-2 focus:ring-[#4F6F52]/20";

export default function MyLoginPage() {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  function switchMode(next: Mode) {
    setMode(next);
    setError("");
    setNotice("");
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setNotice("");
    if (!email.trim()) {
      setError("Enter your email address.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setBusy(true);
    const supabase = createClient();
    if (mode === "signup") {
      const { data, error: signUpError } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: { emailRedirectTo: `${window.location.origin}/` },
      });
      if (signUpError) setError(signUpError.message);
      else if (data.session) window.location.assign("/");
      else setNotice("Account created. Check your inbox to confirm your email, then sign in.");
    } else {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (signInError) setError(signInError.message);
      else window.location.assign("/");
    }
    setBusy(false);
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#F6F5F1] px-4 py-10 text-[#252722]">
      <div className="w-full max-w-md">
        <div className="overflow-hidden rounded-2xl border border-[#E4E2DA] bg-white shadow-sm">
          <div className="flex items-center gap-3 bg-[#252722] px-6 py-5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#4F6F52]">
              <Shield className="h-5 w-5 text-white" />
            </div>
            <div>
              <p className="font-semibold leading-tight text-white">Agent Safety MCP</p>
              <p className="font-mono text-[11px] text-[#A9B2A3]">Your agents, safely coordinated</p>
            </div>
          </div>

          <div className="p-6">
            <div className="mb-5 grid grid-cols-2 rounded-lg bg-[#F0EEE8] p-1 text-sm font-medium">
              {(["signin", "signup"] as Mode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => switchMode(m)}
                  className={`rounded-md py-2 transition ${
                    mode === m ? "bg-white text-[#252722] shadow-sm" : "text-[#6B6E66] hover:text-[#252722]"
                  }`}
                >
                  {m === "signin" ? "Sign in" : "Create account"}
                </button>
              ))}
            </div>

            <h1 className="text-lg font-semibold">
              {mode === "signin" ? "Welcome back" : "Create your account"}
            </h1>
            <p className="mb-5 mt-1 text-sm text-[#6B6E66]">
              {mode === "signin"
                ? "Sign in to see your agents and what they are doing."
                : "Sign up to get your own agent and a live view of its activity."}
            </p>

            <form onSubmit={onSubmit} className="space-y-4" noValidate>
              <div>
                <label htmlFor="email" className="mb-1.5 block text-sm font-medium">Email</label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#9B9E96]" />
                  <input
                    id="email"
                    type="email"
                    autoComplete="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className={inputClass}
                  />
                </div>
              </div>

              <div>
                <label htmlFor="password" className="mb-1.5 block text-sm font-medium">Password</label>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#9B9E96]" />
                  <input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete={mode === "signin" ? "current-password" : "new-password"}
                    placeholder="At least 8 characters"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={inputClass}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9B9E96] hover:text-[#252722]"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {error && (
                <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
              {notice && (
                <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{notice}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={busy}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#4F6F52] py-2.5 text-sm font-semibold text-white transition hover:bg-[#44604A] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {mode === "signin" ? "Sign in" : "Create account"}
              </button>
            </form>
          </div>
        </div>
        <p className="mt-4 text-center text-xs text-[#9B9E96]">
          Crash-safe actions and conflict detection for AI agents.
        </p>
      </div>
    </main>
  );
}
