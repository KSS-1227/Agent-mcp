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
  loginUrl.pathname = LOGIN_PATH;
  loginUrl.search = "";
  // Send the operator back to the page they asked for (path only, never a URL).
  // `next` is re-validated by the login page before it is followed.
  if (pathname !== "/") {
    loginUrl.searchParams.set("next", pathname);
  }
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Everything except Next.js internals, the login screen and the auth endpoints.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|login|api/auth).*)"],
};
