import { query, closePool } from "../agents/db.js";

const tests = [
  ["core changefeed (session-scoped)", "EXPERIMENTAL CHANGEFEED FOR commit_log WITH cursor = '-1s'"],
  ["enterprise changefeed to a sink", "CREATE CHANGEFEED FOR TABLE commit_log INTO 'null://'"],
  ["changefeed jobs visible", "SELECT count(*) FROM [SHOW CHANGEFEED JOBS]"],
];

for (const [label, sql] of tests) {
  try {
    // Core changefeeds stream forever; race them against a short timer.
    await Promise.race([
      query(sql),
      new Promise((_, rej) => setTimeout(() => rej(new Error("streams indefinitely (works)")), 2500)),
    ]);
    console.log(`OK      ${label}`);
  } catch (e) {
    const msg = e.message.split("\n")[0];
    console.log(`${/works/.test(msg) ? "OK     " : "BLOCKED"} ${label}`);
    console.log(`        ${msg.slice(0, 150)}`);
  }
}

await closePool();
