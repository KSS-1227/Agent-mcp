import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, sessionCookieOptions } from "@/lib/auth";
import { getScope } from "@/lib/data-scope";

export async function POST(request: Request) {
  const scope = await getScope(request);
  if (!scope) return NextResponse.json({ error: "Authentication required.", code: "UNAUTHENTICATED" }, { status: 401 });
  if (scope.kind === "user") return NextResponse.json({ error: "Operator access required.", code: "OPERATOR_REQUIRED" }, { status: 403 });
  const response = NextResponse.json({ ok: true });
  // Same attributes as the cookie created by /api/auth/login, so the browser
  // clears the exact cookie the middleware and requireSession() read.
  response.cookies.set(SESSION_COOKIE_NAME, "", {
    ...sessionCookieOptions(),
    maxAge: 0,
  });
  return response;
}
