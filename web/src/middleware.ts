import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import {
  AUTH_NOT_CONFIGURED_MESSAGE,
  SESSION_COOKIE_NAME,
  authNotConfiguredPageResponse,
  isAuthConfigured,
  verifySessionToken,
} from "@/lib/auth";

const USER_SCOPED_PAGE_PATHS = new Set([
  "/",
  "/agents",
  "/actions",
  "/intents",
  "/conflicts",
  "/recovery",
]);

const USER_SCOPED_API_PATHS = new Set([
  "/api/overview",
  "/api/agents",
  "/api/actions",
  "/api/intents",
  "/api/episodes",
  "/api/recovery",
  "/api/conflicts",
]);

type RefreshedCookie = { name: string; value: string; options?: CookieOptions };

function copyCookies(response: NextResponse, cookies: RefreshedCookie[]) {
  cookies.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
  return response;
}

function cleanDashboardHeaders(request: NextRequest): Headers {
  const headers = new Headers(request.headers);
  for (const key of [...headers.keys()]) {
    if (key.toLowerCase().startsWith("x-dashboard-")) headers.delete(key);
  }
  return headers;
}

function nextWithScope(
  request: NextRequest,
  scope: "operator" | "user",
  email?: string | null,
  baseHeaders: Headers = cleanDashboardHeaders(request)
) {
  const headers = new Headers(baseHeaders);
  headers.set("x-dashboard-scope", scope);
  if (scope === "user" && email) headers.set("x-dashboard-user-email", email);
  return NextResponse.next({ request: { headers } });
}

export async function middleware(request: NextRequest) {
  // Strip caller-supplied scope metadata before making any auth or access decision.
  const sanitizedHeaders = cleanDashboardHeaders(request);
  const { pathname } = request.nextUrl;
  const isApiRoute = pathname.startsWith("/api/");
  const operatorToken = request.cookies.get(SESSION_COOKIE_NAME)?.value;

  if (
    isAuthConfigured() &&
    operatorToken &&
    (await verifySessionToken(operatorToken))
  ) {
    return nextWithScope(request, "operator", null, sanitizedHeaders);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const supabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

  if (!isAuthConfigured() && !supabaseConfigured) {
    return isApiRoute
      ? NextResponse.json(
          { error: AUTH_NOT_CONFIGURED_MESSAGE, code: "AUTH_NOT_CONFIGURED" },
          { status: 503 }
        )
      : authNotConfiguredPageResponse();
  }

  let refreshedCookies: RefreshedCookie[] = [];
  let verifiedUser: { id: string; email?: string } | null = null;

  if (supabaseConfigured) {
    try {
      const supabase = createServerClient(supabaseUrl!, supabaseAnonKey!, {
        cookies: {
          getAll: () => request.cookies.getAll(),
          setAll: (cookiesToSet) => {
            refreshedCookies = cookiesToSet;
            cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          const refreshedCookieHeader = request.headers.get("cookie");
          if (refreshedCookieHeader) sanitizedHeaders.set("cookie", refreshedCookieHeader);
          },
        },
      });
      const { data, error } = await supabase.auth.getUser();
      if (!error && data.user) verifiedUser = data.user;
    } catch {
      verifiedUser = null;
    }
  }

  const allowedForUser = isApiRoute
    ? USER_SCOPED_API_PATHS.has(pathname)
    : USER_SCOPED_PAGE_PATHS.has(pathname);

  if (verifiedUser && allowedForUser) {
    return copyCookies(
      nextWithScope(request, "user", verifiedUser.email, sanitizedHeaders),
      refreshedCookies
    );
  }

  if (verifiedUser) {
    if (isApiRoute) {
      return copyCookies(
        NextResponse.json(
          { error: "Operator access required.", code: "OPERATOR_REQUIRED" },
          { status: 403 }
        ),
        refreshedCookies
      );
    }
    return copyCookies(NextResponse.redirect(new URL("/", request.url)), refreshedCookies);
  }

  if (isApiRoute) {
    return copyCookies(
      NextResponse.json(
        { error: "Authentication required.", code: "UNAUTHENTICATED" },
        { status: 401 }
      ),
      refreshedCookies
    );
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/my/login";
  loginUrl.search = "";
  return copyCookies(NextResponse.redirect(loginUrl), refreshedCookies);
}

export const config = {
  // Only Next.js assets and exact public auth entry/exit paths bypass middleware.
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico$|login$|operator/login$|api/auth/login$|my/login$|my/signout$).*)",
  ],
};
