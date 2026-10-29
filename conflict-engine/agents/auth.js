/**
 * API keys and tenant resolution.
 *
 * KEYS ARE NEVER STORED
 * Only a SHA-256 of the key is persisted, alongside a short prefix so a user
 * can identify a key in a list. A database dump therefore yields no working
 * credentials, and we cannot show someone their own key after issuance. That
 * second property is a feature: a system that can display your secret back to
 * you is a system that could be compelled to.
 *
 * WHY TENANCY MATTERS MORE HERE THAN USUAL
 * This service detects conflicts between agents. A missed tenant filter would
 * not merely leak a row — it would let one customer's commit adjudicate another
 * customer's in-flight plans, repairing steps in work they cannot see. That is
 * a stranger failure than a normal data leak, and it is why the tenant filter
 * lives inside the detection query rather than in a wrapper around it.
 */
import { createHash, randomBytes } from "node:crypto";
import { query } from "./db.js";

const PREFIX = "ilk_";

export const hashKey = (key) => createHash("sha256").update(key).digest("hex");

/** `ilk_` + 40 url-safe chars. Shown once, at creation. */
export function generateKey() {
  const secret = randomBytes(30).toString("base64url");
  const key = `${PREFIX}${secret}`;
  return { key, hash: hashKey(key), prefix: key.slice(0, 12) };
}

export async function getPublicTenant() {
  const { rows } = await query(`SELECT id, slug, name FROM tenant WHERE slug='public'`);
  return rows[0];
}

/**
 * Resolve the caller.
 *
 * No key means the shared public tenant with tight limits — the demo has to
 * work for someone who just clicked a link. A valid key means that key's tenant
 * and its own, higher, limits.
 */
export async function resolveCaller(authorizationHeader) {
  const raw = (authorizationHeader ?? "").replace(/^Bearer\s+/i, "").trim();

  if (!raw || !raw.startsWith(PREFIX)) {
    const t = await getPublicTenant();
    return {
      tenantId: t.id,
      tenantSlug: t.slug,
      authenticated: false,
      callLimit: Number(process.env.DAILY_CALL_LIMIT ?? 400),
      usdLimit: Number(process.env.DAILY_USD_LIMIT ?? 3),
    };
  }

  const { rows } = await query(
    `SELECT k.id, k.tenant_id, k.daily_call_limit, k.daily_usd_limit,
            k.revoked_at, t.slug
     FROM api_key k JOIN tenant t ON t.id = k.tenant_id
     WHERE k.key_hash = $1`,
    [hashKey(raw)],
  );

  if (rows.length === 0) return { error: "Unknown API key." };
  if (rows[0].revoked_at) return { error: "This API key has been revoked." };

  // Fire-and-forget: last_used_at is useful for spotting abandoned keys and
  // must never be the reason a request fails.
  query(`UPDATE api_key SET last_used_at = now() WHERE id = $1`, [rows[0].id]).catch(
    () => {},
  );

  return {
    tenantId: rows[0].tenant_id,
    tenantSlug: rows[0].slug,
    keyId: rows[0].id,
    authenticated: true,
    callLimit: Number(rows[0].daily_call_limit),
    usdLimit: Number(rows[0].daily_usd_limit),
  };
}

/**
 * Issue a tenant and its first key.
 *
 * Self-serve on purpose. A service that requires a sales conversation before
 * anyone can evaluate it does not get evaluated.
 */
export async function issueKey({ name, label = "default" }) {
  const slug =
    `${String(name ?? "tenant").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24)}-` +
    randomBytes(3).toString("hex");

  const { rows: t } = await query(
    `INSERT INTO tenant (name, slug) VALUES ($1, $2) RETURNING id, slug`,
    [String(name ?? "Unnamed").slice(0, 80), slug],
  );

  const { key, hash, prefix } = generateKey();
  // RETURNING the limits rather than letting the caller state them. They are
  // column defaults, so anything quoted elsewhere is a second copy that drifts
  // the moment the default changes — which is exactly what happened: the API
  // advertised 2,000 calls and $5 for a week after the column said otherwise.
  const { rows: k } = await query(
    `INSERT INTO api_key (tenant_id, key_hash, key_prefix, label)
     VALUES ($1, $2, $3, $4)
     RETURNING daily_call_limit, daily_usd_limit`,
    [t[0].id, hash, prefix, String(label).slice(0, 40)],
  );

  return {
    key, // the only time this value exists outside the caller's hands
    prefix,
    tenant: { id: t[0].id, slug: t[0].slug },
    limits: {
      dailyCalls: Number(k[0].daily_call_limit),
      dailyUsd: Number(k[0].daily_usd_limit),
    },
  };
}

/** Ensure a named agent exists inside this tenant, and only this tenant. */
export async function ensureTenantAgent(tenantId, name, role = "agent") {
  const { rows } = await query(
    `SELECT id FROM agent WHERE tenant_id = $1 AND name = $2`,
    [tenantId, name],
  );
  if (rows[0]) return rows[0].id;

  const { rows: ins } = await query(
    `INSERT INTO agent (tenant_id, name, role, home_region)
     VALUES ($1, $2, $3, 'aws-us-east-1') RETURNING id`,
    [tenantId, name, role],
  );
  return ins[0].id;
}
