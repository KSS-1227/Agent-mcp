/**
 * Verifier Registry - Server-side verifier management
 * 
 * Implements the verifier discovery pattern without allowing arbitrary code injection
 * from MCP callers. Verifiers are pre-registered at server startup.
 */

import type { ActionVerifier } from "../recovery-engine/reconciliation";
import type { Action, Verdict } from "./types";
import { VerdictDisposition } from "./types";

/**
 * Verifier registry manages server-side verifier instances
 */
export class VerifierRegistry {
  private verifiers: Map<string, ActionVerifier> = new Map();
  private productionVerifiers = new Set<string>();

  /**
   * Register a verifier with a unique ID
   */
  register(verifierId: string, verifier: ActionVerifier): void {
    if (!verifierId || typeof verifierId !== "string") {
      throw new Error("verifierId must be a non-empty string");
    }
    if (!verifier || typeof verifier.verify !== "function") {
      throw new Error("verifier must implement ActionVerifier interface (must have verify method)");
    }
    this.verifiers.set(verifierId, verifier);
    this.productionVerifiers.delete(verifierId);
  }

  /** Register a verifier explicitly approved by the application bootstrap for production use. */
  registerProduction(verifierId: string, verifier: ActionVerifier): void {
    if (!verifierId || typeof verifierId !== "string") {
      throw new Error("verifierId must be a non-empty string");
    }
    if (!verifier || typeof verifier.verify !== "function") {
      throw new Error("verifier must implement ActionVerifier interface (must have verify method)");
    }
    this.verifiers.set(verifierId, verifier);
    this.productionVerifiers.add(verifierId);
  }

  getProduction(verifierId: string): ActionVerifier | undefined {
    return this.productionVerifiers.has(verifierId)
      ? this.verifiers.get(verifierId)
      : undefined;
  }

  listProduction(): string[] {
    return Array.from(this.productionVerifiers);
  }

  /**
   * Get a verifier by ID
   */
  get(verifierId: string): ActionVerifier | undefined {
    return this.verifiers.get(verifierId);
  }

  /**
   * Check if a verifier is registered
   */
  has(verifierId: string): boolean {
    return this.verifiers.has(verifierId);
  }

  /**
   * List all registered verifier IDs
   */
  listVerifiers(): string[] {
    return Array.from(this.verifiers.keys());
  }

  /**
   * Clear all verifiers (for testing)
   */
  clear(): void {
    this.verifiers.clear();
    this.productionVerifiers.clear();
  }

  /**
   * Get verifier count (for testing/debugging)
   */
  size(): number {
    return this.verifiers.size;
  }
}

/** Dispatches recovery only to the verifier registered for the persisted action type. */
export class ProductionActionVerifierDispatcher implements ActionVerifier {
  constructor(private readonly registry: VerifierRegistry) {}

  async verify(action: Action): Promise<Verdict> {
    const verifier = this.registry.getProduction(action.actionType);
    if (!verifier) {
      return {
        disposition: VerdictDisposition.Unknown,
        externalRef: "",
        outcome: {},
        reason: `No production verifier is registered for action type ${action.actionType}`,
      };
    }
    return verifier.verify(action);
  }

  async getEffect(actionType: string, actionArgs: any): Promise<any> {
    return this.registry.getProduction(actionType)?.getEffect?.(actionType, actionArgs);
  }
}

// Singleton instance
let globalRegistry: VerifierRegistry | null = null;

/**
 * Get the global verifier registry (creates on first access)
 */
export function getVerifierRegistry(): VerifierRegistry {
  if (!globalRegistry) {
    globalRegistry = new VerifierRegistry();
  }
  return globalRegistry;
}

/**
 * Set the global verifier registry (for testing/configuration)
 */
export function setVerifierRegistry(registry: VerifierRegistry): void {
  globalRegistry = registry;
}

/**
 * Reset the global verifier registry (for testing)
 */
export function resetVerifierRegistry(): void {
  globalRegistry = null;
}



