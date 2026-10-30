import { afterEach, describe, expect, it, vi } from "vitest";
import {
  evaluateLiveCleanupGate,
  installAfterEachCleanup,
  isLiveCleanupAuthorized,
  loadLiveDatabaseTestConfig,
  verifyLiveDatabaseTestIdentity,
} from "./live-db-guard";

const isolatedSupabaseEnv = (): NodeJS.ProcessEnv => ({
  RUN_LIVE_DB_TESTS: "1",
  DATABASE_URL: "postgresql://postgres.prodref@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
  SUPABASE_URL: "https://prodref.supabase.co",
  TEST_DATABASE_URL: "postgresql://postgres.testref@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
  TEST_SUPABASE_URL: "https://testref.supabase.co",
} as NodeJS.ProcessEnv);

describe("live database test opt-in guard", () => {
  it("does not load environment files unless explicitly opted in", () => {
    const loadEnv = vi.fn();
    expect(loadLiveDatabaseTestConfig({ DATABASE_URL: "postgres://production" } as NodeJS.ProcessEnv, loadEnv))
      .toEqual({ enabled: false });
    expect(loadEnv).not.toHaveBeenCalled();
  });

  it("fails closed without TEST_DATABASE_URL and never falls back to DATABASE_URL", () => {
    const loadEnv = vi.fn();
    expect(() => loadLiveDatabaseTestConfig({ RUN_LIVE_DB_TESTS: "1", DATABASE_URL: "postgres://production" } as NodeJS.ProcessEnv, loadEnv))
      .toThrow(/requires TEST_DATABASE_URL/);
    expect(loadEnv).toHaveBeenCalledOnce();
  });

  it("rejects a test URL that is the production DATABASE_URL target", () => {
    const env = isolatedSupabaseEnv();
    env.TEST_DATABASE_URL = env.DATABASE_URL;
    env.TEST_SUPABASE_URL = env.SUPABASE_URL;
    expect(() => loadLiveDatabaseTestConfig(env, vi.fn())).toThrow(/production/);
  });

  it("rejects a Supabase test target that aliases the production project", () => {
    const env = isolatedSupabaseEnv();
    delete env.DATABASE_URL;
    env.TEST_DATABASE_URL = "postgresql://postgres.prodref@aws-0-us-east-1.pooler.supabase.com:6543/postgres";
    env.TEST_SUPABASE_URL = "https://prodref.supabase.co";
    expect(() => loadLiveDatabaseTestConfig(env, vi.fn())).toThrow(/production Supabase project/);
  });

  it("fails closed when test database identity is missing or unverifiable", () => {
    expect(() => loadLiveDatabaseTestConfig({
      RUN_LIVE_DB_TESTS: "1",
      TEST_DATABASE_URL: "postgresql://tester@db.example.net/postgres",
    } as NodeJS.ProcessEnv, vi.fn())).toThrow(/identity is unverifiable/);
    expect(() => loadLiveDatabaseTestConfig({
      RUN_LIVE_DB_TESTS: "1",
      TEST_DATABASE_URL: "postgresql://postgres.testref@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
      TEST_SUPABASE_URL: "https://testref.supabase.co",
    } as NodeJS.ProcessEnv, vi.fn())).toThrow(/Production Supabase identity is required/);
  });

  it("accepts a distinct test Supabase project and verifies the connected database", async () => {
    const config = loadLiveDatabaseTestConfig(isolatedSupabaseEnv(), vi.fn());
    expect(config).toMatchObject({
      enabled: true,
      databaseUrl: isolatedSupabaseEnv().TEST_DATABASE_URL,
      identity: { kind: "supabase", projectRef: "testref", database: "postgres" },
    });
    await expect(verifyLiveDatabaseTestIdentity({
      query: vi.fn().mockResolvedValue({ rows: [{ database_name: "postgres" }] }),
    }, config)).resolves.toBeUndefined();
    await expect(verifyLiveDatabaseTestIdentity({
      query: vi.fn().mockResolvedValue({ rows: [{ database_name: "production" }] }),
    }, config)).rejects.toThrow(/does not match/);
  });

  it("permits an explicitly named local test database", () => {
    const env = {
      RUN_LIVE_DB_TESTS: "1",
      DATABASE_URL: "postgresql://tester:pw@localhost:5432/app",
      TEST_DATABASE_URL: "postgresql://tester:pw@127.0.0.1:5432/app_test",
    } as NodeJS.ProcessEnv;
    expect(loadLiveDatabaseTestConfig(env, vi.fn()).identity).toMatchObject({
      kind: "local",
      database: "app_test",
    });
  });

  it("rejects a local test URL when production points to an unverifiable remote server", () => {
    const env = {
      RUN_LIVE_DB_TESTS: "1",
      DATABASE_URL: "postgresql://prod@db.example.net/app",
      TEST_DATABASE_URL: "postgresql://tester@localhost:5432/app_test",
    } as NodeJS.ProcessEnv;
    expect(() => loadLiveDatabaseTestConfig(env, vi.fn())).toThrow(/cannot be verified/);
  });
});

describe("failure-safe after-test cleanup registration", () => {
  let cleanupCalled = false;
  installAfterEachCleanup(afterEach, async () => { cleanupCalled = true; });

  it.fails("runs cleanup after a failed test body", () => {
    throw new Error("simulated test failure");
  });

  it("confirms the afterEach cleanup ran after that failed test", () => {
    expect(cleanupCalled).toBe(true);
  });
});

describe("live recovery cleanup authorization", () => {
  const env = (value?: string): NodeJS.ProcessEnv =>
    (value === undefined ? {} : { RUN_LIVE_RECOVERY_CLEANUP: value }) as NodeJS.ProcessEnv;

  it("denies cleanup when the flag is absent", () => {
    expect(isLiveCleanupAuthorized(env())).toBe(false);
  });

  it("denies cleanup for truthy-but-not-exact values", () => {
    expect(isLiveCleanupAuthorized(env("true"))).toBe(false);
    expect(isLiveCleanupAuthorized(env("0"))).toBe(false);
    expect(isLiveCleanupAuthorized(env(""))).toBe(false);
    expect(isLiveCleanupAuthorized(env("1 "))).toBe(false);
    expect(isLiveCleanupAuthorized(env("01"))).toBe(false);
  });

  it("authorizes cleanup only for the exact value '1'", () => {
    expect(isLiveCleanupAuthorized(env("1"))).toBe(true);
  });

  it("does not infer cleanup authorization from the live-test opt-in", () => {
    const liveOnly = { RUN_LIVE_DB_TESTS: "1", RUN_LIVE_RECOVERY_INTEGRATION: "1" } as NodeJS.ProcessEnv;
    expect(isLiveCleanupAuthorized(liveOnly)).toBe(false);
  });
});

describe("live cleanup gate", () => {
  const allGranted = {
    liveEnabled: true,
    cleanupAuthorized: true,
    identityVerified: true,
    preflightPassed: true,
  };

  it("allows cleanup only when every prerequisite holds", () => {
    expect(evaluateLiveCleanupGate(allGranted)).toEqual({ allowed: true });
  });

  it("refuses cleanup when live testing is disabled, even if authorized", () => {
    expect(evaluateLiveCleanupGate({ ...allGranted, liveEnabled: false })).toEqual({
      allowed: false,
      refusal: "live-database-testing-disabled",
    });
  });

  it("refuses cleanup when the cleanup flag is not authorized", () => {
    expect(evaluateLiveCleanupGate({ ...allGranted, cleanupAuthorized: false })).toEqual({
      allowed: false,
      refusal: "cleanup-not-authorized",
    });
  });

  it("refuses cleanup when the database identity was not verified", () => {
    expect(evaluateLiveCleanupGate({ ...allGranted, identityVerified: false })).toEqual({
      allowed: false,
      refusal: "database-identity-not-verified",
    });
  });

  it("refuses cleanup when the schema preflight did not pass", () => {
    expect(evaluateLiveCleanupGate({ ...allGranted, preflightPassed: false })).toEqual({
      allowed: false,
      refusal: "schema-preflight-not-passed",
    });
  });
});

