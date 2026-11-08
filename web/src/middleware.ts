import { NextResponse, type NextRequest } from "next/server";
import {
  AUTH_NOT_CONFIGURED_MESSAGE,
  LOGIN_PATH,
  SESSION_COOKIE_NAME,
  authNotConfiguredPageResponse,
  isAuthConfigured,
  verifySessionToken,
} from "@/lib/auth";

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isApiRoute = pathname.startsWith("/api/");

  // Fail closed, and never redirect from here. This runtime receives its env once,
  // at server start, so a server started before `.env.local` existed reports "not
  // configured" here while the login route (Node runtime, re-reads `.env.local`)
  // already issues valid sessions. Redirecting to /login in that state bounces
  // against the login page's "already signed in" redirect forever.
  if (!isAuthConfigured()) {
    return isApiRoute
      ? NextResponse.json(
          { error: AUTH_NOT_CONFIGURED_MESSAGE, code: "AUTH_NOT_CONFIGURED" },
          { status: 503 }
        )
      : authNotConfiguredPageResponse();
  }

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (token && (await verifySessionToken(token))) {
    return NextResponse.next();
  }

  if (isApiRoute) {
    return NextResponse.json(
      { error: "Authentication required.", code: "UNAUTHENTICATED" },
      { status: 401 }
    );
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/my/login";
  loginUrl.search = "";
  // User login is the public front door. Operator pages still require the operator
  // cookie; unauthenticated visitor → /my/login (no next parameter: operator targets
  // are meaningless in the user area).
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Everything except Next.js internals, public paths, and the user area.
  // Excludes (negative lookahead):
  //   _next/static, _next/image   — Next.js internals
  //   favicon\.ico$               — browser requests (exact match)
  //   login$                      — public redirect to /my/login (exact match)
  //   operator/login(?:/|$)       — operator password form (public, not linked)
  //   api/auth(?:/|$)             — operator login/logout endpoints
  //   my(?:/|$)                   — user area (Supabase Auth)
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico$|login$|operator/login(?:/|$)|api/auth(?:/|$)|my(?:/|$)).*)"],
};
