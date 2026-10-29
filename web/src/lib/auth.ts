/**
 * Server-side session gate for the dashboard.
 *
 * Design notes (see the remediation report for the full rationale):
 *  - No new dependency: signatures use Web Crypto HMAC-SHA256, which is
 *    available in both the Node and Edge runtimes that Next.js middleware uses.
 *  - The session is a signed, expiring, httpOnly cookie. It is verified on every
 *    request by middleware AND by each data route, so a matcher mistake cannot
 *    expose data.
 *  - The login credential is a single operator secret held in server-only env
 *    vars. This is an access gate, not a multi-user identity provider.
 *  - Fail closed: if the env vars are absent, protected routes answer 503 instead
 *    of silently running unauthenticated.
 */
import { NextResponse } from "next/server";

export const SESSION_COOKIE_NAME = "asmcp_session";
export const SESSION_TTL_SECONDS = 8 * 60 * 60;
export const LOGIN_PATH = "/login";
export const AUTH_ENTRY_PATH = "/api/auth";

export const AUTH_NOT_CONFIGURED_MESSAGE =
  "Dashboard authentication is not configured. Set DASHBOARD_ACCESS_TOKEN and DASHBOARD_SESSION_SECRET for the web server, then restart it.";

const MIN_ACCESS_TOKEN_LENGTH = 16;
const MIN_SESSION_SECRET_LENGTH = 32;

export interface SessionPayload {
  v: 1;
  sub: "operator";
  iat: number;
  exp: number;
}

const encoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function getAccessToken(): string | null {
  const token = process.env.DASHBOARD_ACCESS_TOKEN?.trim();
  return token && token.length >= MIN_ACCESS_TOKEN_LENGTH ? token : null;
}

function getSessionSecret(): string | null {
  const secret = process.env.DASHBOARD_SESSION_SECRET?.trim();
  return secret && secret.length >= MIN_SESSION_SECRET_LENGTH ? secret : null;
}

/** Both env vars are required before the dashboard will serve any protected route. */
export function isAuthConfigured(): boolean {
  return Boolean(getAccessToken() && getSessionSecret());
}

/**
 * Terminal HTML response for a page requested from a server that has no dashboard
 * credentials.
 *
 * This must never be a redirect. Next.js hands the middleware runtime its env
 * snapshot once, at server start, while Node-side code re-reads `.env.local`, so a
 * long-running server can have a configured login route and an unconfigured
 * middleware at the same time. Redirecting that state to `/login` bounces against
 * the login page's own "already signed in" redirect forever
 * (ERR_TOO_MANY_REDIRECTS). Answering with a terminal page fails closed and says
 * why.
 */
export function authNotConfiguredPageResponse(): NextResponse {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard authentication is not configured</title>
<style>
body{margin:0;padding:48px 16px;background:#F6F5F1;color:#252722;font:14px/1.6 ui-sans-serif,system-ui,-apple-system,sans-serif}
main{max-width:600px;margin:0 auto;background:#fff;border:1px solid #E5E4DE;border-radius:6px;padding:24px}
h1{font-size:16px;margin:0 0 12px}
p{margin:0 0 10px}
code{background:#F1EFE9;border-radius:3px;padding:1px 5px;font-size:12px}
</style>
</head>
<body>
<main>
<h1>Dashboard authentication is not configured</h1>
<p>This server has no <code>DASHBOARD_ACCESS_TOKEN</code> / <code>DASHBOARD_SESSION_SECRET</code>, so every protected route is refused.</p>
<p>Add both variables to <code>web/.env.local</code> and <strong>restart the web server</strong>. The middleware runtime reads the environment once, when the server starts, so a server that is already running keeps its old, empty snapshot even after the file changes.</p>
<p>This is a fail-closed response: no dashboard data is served and no redirect is issued while the server has no credentials.</p>
</main>
</body>
</html>`;

  return new NextResponse(html, {
    status: 503,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/**
 * Only ever return an in-app path. Returning `/login` or an auth endpoint here
 * would make the login page redirect to itself once a session exists.
 */
export function safeNextPath(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//")) {
    return "/";
  }

  const path = raw.split("?")[0];
  if (
    path === LOGIN_PATH ||
    path === AUTH_ENTRY_PATH ||
    path.startsWith(`${LOGIN_PATH}/`) ||
    path.startsWith(`${AUTH_ENTRY_PATH}/`)
  ) {
    return "/";
  }

  return raw;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function createSessionToken(now: number = Date.now()): Promise<string> {
  const secret = getSessionSecret();
  if (!secret) {
    throw new Error("DASHBOARD_SESSION_SECRET is not configured");
  }

  const issuedAt = Math.floor(now / 1000);
  const payload: SessionPayload = {
    v: 1,
    sub: "operator",
    iat: issuedAt,
    exp: issuedAt + SESSION_TTL_SECONDS,
  };

  const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(body));
  return `${body}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function verifySessionToken(
  token: string,
  now: number = Date.now()
): Promise<boolean> {
  const secret = getSessionSecret();
  if (!secret) return false;

  const parts = token.split(".");
  if (parts.length !== 2) return false;

  const [body, signature] = parts;

  try {
    const signatureBytes = base64UrlDecode(signature);
    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      signatureBytes,
      encoder.encode(body)
    );
    if (!valid) return false;

    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(body))) as SessionPayload;
    return (
      payload?.v === 1 &&
      typeof payload.exp === "number" &&
      payload.exp * 1000 > now &&
      payload.sub === "operator"
    );
  } catch {
    return false;
  }
}

/** Constant-time comparison used for the operator access token. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function checkAccessToken(candidate: string): boolean {
  const expected = getAccessToken();
  if (!expected) return false;
  return timingSafeEqual(candidate.trim(), expected);
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}

export function readSessionCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;

  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE_NAME) {
      return decodeURIComponent(rest.join("="));
    }
  }
  return null;
}

/**
 * Defence in depth for route handlers: middleware already blocks these routes,
 * but every handler re-validates the signed session itself.
 * Returns a response to send when the caller is not authenticated.
 */
export async function requireSession(request: Request): Promise<NextResponse | null> {
  if (!isAuthConfigured()) {
    return NextResponse.json(
      { error: AUTH_NOT_CONFIGURED_MESSAGE, code: "AUTH_NOT_CONFIGURED" },
      { status: 503 }
    );
  }

  const token = readSessionCookie(request);
  if (!token || !(await verifySessionToken(token))) {
    return NextResponse.json(
      { error: "Authentication required.", code: "UNAUTHENTICATED" },
      { status: 401 }
    );
  }

  return null;
}
