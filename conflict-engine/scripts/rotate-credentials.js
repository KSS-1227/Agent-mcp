/**
 * Rotate the SQL password and rewrite .env.local.
 *
 * WHY THIS EXISTS AS A SCRIPT
 * During development this project's SQL password and control-plane API key both
 * ended up pasted into a chat transcript. That is an ordinary thing to happen
 * and an unacceptable thing to leave standing, particularly with a public repo.
 *
 * Rotation is easy to intend and easy to forget, so it is a command rather than
 * a note: `npm run rotate`. It generates a strong password, writes it to
 * .env.local BEFORE applying it (so a mid-flight failure cannot strand you
 * without the credential), applies it, then proves the new one works by opening
 * a fresh connection with it.
 *
 * The Cloud API key must be rotated in the console -- key material is only ever
 * shown once at creation, so no automated flow can capture it.
 *
 * Run: npm run rotate
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { PROJECT_ROOT, requireEnv } from "./env.js";

const { Client } = pg;

const ok = (s) => `\x1b[32mOK\x1b[0m    ${s}`;
const bad = (s) => `\x1b[31mFAIL\x1b[0m  ${s}`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const b = (s) => `\x1b[1m${s}\x1b[0m`;

/** URL-safe, no characters that need escaping inside a connection string. */
function strongPassword(bytes = 24) {
  return randomBytes(bytes)
    .toString("base64")
    .replace(/[+/=]/g, "")
    .slice(0, 32);
}

const ENV_PATH = join(PROJECT_ROOT, ".env.local");

async function main() {
  console.log(b("\nCredential rotation\n"));

  const oldUrl = requireEnv("DATABASE_URL");
  const user = process.env.CRDB_USER || new URL(oldUrl).username;
  const oldPassword = process.env.CRDB_PASSWORD || decodeURIComponent(new URL(oldUrl).password);
  const next = strongPassword();

  // Write first. If ALTER succeeds but the process dies before the file is
  // updated, the new password would be lost and the account unreachable.
  copyFileSync(ENV_PATH, `${ENV_PATH}.bak`);
  let env = readFileSync(ENV_PATH, "utf8");
  env = env.split(oldPassword).join(next);
  env = env.replace(
    /# ┌[\s\S]*?# └[^\n]*\n/,
    `# Rotated ${new Date().toISOString().slice(0, 10)} by scripts/rotate-credentials.js.\n` +
      `# NOTE: CCLOUD_API_KEY must still be rotated by hand in the Cloud Console --\n` +
      `# key material is shown only once at creation, so no script can capture it.\n`,
  );
  writeFileSync(ENV_PATH, env, "utf8");
  console.log(ok(`.env.local updated (backup at .env.local.bak)`));

  const client = new Client({
    connectionString: oldUrl,
    application_name: "interlock-rotate",
  });
  await client.connect();
  await client.query(`ALTER USER ${user} WITH PASSWORD $1`, [next]);
  await client.end();
  console.log(ok(`password rotated for SQL user "${user}"`));

  // Prove it, rather than assume it.
  const verifyUrl = oldUrl.replace(
    encodeURIComponent(oldPassword),
    encodeURIComponent(next),
  ).replace(oldPassword, next);

  const check = new Client({
    connectionString: verifyUrl,
    application_name: "interlock-rotate-verify",
  });
  try {
    await check.connect();
    const { rows } = await check.query("SELECT current_user AS u");
    await check.end();
    console.log(ok(`verified: reconnected as "${rows[0].u}" with the new password`));
  } catch (e) {
    console.log(bad(`could not reconnect: ${e.message}`));
    console.log(dim(`      the new password is in .env.local; restore .env.local.bak if needed`));
    process.exit(1);
  }

  console.log(
    b("\n  SQL password rotated.\n") +
      dim(
        "  Still to do by hand: CCLOUD_API_KEY.\n" +
          "  Governance -> Service accounts -> interlock-agent -> API Keys\n" +
          "  -> delete the old key, create a new one, paste it into .env.local.\n",
      ),
  );
}

main().catch((e) => {
  console.error(bad(e.message));
  process.exit(1);
});
