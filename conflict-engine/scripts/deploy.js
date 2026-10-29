/**
 * Build, upload and invalidate — one command.
 *
 * The demo has to stay reachable from submission until judging closes, weeks
 * later. Making redeployment a single reproducible command is what keeps that
 * true: a deploy that takes six remembered steps is a deploy that eventually
 * gets done wrong at 1am.
 *
 * Cache strategy: hashed assets under _next/static are immutable and cached for
 * a year; HTML is cached briefly and invalidated on every deploy. Without the
 * split, either the HTML goes stale or the CDN loses its point.
 *
 * Run: npm run deploy
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { PROJECT_ROOT } from "./env.js";

const BUCKET = process.env.DEPLOY_BUCKET || "interlock-demo-957325809861";
const DISTRIBUTION = process.env.DEPLOY_DISTRIBUTION || "E28B4TIDHNXJU9";
const WEB = join(PROJECT_ROOT, "web");

const b = (s) => `\x1b[1m${s}\x1b[0m`;
const ok = (s) => `\x1b[32mOK\x1b[0m    ${s}`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: "inherit", shell: true, ...opts });

/**
 * Quote a path for a shell-invoked command.
 *
 * This project's directory contains spaces and a multiplication sign, so an
 * unquoted path is parsed as several arguments and the sync fails with a
 * confusing "command failed" rather than anything mentioning quoting.
 */
const q = (p) => `"${p}"`;

console.log(b("\nDeploying INTERLOCK\n"));

console.log(dim("  building static export…"));
sh("npm", ["run", "build"], { cwd: WEB });
console.log(ok("built"));

// Immutable assets first, with a long TTL. Their filenames carry a content
// hash, so a stale copy is impossible and caching hard is free.
console.log(dim("\n  uploading hashed assets…"));
sh("aws", [
  "s3", "sync", q(join(WEB, "out", "_next")), `s3://${BUCKET}/_next`,
  "--delete",
  "--cache-control", '"public,max-age=31536000,immutable"',
]);

// Then everything else, cached briefly so a redeploy is visible quickly.
console.log(dim("\n  uploading pages…"));
sh("aws", [
  "s3", "sync", q(join(WEB, "out")), `s3://${BUCKET}`,
  "--delete",
  "--exclude", '"_next/*"',
  "--cache-control", '"public,max-age=60,must-revalidate"',
]);
console.log(ok("uploaded"));

console.log(dim("\n  invalidating CDN…"));
sh("aws", [
  "cloudfront", "create-invalidation",
  "--distribution-id", DISTRIBUTION,
  "--paths", '"/*"',
  "--query", '"Invalidation.Id"',
  "--output", "text",
]);

console.log(
  ok(`deployed`) + dim(`\n\n  https://d3dgn014prmcy8.cloudfront.net\n`),
);
