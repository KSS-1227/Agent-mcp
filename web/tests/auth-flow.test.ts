import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import {
  AUTH_NOT_CONFIGURED_MESSAGE,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  createSessionToken,
  isAuthConfigured,
  readSessionCookie,
  requireSession,
  safeNextPath,
  sessionCookieOptions,
  verifySessionToken,
} from "@/lib/auth";
import { middleware, config as middlewareConfig } from "@/middleware";
import { POST as loginRoute } from "@/app/api/auth/login/route";
import { POST as logoutRoute } from "@/app/api/auth/logout/route";

const ACCESS_TOKEN = "test-access-token-0123456789abcdef";
const SESSION_SECRET = "test-session-secret-0123456789abcdef0123456789abcdef";

/** Unique per request so the login route's in-memory throttle never interferes. */
let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `10.0.0.${ipCounter}`;
}

function loginRequest(body: unknown, ip = nextIp()): Request {
  return new Request("http://localhost:3000/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

function pageRequest(path: string, sessionToken?: string): NextRequest {
  const headers = new Headers();
  if (sessionToken) {
    headers.set("cookie", `${SESSION_COOKIE_NAME}=${sessionToken}`);
  }
  return new NextRequest(new URL(`http://localhost:3000${path}`), { headers });
}

function apiRequest(path: string, sessionToken?: string): Request {
  const headers = new Headers();
  if (sessionToken) {
    headers.set("cookie", `${SESSION_COOKIE_NAME}=${sessionToken}`);
  }
  return new Request(`http://localhost:3000${path}`, { headers });
}

async function issueSessionCookie(): Promise<string> {
  const response = await loginRoute(loginRequest({ accessToken: ACCESS_TOKEN }));
  expect(response.status).toBe(200);
  const raw = response.headers.get("set-cookie") ?? "";
  return raw.split(";")[0];
}

beforeEach(() => {
  process.env.DASHBOARD_ACCESS_TOKEN = ACCESS_TOKEN;
  process.env.DASHBOARD_SESSION_SECRET = SESSION_SECRET;
});

afterEach(() => {
  process.env.DASHBOARD_ACCESS_TOKEN = ACCESS_TOKEN;
  process.env.DASHBOARD_SESSION_SECRET = SESSION_SECRET;
});

describe("configuration gate", () => {
  it("is configured only when both variables are strong enough", () => {
    expect(isAuthConfigured()).toBe(true);

    process.env.DASHBOARD_ACCESS_TOKEN = "too-short";
    expect(isAuthConfigured()).toBe(false);

    process.env.DASHBOARD_ACCESS_TOKEN = ACCESS_TOKEN;
    process.env.DASHBOARD_SESSION_SECRET = "too-short";
    expect(isAuthConfigured()).toBe(false);

    delete process.env.DASHBOARD_ACCESS_TOKEN;
    expect(isAuthConfigured()).toBe(false);
  });
});

describe("session token", () => {
  it("round-trips a freshly created token", async () => {
    const token = await createSessionToken();
    expect(await verifySessionToken(token)).toBe(true);
  });

  it("rejects a tampered payload", async () => {
    const token = await createSessionToken();
    const [body, signature] = token.split(".");
    const forgedPayload = btoa(JSON.stringify({ v: 1, sub: "operator", iat: 0, exp: 99_999_999_999 }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(forgedPayload).not.toBe(body);
    expect(await verifySessionToken(`${forgedPayload}.${signature}`)).toBe(false);
  });

  it("rejects a tampered signature", async () => {
    const token = await createSessionToken();
    const [body] = token.split(".");
    expect(await verifySessionToken(`${body}.not-a-signature`)).toBe(false);
  });

  it("rejects an expired session", async () => {
    const longAgo = Date.now() - (SESSION_TTL_SECONDS + 60) * 1000;
    const token = await createSessionToken(longAgo);
    expect(await verifySessionToken(token)).toBe(false);
  });

  it("rejects a session signed with a different secret", async () => {
    const token = await createSessionToken();
    process.env.DASHBOARD_SESSION_SECRET =
      "rotated-session-secret-0123456789abcdef0123456789abcdef";
    expect(await verifySessionToken(token)).toBe(false);
  });

  it("rejects malformed input and refuses to sign without a secret", async () => {
    expect(await verifySessionToken("")).toBe(false);
    expect(await verifySessionToken("garbage")).toBe(false);
    expect(await verifySessionToken("a.b.c")).toBe(false);

    delete process.env.DASHBOARD_SESSION_SECRET;
    await expect(createSessionToken()).rejects.toThrow(/DASHBOARD_SESSION_SECRET/);
    expect(await verifySessionToken("a.b")).toBe(false);
  });

  it("sets cookie attributes the middleware can read on local HTTP", () => {
    const options = sessionCookieOptions();
    expect(options.path).toBe("/");
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("lax");
    expect(options.maxAge).toBe(SESSION_TTL_SECONDS);
    // `secure` is only on for production builds; the dev server runs over http.
    expect(options.secure).toBe(process.env.NODE_ENV === "production");
  });
});

describe("POST /api/auth/login", () => {
  it("issues the session cookie for the configured token", async () => {
    const response = await loginRoute(loginRequest({ accessToken: ACCESS_TOKEN }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie.toLowerCase()).toContain("samesite=lax");
    expect(setCookie).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
    expect(setCookie).not.toContain("Secure");
  });

  it("rejects a wrong token without setting a cookie", async () => {
    const response = await loginRoute(loginRequest({ accessToken: "wrong-token-value" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("rejects a missing token", async () => {
    const response = await loginRoute(loginRequest({}));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("answers 503 with a clear error when the server is not configured", async () => {
    process.env.DASHBOARD_SESSION_SECRET = "too-short";
    const response = await loginRoute(loginRequest({ accessToken: ACCESS_TOKEN }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "AUTH_NOT_CONFIGURED",
      error: AUTH_NOT_CONFIGURED_MESSAGE,
    });
  });
});

describe("middleware", () => {
  it("keeps public and user paths out of the protected matcher", () => {
    const pattern = new RegExp(`^${middlewareConfig.matcher[0]}$`);
    // Excluded (public/user paths)
    expect(pattern.test("/login")).toBe(false);
    expect(pattern.test("/operator/login")).toBe(false);
    expect(pattern.test("/my/login")).toBe(false);
    expect(pattern.test("/my/agents")).toBe(false);
    expect(pattern.test("/api/auth/login")).toBe(false);
    expect(pattern.test("/api/auth/logout")).toBe(false);
    // Not excluded (protected paths and false positives)
    expect(pattern.test("/loginfoo")).toBe(true);
    expect(pattern.test("/operatorlogin")).toBe(true);
    expect(pattern.test("/mystuff")).toBe(true);
    expect(pattern.test("/api/authx")).toBe(true);
    expect(pattern.test("/api/agents")).toBe(true);
    expect(pattern.test("/agents")).toBe(true);
    expect(pattern.test("/")).toBe(true);
    expect(pattern.test("/conflicts")).toBe(true);
    expect(pattern.test("/api/overview")).toBe(true);
  });

  it("redirects a page request to /my/login without a next parameter", async () => {
    const response = await middleware(pageRequest("/conflicts"));
    expect(response.status).toBe(307);
    const location = response.headers.get("location") ?? "";
    expect(location).toContain("/my/login");
    expect(location).not.toContain("next=");
  });

  it("redirects the root page to /my/login without a next parameter", async () => {
    const response = await middleware(pageRequest("/"));
    expect(response.status).toBe(307);
    const location = response.headers.get("location") ?? "";
    expect(location).toContain("/my/login");
    expect(location).not.toContain("next=");
  });

  it("lets a valid session through to protected pages and APIs", async () => {
    const cookie = await issueSessionCookie();
    const token = cookie.split("=")[1];

    const page = await middleware(pageRequest("/conflicts", token));
    expect(page.status).toBe(200);
    expect(page.headers.get("location")).toBeNull();

    const api = await middleware(pageRequest("/api/overview", token));
    expect(api.status).toBe(200);
    expect(api.headers.get("location")).toBeNull();
  });

  it("treats a tampered or expired cookie as unauthenticated", async () => {
    const expired = await createSessionToken(Date.now() - (SESSION_TTL_SECONDS + 60) * 1000);
    for (const token of ["forged.token", expired]) {
      const response = await middleware(pageRequest("/conflicts", token));
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toContain("/my/login");
    }
  });

  it("answers protected API routes with 401 JSON instead of a redirect", async () => {
    const response = await middleware(pageRequest("/api/overview"));
    expect(response.status).toBe(401);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.json()).toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("fails closed with a terminal page, never a redirect, when unconfigured", async () => {
    delete process.env.DASHBOARD_SESSION_SECRET;

    // Regression guard for ERR_TOO_MANY_REDIRECTS: a redirect here would bounce
    // against the login page's own "already signed in" redirect forever.
    const page = await middleware(pageRequest("/"));
    expect(page.status).toBe(503);
    expect(page.headers.get("location")).toBeNull();
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("DASHBOARD_ACCESS_TOKEN");

    const api = await middleware(pageRequest("/api/overview"));
    expect(api.status).toBe(503);
    expect(api.headers.get("location")).toBeNull();
    expect(await api.json()).toMatchObject({ code: "AUTH_NOT_CONFIGURED" });
  });
});

describe("requireSession", () => {
  it("passes an authenticated request", async () => {
    const cookie = await issueSessionCookie();
    const token = cookie.split("=")[1];
    const request = apiRequest("/api/overview", token);
    expect(readSessionCookie(request)).toBe(token);
    await expect(requireSession(request)).resolves.toBeNull();
  });

  it("returns 401 without a valid session", async () => {
    const unauthenticated = await requireSession(apiRequest("/api/overview"));
    expect(unauthenticated?.status).toBe(401);

    const forged = await requireSession(apiRequest("/api/overview", "forged.token"));
    expect(forged?.status).toBe(401);
  });

  it("returns 503 when the server is not configured", async () => {
    delete process.env.DASHBOARD_ACCESS_TOKEN;
    const response = await requireSession(apiRequest("/api/overview"));
    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({ code: "AUTH_NOT_CONFIGURED" });
  });
});

describe("POST /api/auth/logout", () => {
  it("clears the same cookie the login route sets", async () => {
    const response = await logoutRoute();
    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie.startsWith(`${SESSION_COOKIE_NAME}=;`)).toBe(true);
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie.toLowerCase()).toContain("samesite=lax");
    expect(setCookie).toContain("Max-Age=0");
  });

  it("works without an active session and afterwards the session is gone", async () => {
    const cookie = await issueSessionCookie();
    const token = cookie.split("=")[1];
    expect((await middleware(pageRequest("/conflicts", token))).status).toBe(200);

    expect((await logoutRoute()).status).toBe(200);
    // After the browser drops the cookie the request carries none.
    const afterLogout = await middleware(pageRequest("/conflicts"));
    expect(afterLogout.status).toBe(307);
    expect(afterLogout.headers.get("location")).toContain("/my/login");
  });
});

describe("safeNextPath", () => {
  it("keeps in-app paths", () => {
    expect(safeNextPath("/conflicts")).toBe("/conflicts");
    expect(safeNextPath("/conflicts?status=open")).toBe("/conflicts?status=open");
    expect(safeNextPath(undefined)).toBe("/");
  });

  it("never returns any login page or an auth endpoint", () => {
    expect(safeNextPath("/login")).toBe("/");
    expect(safeNextPath("/operator/login")).toBe("/");
    expect(safeNextPath("/my/login")).toBe("/");
    expect(safeNextPath("/operator/login/subpath")).toBe("/");
    expect(safeNextPath("/my/login/subpath")).toBe("/");
    expect(safeNextPath("/api/auth/login")).toBe("/");
    expect(safeNextPath("/api/auth/logout")).toBe("/");
  });

  it("rejects absolute and protocol-relative targets", () => {
    expect(safeNextPath("//evil.example.com")).toBe("/");
    expect(safeNextPath("https://evil.example.com")).toBe("/");
    expect(safeNextPath(["//evil.example.com"])).toBe("/");
  });
});
