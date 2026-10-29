/**
 * Build, zip and push the Lambda, then smoke-test the live URL.
 *
 * The smoke test is not optional decoration. A Lambda that fails at cold start
 * returns a bare 502 with nothing useful in it, and the actual cause sits in
 * CloudWatch — so a deploy that does not immediately prove the function
 * responds is a deploy that looks fine and is not.
 *
 * Run: npm run api:deploy
 */
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PROJECT_ROOT } from "../scripts/env.js";

const FN = process.env.LAMBDA_FUNCTION || "interlock-api";
const ok = (s) => `\x1b[32mOK\x1b[0m    ${s}`;
const bad = (s) => `\x1b[31mFAIL\x1b[0m  ${s}`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const sh = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", shell: true }).trim();

console.log("\n\x1b[1mDeploying INTERLOCK API\x1b[0m\n");

sh("node", ["api/build.mjs"]);
console.log(ok("bundled"));

// Zip with the entry named index.mjs, which is what the handler config expects.
const work = mkdtempSync(join(tmpdir(), "interlock-fn-"));
const zip = join(work, "fn.zip");
sh("powershell", [
  "-NoProfile", "-Command",
  `"Compress-Archive -Path '${join(PROJECT_ROOT, "api", "dist", "index.mjs")}' -DestinationPath '${zip}' -Force"`,
]);

sh("aws", [
  "lambda", "update-function-code",
  "--function-name", FN,
  "--zip-file", `fileb://${zip}`,
  "--query", '"LastUpdateStatus"',
  "--output", "text",
]);
sh("aws", ["lambda", "wait", "function-updated", "--function-name", FN]);
console.log(ok("code updated"));

const url = sh("aws", [
  "lambda", "get-function-url-config",
  "--function-name", FN,
  "--query", '"FunctionUrl"',
  "--output", "text",
]);

console.log(dim(`\n  smoke testing ${url}v1/health …`));
const res = await fetch(`${url}v1/health`);
const body = await res.json().catch(() => null);

if (!res.ok || !body?.ok) {
  console.log(bad(`health check returned ${res.status}`));
  console.log(dim(`  ${JSON.stringify(body)?.slice(0, 300)}`));
  console.log(
    dim(`\n  logs: aws logs tail /aws/lambda/${FN} --since 5m --follow\n`),
  );
  process.exit(1);
}

console.log(ok(`healthy — ${body.topology.regions.length} regions, survival "${body.topology.survivalGoal}"`));
console.log(dim(`  quota today: ${body.quota.callsToday}/${body.quota.callLimit} calls, $${body.quota.usdToday.toFixed(4)}/$${body.quota.usdLimit}`));
console.log(`\n  ${url}\n`);
