"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function MyLoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(mode: "signin" | "signup") {
    setBusy(true);
    setMessage("");
    const supabase = createClient();
    if (mode === "signup") {
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: `${window.location.origin}/my/agents` },
      });
      setMessage(error ? error.message : "Check your email to confirm your account, then sign in.");
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setMessage(error.message);
      else window.location.href = "/my/agents";
    }
    setBusy(false);
  }

  return (
    <main style={{ maxWidth: 360, margin: "80px auto", fontFamily: "sans-serif" }}>
      <h1>Agent Safety MCP</h1>
      <p>Sign in to see your agents.</p>
      <input placeholder="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} style={{ display: "block", width: "100%", margin: "8px 0", padding: 8 }} />
      <input placeholder="Password (8+ characters)" type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ display: "block", width: "100%", margin: "8px 0", padding: 8 }} />
      <button disabled={busy} onClick={() => submit("signin")} style={{ padding: "8px 16px", marginRight: 8 }}>Sign in</button>
      <button disabled={busy} onClick={() => submit("signup")} style={{ padding: "8px 16px" }}>Create account</button>
      {message && <p>{message}</p>}
    </main>
  );
}