/**
 * Bundle the Lambda into a single ESM file.
 *
 * Bundling rather than zipping node_modules keeps the artifact small (cold
 * starts matter for a demo a judge clicks once) and makes the deployed code
 * exactly reviewable — one file, no transitive surprises.
 *
 * The AWS SDK is left external: the nodejs22.x runtime already ships v3, so
 * bundling it would add megabytes to download on every cold start for no gain.
 *
 * Run: npm run api:build
 */
import { build } from "esbuild";
import { mkdirSync, statSync } from "node:fs";

mkdirSync("api/dist", { recursive: true });
mkdirSync("api/dist-worker", { recursive: true });

await build({
  entryPoints: ["api/handler.js"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "api/dist/index.mjs",
  external: ["@aws-sdk/*"],
  // pg and dotenv are CommonJS; an ESM bundle needs a require shim for them.
  //
  // Deliberately minimal. An earlier version also injected __filename and
  // __dirname, which collided with a `dirname` the bundled modules already
  // import — the whole function then failed to load with a syntax error at
  // cold start rather than anything traceable to the banner.
  banner: {
    js: [
      "import { createRequire as __interlockRequire } from 'module';",
      "const require = __interlockRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "warning",
});

const BANNER = [
  "import { createRequire as __interlockRequire } from 'module';",
  "const require = __interlockRequire(import.meta.url);",
].join("\n");

// The SQS worker is a separate function with its own concurrency, timeout and
// failure semantics, so it gets its own artifact rather than sharing the API's.
await build({
  entryPoints: ["api/worker.js"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "api/dist-worker/index.mjs",
  external: ["@aws-sdk/*"],
  banner: { js: BANNER },
  logLevel: "warning",
});

const kb = (p) => (statSync(p).size / 1024).toFixed(1);
console.log(`bundled api/dist/index.mjs (${kb("api/dist/index.mjs")} KB)`);
console.log(`bundled api/dist-worker/index.mjs (${kb("api/dist-worker/index.mjs")} KB)`);
