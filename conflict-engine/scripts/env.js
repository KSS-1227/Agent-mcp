/**
 * Loads environment from .env.local (preferred) then .env, both optional.
 *
 * Import this before touching process.env:
 *   import "./env.js";
 *
 * .env.local holds real secrets and is git-ignored. .env, if present, holds
 * non-secret defaults that are safe to commit.
 */
import { config } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

for (const file of [".env.local", ".env"]) {
  const path = join(root, file);
  if (existsSync(path)) config({ path, override: false, quiet: true });
}

export const PROJECT_ROOT = root;

/** Fail loudly and usefully rather than with a stack trace. */
export function requireEnv(name, hint) {
  const value = process.env[name];
  if (!value) {
    console.error(
      `\x1b[31m✗\x1b[0m ${name} is not set.${hint ? ` ${hint}` : ""}\n  Add it to ${join(root, ".env.local")} — see SETUP.md.`,
    );
    process.exit(1);
  }
  return value;
}
