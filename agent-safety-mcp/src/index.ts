/**
 * Agent Safety MCP - Unified agent safety layer
 * Combines the Recovery Engine (crash-safe actions) and Conflict Engine (conflict detection)
 */

// Configuration: Validate environment first
export * from "./config";
import { validateEnvironment } from "./config";

// Validate at module load time
validateEnvironment();

// Core: Unified abstractions for both systems
export * from "./core";

// Recovery Engine: crash-safe action protocol (originated in Anchor)
export * from "./recovery-engine";
export * from "./database";

// Conflict Engine: conflict detection and resolution (originated in Interlock)
export * from "./conflict-engine";


