import type { VerifierRegistry } from "../recovery-engine/verifier_registry";
import { isIsolatedTestActionEnvironment } from "../config/database-isolation.mjs";

/**
 * Production action types must have a registered production verifier. Test
 * runners may use fixture-only types only when their DB context is isolated.
 */
export function assertActionTypeAllowed(
  actionType: unknown,
  registry: Pick<VerifierRegistry, "getProduction">,
  env: NodeJS.ProcessEnv = process.env
): asserts actionType is string {
  if (typeof actionType !== "string" || !actionType.trim()) {
    throw new Error("action_type is required and must be a non-empty string");
  }
  if (registry.getProduction(actionType)) return;
  if (isIsolatedTestActionEnvironment(env)) return;
  throw new Error(`Unsupported action type in this environment: ${actionType}`);
}
