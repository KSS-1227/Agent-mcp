/**
 * Conflict Engine - conflict detection and resolution (originated in Interlock)
 *
 * Implements the 5-step pipeline:
 * 1. DECLARE - intent with reads and plan
 * 2. WATCH - detect threatened intents
 * 3. DIFF - show what changed
 * 4. ADJUDICATE - decide conflict severity
 * 5. RESOLVE - repair or abort
 */

export * from "./types";
export * from "./intent.service";
export * from "./provenance";
export * from "./detection";
export * from "./vector";

