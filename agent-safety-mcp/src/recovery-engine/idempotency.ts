/**
 * Idempotency Key Generation - Exact port from Anchor Go idem.go
 *
 * The idempotency key is the load-bearing part. Two agents that decide to take
 * the same logical action against the same incident must derive byte-identical
 * keys, or the INSERT ... ON CONFLICT DO NOTHING in phase 1 fails to deduplicate
 * and the action happens twice. Everything in this file exists to make that
 * derivation deterministic.
 */

import crypto from "crypto";

/**
 * generateIdempotencyKey derives the primary key of an action_intents row.
 *
 * Determinism requirements, all of which are covered by tests:
 *   - Map key ordering in the caller's args must not affect the result.
 *   - Numeric spelling (1 vs 1.0 vs 1e0) must not affect the result.
 *   - The three inputs must not be ambiguously concatenable, so each is written
 *     with an explicit length prefix. Without this, ("ab","c") and ("a","bc")
 *     would hash identically.
 */
export function generateIdempotencyKey(
  episodeId: string,
  actionType: string,
  args: any
): string {
  const canon = canonicalJson(args);
  const episodeBytes = Buffer.from(episodeId, "utf-8");
  const actionBytes = Buffer.from(actionType, "utf-8");

  // Write length-prefixed fields to ensure unambiguous concatenation
  const hash = crypto.createHash("sha256");

  for (const field of [episodeBytes, actionBytes, canon]) {
    const lengthBuf = Buffer.alloc(8);
    lengthBuf.writeBigUInt64BE(BigInt(field.length), 0);
    hash.update(lengthBuf);
    hash.update(field);
  }

  return hash.digest("hex");
}

/**
 * canonicalJson serializes v to a deterministic byte sequence.
 *
 * This is a deliberately strict subset of RFC 8785. It sorts object keys by
 * byte order and rejects non-ASCII keys outright rather than silently producing
 * an ordering that disagrees with JCS's UTF-16 code unit ordering. Action
 * argument names are identifiers, so the restriction costs nothing and removes a
 * class of ambiguity that would otherwise be invisible until it caused a
 * duplicate action in production.
 */
export function canonicalJson(v: any): Buffer {
  // We validate as we canonicalize, so we can't use JSON.stringify which
  // silently handles NaN/Infinity. We go straight to writeCanonical.
  return Buffer.from(writeCanonical(v), "utf-8");
}

function writeCanonical(v: any): string {
  if (v === null) {
    return "null";
  }

  if (v === undefined) {
    throw new Error("canonical json: undefined cannot be serialized");
  }

  if (typeof v === "boolean") {
    return v ? "true" : "false";
  }

  if (typeof v === "number") {
    return writeCanonicalNumber(v);
  }

  if (typeof v === "string") {
    return writeCanonicalString(v);
  }

  if (Array.isArray(v)) {
    const items = v.map((elem) => writeCanonical(elem)).join(",");
    return `[${items}]`;
  }

  if (typeof v === "object") {
    // Sort keys by byte order
    const keys = Object.keys(v);
    for (const key of keys) {
      if (!isASCII(key)) {
        throw new Error(
          `canonical json: non-ASCII object key "${key}"; ` +
            "action argument names must be ASCII so key ordering is unambiguous"
        );
      }
    }
    keys.sort();

    const items = keys
      .map(
        (k) =>
          `${writeCanonicalString(k)}:${writeCanonical(v[k])}`
      )
      .join(",");
    return `{${items}}`;
  }

  throw new Error(`canonical json: unexpected type ${typeof v}`);
}

/**
 * writeCanonicalNumber collapses every spelling of a value to one form.
 * Integers are written as integers; everything else uses the shortest
 * representation that round-trips. So 1, 1.0, and 1e0 all canonicalize to "1".
 */
function writeCanonicalNumber(n: number): string {
  // Check for non-finite values
  if (!Number.isFinite(n)) {
    throw new Error(
      `canonical json: ${n} cannot appear in an idempotency key`
    );
  }

  // For integers (including 1.0, 2.0, etc)
  if (Number.isInteger(n)) {
    return String(Math.trunc(n));
  }

  // For floats that are actually integers (like 2.0)
  if (n === Math.trunc(n) && Math.abs(n) < 1e15) {
    return String(Math.trunc(n));
  }

  // Use toPrecision to get exact representation, then remove trailing zeros
  // Go tries to use the shortest representation that round-trips
  const str = n.toPrecision(17);
  const parsed = Number.parseFloat(str);
  if (parsed === n) {
    // Remove unnecessary trailing zeros and decimal point
    return str.replace(/\.?0+e/, "e").replace(/\.?0+$/, "");
  }

  // Fallback to toString
  return n.toString();
}

/**
 * writeCanonicalString emits a minimally escaped JSON string.
 * JSON.stringify is not used directly because it HTML-escapes <, >, and &,
 * which is a presentation concern that must not leak into a hash input.
 */
function writeCanonicalString(s: string): string {
  let result = '"';
  for (const char of s) {
    const code = char.charCodeAt(0);
    switch (code) {
      case 34: // "
        result += '\\"';
        break;
      case 92: // \
        result += "\\\\";
        break;
      case 10: // \n
        result += "\\n";
        break;
      case 13: // \r
        result += "\\r";
        break;
      case 9: // \t
        result += "\\t";
        break;
      case 8: // \b
        result += "\\b";
        break;
      case 12: // \f
        result += "\\f";
        break;
      default:
        if (code < 0x20) {
          result += `\\u${code.toString(16).padStart(4, "0")}`;
        } else {
          result += char;
        }
    }
  }
  result += '"';
  return result;
}

/**
 * Check if a string contains only ASCII characters (0-127).
 */
function isASCII(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 127) {
      return false;
    }
  }
  return true;
}
