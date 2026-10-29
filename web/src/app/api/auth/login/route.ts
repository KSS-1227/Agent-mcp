import { NextResponse } from "next/server";
import {
  AUTH_NOT_CONFIGURED_MESSAGE,
  SESSION_COOKIE_NAME,
  checkAccessToken,
  createSessionToken,
  isAuthConfigured,
  sessionCookieOptions,
} from "@/lib/auth";

/** Simple in-memory throttle. Good enough for a single-instance dashboard. */
const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const attempts = new Map<string, { count: number; resetAt: number }>();

function rateLimitKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim();
  return ip && ip.length > 0 ? ip : "local";
}

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_ATTEMPTS;
}

export async function POST(request: Request) {
  if (!isAuthConfigured()) {
    return NextResponse.json(
      { error: AUTH_NOT_CONFIGURED_MESSAGE, code: "AUTH_NOT_CONFIGURED" },
      { status: 503 }
    );
  }

  const key = rateLimitKey(request);
  if (isRateLimited(key)) {
    return NextResponse.json(
      { error: "Too many sign-in attempts. Try again later.", code: "RATE_LIMITED" },
      { status: 429 }
    );
  }

  let accessToken: string | null = null;
  try {
    const body = (await request.json()) as { accessToken?: unknown } | null;
    if (body && typeof body.accessToken === "string") {
      accessToken = body.accessToken;
    }
  } catch {
    accessToken = null;
  }

  if (!accessToken) {
    return NextResponse.json(
      { error: "An access token is required.", code: "INVALID_REQUEST" },
      { status: 400 }
    );
  }

  if (!checkAccessToken(accessToken)) {
    // Deliberate delay to blunt online guessing without leaking why it failed.
    await new Promise((resolve) => setTimeout(resolve, 350));
    return NextResponse.json(
      { error: "Access token rejected.", code: "INVALID_CREDENTIALS" },
      { status: 401 }
    );
  }

  attempts.delete(key);
  const session = await createSessionToken();
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE_NAME, session, sessionCookieOptions());
  return response;
}
