import React from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import {
  SESSION_COOKIE_NAME,
  isAuthConfigured,
  safeNextPath,
  verifySessionToken,
} from "@/lib/auth";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = {
  title: "Sign in | Agent Safety MCP",
};

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[]; reason?: string | string[] }>;
}) {
  const params = await searchParams;
  const configured = isAuthConfigured();
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  // Only leave the login screen when this runtime is configured AND the session
  // verifies. Redirecting while the middleware still refuses the request (its env
  // snapshot can lag behind) is what created the redirect loop.
  if (configured && token && (await verifySessionToken(token))) {
    redirect(safeNextPath(params.next));
  }

  const reason = Array.isArray(params.reason) ? params.reason[0] : params.reason;
  const middlewareUnconfigured = reason === "unconfigured";

  return (
    <div className="min-h-screen w-screen bg-[#F6F5F1] flex items-center justify-center p-6">
      <LoginForm
        configured={configured}
        nextPath={safeNextPath(params.next)}
        unconfigured={middlewareUnconfigured}
      />
    </div>
  );
}
