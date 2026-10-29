import { jwtVerify, importSPKI, createRemoteJWKSet } from "jose";
import { validateEnvironment } from "../config/index";

/**
 * JWT Verifier - Supabase Auth Integration
 * Verifies JWT tokens signed by Supabase Auth using JWKS caching
 */

interface VerifiedJWT {
  user_id: string;
  email?: string;
  role?: string;
  aud?: string;
  iss?: string;
}

let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;
let cacheTime = 0;
const CACHE_TTL = 1000 * 60 * 60; // 1 hour

/**
 * Get JWKS from Supabase Auth endpoint and cache it
 */
function getJWKS(supabaseUrl: string): ReturnType<typeof createRemoteJWKSet> {
  const now = Date.now();
  
  // Return cached JWKS if still valid
  if (jwksCache && (now - cacheTime) < CACHE_TTL) {
    return jwksCache;
  }

  // Fetch JWKS from Supabase Auth
  const jwksUrl = `${supabaseUrl}/auth/v1/.well-known/jwks.json`;
  jwksCache = createRemoteJWKSet(new URL(jwksUrl));
  cacheTime = now;

  return jwksCache;
}

/**
 * Verify JWT token from Supabase Auth
 * 
 * @param token Bearer token string
 * @returns Verified JWT with user_id
 * @throws Error if token invalid, expired, or issuer mismatch
 */
export async function verifySupabaseJWT(token: string): Promise<VerifiedJWT> {
  try {
    const config = validateEnvironment();
    const supabaseUrl = config.supabaseUrl;

    if (!supabaseUrl) {
      throw new Error("SUPABASE_URL not configured");
    }

    const jwks = getJWKS(supabaseUrl);

    // Verify JWT: signature, expiry, issuer
    const verified = await jwtVerify(token, jwks, {
      issuer: supabaseUrl,
      audience: "authenticated", // Supabase default audience
      algorithms: ["RS256"],
    });

    const sub = verified.payload.sub as string;
    if (!sub) {
      throw new Error("JWT missing subject (user_id)");
    }

    return {
      user_id: sub,
      email: verified.payload.email as string,
      role: verified.payload.role as string,
      aud: verified.payload.aud as string,
      iss: verified.payload.iss as string,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`JWT verification failed: ${message}`);
  }
}

/**
 * Extract Bearer token from Authorization header
 */
export function extractBearerToken(authHeader?: string): string | null {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  return authHeader.substring(7);
}
