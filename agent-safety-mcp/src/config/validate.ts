/**
 * Environment Configuration Validation
 *
 * Validates required environment variables at startup.
 * Fails fast with clear error messages before any services start.
 * Secrets are never logged.
 */

export interface EnvironmentConfig {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  databaseUrl?: string;
  llmProvider?: string;
  logLevel?: string;
}

/**
 * Validate that all required environment variables are set.
 * Throws descriptive error if any are missing.
 * Does NOT log secret values.
 */
export function validateEnvironment(): EnvironmentConfig {
  const errors: string[] = [];

  // Required: Supabase connection
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) {
    errors.push("SUPABASE_URL is required");
  } else if (!supabaseUrl.startsWith("https://")) {
    errors.push("SUPABASE_URL must be a valid HTTPS URL");
  }

  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseServiceRoleKey) {
    errors.push("SUPABASE_SERVICE_ROLE_KEY is required");
  }

  // Optional: Direct database connection (only if not using Supabase)
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl && !databaseUrl.startsWith("postgresql://")) {
    errors.push("DATABASE_URL must be a PostgreSQL connection string (postgresql://)");
  }

  // Fail fast if any required vars are missing
  if (errors.length > 0) {
    const errorMessage = `Environment validation failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`;
    throw new Error(errorMessage);
  }

  // At this point, all required vars are guaranteed to exist
  const supabaseUrlValue = supabaseUrl as string;
  const supabaseServiceRoleKeyValue = supabaseServiceRoleKey as string;

  // Optional: LLM configuration
  const llmProvider = process.env.LLM_PROVIDER || "nemotron";

  // Optional: Logging
  const logLevel = process.env.LOG_LEVEL || "info";

  return {
    supabaseUrl: supabaseUrlValue,
    supabaseServiceRoleKey: supabaseServiceRoleKeyValue,
    databaseUrl,
    llmProvider,
    logLevel,
  };
}

/**
 * Get validated environment config.
 * Caches result after first validation.
 */
let cachedConfig: EnvironmentConfig | null = null;

export function getEnvironmentConfig(): EnvironmentConfig {
  if (!cachedConfig) {
    cachedConfig = validateEnvironment();
  }
  return cachedConfig;
}

/**
 * Reset cached config (for testing).
 */
export function resetEnvironmentConfig(): void {
  cachedConfig = null;
}
