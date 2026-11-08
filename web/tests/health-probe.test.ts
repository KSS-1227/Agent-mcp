import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { checkBackendHealth } from "@/lib/server-db";

const ORIGIN = "http://127.0.0.1:8081";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function textResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

function abortOnSignal(init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () =>
      reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }))
    );
  });
}

const healthy = () => jsonResponse({ status: "healthy", timestamp: "2026-01-01T00:00:00.000Z" });

/** Routes by pathname so each endpoint can be scripted independently. */
function routeFetch(handlers: {
  live?: (init?: RequestInit) => Promise<Response> | Response;
  ready?: (init?: RequestInit) => Promise<Response> | Response;
  recovery?: (init?: RequestInit) => Promise<Response> | Response;
}) {
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/health/live")) {
      if (!handlers.live) throw new Error(`unexpected live probe: ${url}`);
      return handlers.live(init);
    }
    if (url.endsWith("/health/ready")) {
      if (!handlers.ready) throw new Error(`unexpected ready probe: ${url}`);
      return handlers.ready(init);
    }
    if (url.endsWith("/health/recovery")) {
      if (!handlers.recovery) throw new Error(`unexpected recovery probe: ${url}`);
      return handlers.recovery(init);
    }
    throw new Error(`unexpected url: ${url}`);
  });
}

let warnSpy: MockInstance;

beforeEach(() => {
  // No DATABASE_URL in the test process: the probe must not claim database health.
  delete process.env.DATABASE_URL;
  process.env.BACKEND_HEALTH_URL = ORIGIN;
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.BACKEND_HEALTH_URL;
});

describe("checkBackendHealth MCP daemon probe", () => {
  it("probes both endpoints at the configured origin and reports readiness", async () => {
    const fetchMock = routeFetch({ live: healthy, ready: healthy, recovery: () => jsonResponse({ state: "idle", enabled: true, productionVerifierCount: 1, lastPassAt: "2026-01-01T00:00:00.000Z", lastPass: { claimed: 0, committed: 0, failed: 0, escalated: 0 }, failure: false, observedAt: "2026-01-01T00:00:00.000Z" }) });
    vi.stubGlobal("fetch", fetchMock);

    const health = await checkBackendHealth();

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.sort()).toEqual([`${ORIGIN}/health/live`, `${ORIGIN}/health/ready`, `${ORIGIN}/health/recovery`]);
    expect(health.backend.recovery?.state).toBe("idle");

    expect(health.backend.configured).toBe(true);
    expect(health.backend.reachable).toBe(true);
    expect(health.backend.liveness).toBe(true);
    expect(health.backend.readiness).toBe(true);
    expect(health.backend.errorCode).toBeUndefined();
    expect(health.backend.errorDetail).toBeUndefined();
    expect(health.backend.endpoints?.live.ok).toBe(true);
    expect(health.backend.endpoints?.live.latencyMs).toBeGreaterThanOrEqual(0);
    // The origin is a server-side detail and must not leak into the payload.
    expect(JSON.stringify(health)).not.toContain("127.0.0.1");
    expect(JSON.stringify(health)).not.toContain("8081");
  });

  it("accepts a readiness answer slower than the old 2.5s budget but inside the daemon's 5s bound", async () => {
    vi.useFakeTimers();
    const fetchMock = routeFetch({
      live: healthy,
      // The real daemon takes ~2.4-2.6s (Supabase HEAD + fresh PostgreSQL connection).
      ready: async () => {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        return healthy();
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    const pending = checkBackendHealth();
    await vi.advanceTimersByTimeAsync(3000);
    const health = await pending;

    expect(health.backend.readiness).toBe(true);
    expect(health.backend.errorCode).toBeUndefined();
    expect(health.backend.endpoints?.ready.latencyMs).toBeGreaterThan(2500);
  });

  it("reports TIMEOUT and logs a sanitized line when readiness exceeds its budget", async () => {
    vi.useFakeTimers();
    const fetchMock = routeFetch({
      live: healthy,
      ready: (init) => abortOnSignal(init),
    });
    vi.stubGlobal("fetch", fetchMock);

    const pending = checkBackendHealth();
    await vi.advanceTimersByTimeAsync(8001);
    const health = await pending;

    expect(health.backend).toMatchObject({
      reachable: true,
      liveness: true,
      readiness: false,
      errorCode: "TIMEOUT",
    });
    expect(health.backend.endpoints?.ready.errorCode).toBe("TIMEOUT");
    expect(health.backend.endpoints?.ready.timeoutMs).toBe(8000);
    expect(health.backend.endpoints?.live.timeoutMs).toBe(2500);
    expect(health.backend.errorDetail).toContain("did not answer within 8000 ms");
    expect(health.status).not.toBe("healthy");

    const logged = warnSpy.mock.calls.flat().join(" ");
    expect(logged).toContain("/health/ready TIMEOUT");
    expect(logged).not.toContain("127.0.0.1");
    expect(logged).not.toContain("8081");
  });

  it("reports CONNECTION_REFUSED when nothing listens on the origin", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw refused;
      })
    );

    const health = await checkBackendHealth();

    expect(health.backend).toMatchObject({
      configured: true,
      reachable: false,
      liveness: false,
      readiness: false,
      errorCode: "CONNECTION_REFUSED",
    });
    expect(health.backend.errorDetail).toContain("connection refused");
    expect(health.status).not.toBe("healthy");
  });

  it("reports HTTP_503 when readiness answers not-ready", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        live: healthy,
        ready: () => jsonResponse({ status: "unhealthy", reason: "Failed: postgres" }, 503),
      })
    );

    const health = await checkBackendHealth();

    expect(health.backend).toMatchObject({
      reachable: true,
      liveness: true,
      readiness: false,
      errorCode: "HTTP_503",
    });
    expect(health.backend.errorDetail).toContain("HTTP 503");
    expect(health.status).not.toBe("healthy");
  });

  it("reports INVALID_RESPONSE for a 200 that is not the health daemon", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        live: healthy,
        ready: () => textResponse("<html>some other service</html>"),
      })
    );

    const health = await checkBackendHealth();

    expect(health.backend.readiness).toBe(false);
    expect(health.backend.errorCode).toBe("INVALID_RESPONSE");
    expect(health.backend.errorDetail).toContain("did not report status");
    expect(health.status).not.toBe("healthy");
  });

  it("does not probe or claim health when BACKEND_HEALTH_URL is unset", async () => {
    delete process.env.BACKEND_HEALTH_URL;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const health = await checkBackendHealth();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(health.backend).toMatchObject({
      configured: false,
      reachable: false,
      liveness: false,
      readiness: false,
    });
    expect(health.backend.endpoints).toBeUndefined();
    expect(health.status).toBe("disconnected");
  });

  it("rejects a non-http origin instead of probing it", async () => {
    process.env.BACKEND_HEALTH_URL = "ftp://127.0.0.1:8081";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const health = await checkBackendHealth();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(health.backend).toMatchObject({ configured: true, errorCode: "INVALID_URL" });
  });

  it("normalises a trailing slash or a pasted endpoint path onto the daemon root", async () => {
    for (const configured of [`${ORIGIN}/`, `${ORIGIN}/health/ready/`, `${ORIGIN}/health/live`]) {
      process.env.BACKEND_HEALTH_URL = configured;
      const fetchMock = routeFetch({ live: healthy, ready: healthy, recovery: () => { throw new Error("endpoint unavailable"); } });
      vi.stubGlobal("fetch", fetchMock);

      const health = await checkBackendHealth();

      const urls = fetchMock.mock.calls.map((call) => String(call[0])).sort();
      expect(urls).toEqual([`${ORIGIN}/health/live`, `${ORIGIN}/health/ready`, `${ORIGIN}/health/recovery`]);
      expect(health.backend.readiness).toBe(true);
      expect(health.backend.recovery).toBeNull();
    }
  });
});
