/**
 * Health Check Logic
 * 
 * Liveness (GET /health/live): Always returns 200 OK if the process is running.
 * Readiness (GET /health/ready): Returns 200 OK only if:
 *  - Supabase REST API is reachable
 *  - (Optional) PostgreSQL database is reachable
 * 
 * Both checks use bounded timeouts (5 seconds each) to prevent orchestrators from blocking.
 * Errors never expose connection strings, credentials, or stack traces.
 */

import { getEnvironmentConfig } from "../config/index";
import * as http from "node:http";
import * as https from "node:https";
import { Client } from "pg";

export interface HealthStatus {
  status: "healthy" | "unhealthy";
  reason?: string;
  timestamp: string;
}

/**
 * Liveness check: Process is running and responsive
 * Always succeeds unless the process itself is dead (which means we can't respond).
 */
export async function checkLiveness(): Promise<HealthStatus> {
  return {
    status: "healthy",
    timestamp: new Date().toISOString(),
  };
}

/**
 * Readiness check: All dependencies (Supabase, optionally PostgreSQL) are available
 * Times out after 5s per service to prevent orchestrator blocking.
 */
export async function checkReadiness(): Promise<HealthStatus> {
  const config = getEnvironmentConfig();
  const checks: Promise<{ name: string; ok: boolean; error?: string }>[] = [];

  // Check 1: Supabase REST API is reachable (5s timeout)
  checks.push(
    checkSupabaseWithTimeout(config.supabaseUrl, 5000)
      .then((ok) => ({ name: "supabase", ok }))
      .catch((error) => ({
        name: "supabase",
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }))
  );

  // Check 2: PostgreSQL database is reachable if DATABASE_URL is set (5s timeout)
  if (config.databaseUrl) {
    checks.push(
      checkPostgresWithTimeout(config.databaseUrl, 5000)
        .then((ok) => ({ name: "postgres", ok }))
        .catch((error) => ({
          name: "postgres",
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }))
    );
  }

  // Wait for all checks (total timeout is per check, not cumulative)
  const results = await Promise.all(checks);

  // Determine overall readiness
  const allHealthy = results.every((r) => r.ok);
  if (!allHealthy) {
    const failures = results.filter((r) => !r.ok).map((r) => r.name);
    return {
      status: "unhealthy",
      reason: `Failed: ${failures.join(", ")}`,
      timestamp: new Date().toISOString(),
    };
  }

  return {
    status: "healthy",
    timestamp: new Date().toISOString(),
  };
}

/**
 * Check Supabase REST API reachability with timeout.
 * Never exposes connection strings or credentials.
 */
async function checkSupabaseWithTimeout(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(false); // Timeout: mark unhealthy
    }, timeoutMs);

    // Simple HEAD request to Supabase API root
    const httpModule = url.startsWith("https://") ? https : http;
    const parsedUrl = new URL(url);

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (url.startsWith("https://") ? 443 : 80),
      path: "/",
      method: "HEAD",
      timeout: timeoutMs,
    };

    const req = httpModule.request(options, (res: any) => {
      clearTimeout(timer);
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });

    req.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });

    req.on("timeout", () => {
      clearTimeout(timer);
      req.destroy();
      resolve(false);
    });

    req.end();
  });
}

/**
 * Check PostgreSQL database reachability with timeout.
 * Never exposes connection strings or credentials.
 */
async function checkPostgresWithTimeout(
  connectionUrl: string,
  timeoutMs: number
): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(false); // Timeout: mark unhealthy
    }, timeoutMs);

    // Parse connection URL to extract host and port
    let client: any;
    try {
      client = new Client({
        connectionString: connectionUrl,
        connectionTimeoutMillis: timeoutMs,
        query_timeout: timeoutMs,
      });

      client.connect((err: any) => {
        clearTimeout(timer);
        if (err) {
          resolve(false);
        } else {
          // Successfully connected; close and mark healthy
          client.end(() => {
            resolve(true);
          });
        }
      });
    } catch (err) {
      clearTimeout(timer);
      resolve(false);
    }
  });
}
