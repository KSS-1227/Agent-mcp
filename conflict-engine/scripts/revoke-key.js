/**
 * Revoke an API key.
 *
 * Why this exists: key issuance is unauthenticated by design, so anyone can
 * evaluate the service without asking permission. The cost of that openness is
 * that a key which becomes public stays usable — and a key does become public
 * the moment it is filmed, since npm echoes the full argument in its banner:
 *
 *     > node scripts/compare.js ilk_7TNrmAav…
 *
 * A demo video is permanent and a per-key ceiling is $25/day against a $50
 * global ceiling, so a single readable key in a public video is not a billing
 * problem so much as an availability one: someone looping it can exhaust the
 * global budget and hand a judge a 429 in the middle of the judging window.
 *
 * `revoked_at` already existed and auth already honoured it (agents/auth.js);
 * nothing could set it. This closes that.
 *
 * Takes a prefix rather than a whole key so it can be run from what is visible
 * on screen, and so the full secret need not be pasted a second time. Keys are
 * stored as hashes — there is no way back from the hash, and no way to revoke
 * by anything other than what was recorded at issue time.
 *
 * Run: npm run revoke:key -- ilk_7TNrmAav      (12-char prefix, or a full key)
 *      npm run revoke:key -- --list            (show recent keys, none revoked)
 */
import { requireEnv } from "./env.js";
import pg from "pg";

const { Client } = pg;

const ok = (s) => `\x1b[32m✓\x1b[0m ${s}`;
const bad = (s) => `\x1b[31m✗\x1b[0m ${s}`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

const DATABASE_URL = requireEnv(
  "DATABASE_URL",
  "Get it from CockroachDB Cloud → Connect → General connection string.",
);

const client = new Client({
  connectionString: DATABASE_URL,
  application_name: "interlock-revoke-key",
});

/**
 * Keys are issued as `ilk_` + 40 chars and indexed by a 12-char prefix. Accept
 * either form: a full key is trimmed to its prefix rather than rejected, so
 * pasting the whole thing does the obvious thing instead of failing.
 */
function toPrefix(arg) {
  const s = String(arg).trim();
  if (!s.startsWith("ilk_")) return null;
  return s.slice(0, 12);
}

async function list() {
  const { rows } = await client.query(
    `SELECT key_prefix, label, created_at, last_used_at, revoked_at
       FROM api_key
      ORDER BY created_at DESC
      LIMIT 20`,
  );
  if (rows.length === 0) {
    console.log(dim("  no keys issued"));
    return;
  }
  console.log(bold("\n  recent keys\n"));
  for (const r of rows) {
    const state = r.revoked_at
      ? `\x1b[31mrevoked\x1b[0m ${dim(r.revoked_at.toISOString().slice(0, 16))}`
      : "\x1b[32mactive\x1b[0m ";
    const used = r.last_used_at
      ? dim(`last used ${r.last_used_at.toISOString().slice(0, 16)}`)
      : dim("never used");
    console.log(
      `  ${r.key_prefix}…  ${state}  ${dim((r.label ?? "").padEnd(18).slice(0, 18))} ${used}`,
    );
  }
  console.log();
}

async function main() {
  const arg = process.argv[2];

  await client.connect();
  // DATABASE_URL points at the cluster, not at a database — every caller
  // selects `interlock` explicitly (see agents/db.js).
  await client.query("SET database = interlock");

  if (!arg || arg === "--list") {
    await list();
    if (!arg) {
      console.log(dim("  pass a key or prefix to revoke it:"));
      console.log(dim("    npm run revoke:key -- ilk_7TNrmAav\n"));
    }
    return;
  }

  const prefix = toPrefix(arg);
  if (!prefix) {
    console.error(bad(`Not an INTERLOCK key: ${arg}`));
    console.error(dim("  Keys start with ilk_. Pass the key or its first 12 characters."));
    process.exitCode = 1;
    return;
  }

  // Revoke by prefix, but never revoke more than one key on an ambiguous
  // match: the prefix is 12 characters of a random 40, so a collision is
  // vanishingly unlikely — and if one ever happens, silently killing a
  // stranger's key is worse than refusing.
  const { rows: found } = await client.query(
    `SELECT id, key_prefix, label, revoked_at FROM api_key WHERE key_prefix = $1`,
    [prefix],
  );

  if (found.length === 0) {
    console.error(bad(`No key with prefix ${prefix}`));
    console.error(dim("  Run with --list to see what exists."));
    process.exitCode = 1;
    return;
  }
  if (found.length > 1) {
    console.error(bad(`${found.length} keys share the prefix ${prefix} — refusing to guess.`));
    process.exitCode = 1;
    return;
  }
  if (found[0].revoked_at) {
    console.log(ok(`${prefix}… was already revoked ${dim(found[0].revoked_at.toISOString())}`));
    return;
  }

  await client.query(`UPDATE api_key SET revoked_at = now() WHERE id = $1`, [found[0].id]);

  console.log(ok(`Revoked ${bold(prefix + "…")} ${dim(found[0].label ?? "")}`));
  console.log(
    dim("  Every request carrying it now fails auth. Issued keys are independent —\n") +
      dim("  no other key is affected, and a new one can be taken at any time."),
  );
}

main()
  .catch((e) => {
    console.error(bad(e.message));
    process.exitCode = 1;
  })
  .finally(() => client.end());
