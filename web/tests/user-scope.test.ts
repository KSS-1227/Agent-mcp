import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  serverDbImported: false,
  queriedTables: [] as string[],
  selectedColumns: [] as Array<[string, string]>,
  fetchLiveAgents: vi.fn(),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getUser: mocks.getUser } }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: mocks.getUser },
    from: (table: string) => {
      mocks.queriedTables.push(table);
      let filters: Array<[string, unknown]> = [];
      const rows: Record<string, unknown[]> = {
        agents: [{ id: "agent-1", key: "owned-agent", name: "Owned Agent", metadata: {}, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }],
        actions: [{ idempotency_key: "owned-action", episode_id: "episode-1", agent_id: "agent-1", action_type: "notify", arguments: {}, status: "PENDING", lease_owner: null, lease_expires_at: "2020-01-01T00:00:00Z", external_reference: null, outcome: null, attempts: 1, created_at: "2026-01-01T00:00:00Z", resolved_at: null, effect_state: "UNKNOWN", effect_started_at: null, effect_completed_at: null, verifier_response: null, verified_at: null }],
        intents: [{ id: "intent-1", agent_id: "agent-1", task_id: null, intent_statement: "Owned intent", status: "open", expiration_at: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }],
        intent_steps: [],
        episodes: [{ episode_id: "episode-1", narrative: "Owned episode", outcome: "done", status: "COMMITTED", created_at: "2026-01-01T00:00:00Z" }],
      };
      let result: { data: any; error: null; count?: number } = { data: rows[table] ?? [], error: null };
      const query: any = {
        select: (columns: string) => { mocks.selectedColumns.push([table, columns]); result = { data: rows[table] ?? [], error: null, count: (rows[table] ?? []).length }; return query; },
        order: () => query,
        limit: () => query,
        eq: (column: string, value: unknown) => { filters.push([column, value]); return query; },
        lt: (column: string, value: unknown) => { filters.push([column, value]); return query; },
        in: () => query,
        not: () => query,
        maybeSingle: async () => ({ data: rows[table]?.[0] ?? null, error: null }),
        then: (resolve: (value: typeof result) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject),
      };
      return query;
    },
  }),
}));

vi.mock("@/lib/server-db", () => {
  mocks.serverDbImported = true;
  return {
    fetchLiveActions: vi.fn(), fetchLiveActionByKey: vi.fn(), fetchLiveAgents: mocks.fetchLiveAgents,
    fetchLiveEpisodes: vi.fn(), fetchLiveIntents: vi.fn(), fetchLiveOverview: vi.fn(),
    fetchLiveProvenance: vi.fn(), fetchLiveResources: vi.fn(), checkBackendHealth: vi.fn(),
    fetchDatabaseCapabilities: vi.fn(), isDatabaseConfigured: vi.fn(),
  };
});

import { middleware } from "@/middleware";
import { GET as overview } from "@/app/api/overview/route";
import { GET as agents } from "@/app/api/agents/route";
import { GET as actions } from "@/app/api/actions/route";
import { GET as intents } from "@/app/api/intents/route";
import { GET as episodes } from "@/app/api/episodes/route";
import { GET as recoveryGet, POST as recoveryPost } from "@/app/api/recovery/route";
import { GET as conflicts } from "@/app/api/conflicts/route";
import { GET as settings } from "@/app/api/settings/route";
import { GET as health } from "@/app/api/health/route";
import { GET as provenance } from "@/app/api/provenance/route";
import { GET as resources } from "@/app/api/resources/route";
import { GET as evidence } from "@/app/api/evidence/route";

function request(path: string, extraHeaders?: Record<string, string>, body?: unknown) {
  return new Request(`http://localhost:3000${path}`, {
    method: body ? "POST" : "GET",
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  delete process.env.DASHBOARD_ACCESS_TOKEN;
  delete process.env.DASHBOARD_SESSION_SECRET;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1", email: "user@example.test" } }, error: null });
  mocks.serverDbImported = false;
  mocks.queriedTables = [];
  mocks.selectedColumns = [];
});

afterEach(() => vi.clearAllMocks());

describe("Supabase user middleware scope", () => {
  it("ignores spoofed scope headers and denies operator API/page paths", async () => {
    for (const path of ["/api/settings", "/api/health", "/api/provenance", "/api/resources", "/api/evidence", "/api/not-allowed"]) {
      const response = await middleware(new NextRequest(`http://localhost:3000${path}`, {
        headers: { "x-dashboard-scope": "operator", "x-dashboard-user-email": "spoofed@example.test" },
      }));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "OPERATOR_REQUIRED" });
    }
    for (const path of ["/settings", "/evidence"]) {
      const response = await middleware(new NextRequest(`http://localhost:3000${path}`, {
        headers: { "x-dashboard-scope": "operator" },
      }));
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toMatch(/\/$/);
    }
    for (const path of ["/future-page", "/agents/details"]) {
      const response = await middleware(new NextRequest(`http://localhost:3000${path}`));
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toMatch(/\/$/);
    }
  });

  it("passes only exact user allowlist paths", async () => {
    const allowed = ["/", "/agents", "/actions", "/intents", "/conflicts", "/recovery", "/api/overview", "/api/agents", "/api/actions", "/api/intents", "/api/episodes", "/api/recovery", "/api/conflicts"];
    for (const path of allowed) {
      const response = await middleware(new NextRequest(`http://localhost:3000${path}`));
      expect(response.status).toBe(200);
      expect(response.headers.get("x-middleware-next")).toBe("1");
    }
    expect(mocks.getUser).toHaveBeenCalledTimes(allowed.length);
  });
});

describe("user API session scope", () => {
  it("returns 403 on operator-only routes without importing server-db", async () => {
    for (const handler of [settings, health, provenance, resources, evidence]) {
      const response = await handler(request("/api/placeholder?mode=demo", { "x-dashboard-scope": "operator" }));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "OPERATOR_REQUIRED" });
    }
    expect(mocks.serverDbImported).toBe(false);
  });

  it("ignores mode=demo and uses the Supabase client on every user API allowlist route", async () => {
    const cases = [
      [overview, "/api/overview?mode=demo"],
      [agents, "/api/agents?mode=demo"],
      [actions, "/api/actions?mode=demo"],
      [intents, "/api/intents?mode=demo"],
      [episodes, "/api/episodes?mode=demo"],
      [recoveryGet, "/api/recovery?mode=demo"],
      [conflicts, "/api/conflicts?mode=demo"],
    ] as const;
    for (const [handler, path] of cases) {
      const response = await handler(request(path));
      expect([200, 501]).toContain(response.status);
      const body = await response.json();
      expect(body.isDemo).not.toBe(true);
    }
    expect(mocks.queriedTables).toContain("agents");
    expect(mocks.queriedTables).toContain("actions");
    expect(mocks.queriedTables).toContain("intents");
    expect(mocks.queriedTables).toContain("episodes");
    expect(mocks.queriedTables).not.toContain("resources");
    expect(mocks.queriedTables).not.toContain("intent_reads");
    expect(mocks.queriedTables).not.toContain("action_resource_versions");
    expect(mocks.serverDbImported).toBe(false);
  });

  it("recovery POST performs only an actions SELECT and omits dispositionConfirmed", async () => {
    const response = await recoveryPost(request("/api/recovery?mode=demo", {}, { actionKey: "owned-action", mode: "demo" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ operation: "inspect", limited: true, simulated: false });
    expect(body).not.toHaveProperty("dispositionConfirmed");
    expect(mocks.queriedTables).toContain("actions");
    expect(mocks.serverDbImported).toBe(false);
    expect(mocks.selectedColumns).toContainEqual(["actions", "idempotency_key, status, effect_state, lease_owner, lease_expires_at, attempts, external_reference, verifier_response, verified_at, resolved_at"]);
  });

  it("does not select episode embeddings and reports their presence from IDs only", async () => {
    const response = await episodes(request("/api/episodes?mode=demo"));
    expect(response.status).toBe(200);
    expect(mocks.selectedColumns).toContainEqual(["episodes", "episode_id, narrative, outcome, status, created_at"]);
    expect(mocks.selectedColumns).toContainEqual(["episodes", "episode_id"]);
    expect(mocks.selectedColumns.some(([table, columns]) => table === "episodes" && columns.includes("embedding"))).toBe(false);
  });

  it("keeps the operator route on the dynamically imported server-db branch", async () => {
    process.env.DASHBOARD_ACCESS_TOKEN = "test-access-token-0123456789abcdef";
    process.env.DASHBOARD_SESSION_SECRET = "test-session-secret-0123456789abcdef0123456789abcdef";
    mocks.fetchLiveAgents.mockResolvedValue({ ok: true, data: [] });
    const token = await createSessionToken();
    const response = await agents(request("/api/agents", { cookie: `${SESSION_COOKIE_NAME}=${token}` }));
    expect(response.status).toBe(200);
    expect(mocks.serverDbImported).toBe(true);
    expect(mocks.fetchLiveAgents).toHaveBeenCalledOnce();
  });
});
