/**
 * Managed MCP Server client -- the auditor's console.
 *
 * WHY THIS EXISTS
 * Everything else in this project writes. This is the one path that only reads,
 * and that is deliberate. When a conflict has gone wrong, somebody has to go
 * and look: which intents were open, what did the adjudicator rule, what did an
 * agent believe at the moment it decided. Investigation is inherently read-only,
 * so the safe-by-default posture of CockroachDB's managed MCP server -- read-only
 * mode, full audit logging, no custom proxy -- is exactly the right shape for it.
 *
 * An investigator that could accidentally mutate the incident it is investigating
 * would be a liability. This one cannot.
 *
 * AUTHENTICATION
 * The console shows an OAuth flow, which needs an interactive browser round-trip.
 * The server also accepts a service-account API key as a bearer token, which is
 * what we use: it works headlessly, in CI, and from an agent -- and it is the
 * same key the continuity agent uses for the control plane, so there is one
 * credential to rotate rather than two.
 *
 * Run: npm run mcp
 */
import "../scripts/env.js";

const ENDPOINT = process.env.CRDB_MCP_URL || "https://cockroachlabs.cloud/mcp";

let nextId = 1;

/** One JSON-RPC round trip. The server replies as SSE, so unwrap that. */
async function rpc(method, params = {}) {
  const apiKey = process.env.CCLOUD_API_KEY;
  const clusterId = process.env.CRDB_CLUSTER_ID;
  if (!apiKey || !clusterId) {
    throw new Error("CCLOUD_API_KEY and CRDB_CLUSTER_ID must be set (see SETUP.md)");
  }

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${apiKey}`,
      "mcp-cluster-id": clusterId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });

  if (!res.ok) {
    throw new Error(`MCP ${method} -> HTTP ${res.status}: ${await res.text()}`);
  }

  const text = await res.text();
  // Server-sent events: the payload rides on `data:` lines.
  const line = text
    .split("\n")
    .find((l) => l.startsWith("data:"));
  const json = JSON.parse(line ? line.slice(5).trim() : text);

  if (json.error) {
    throw new Error(`MCP ${method}: ${json.error.message ?? JSON.stringify(json.error)}`);
  }
  return json.result;
}

export async function initialize() {
  return rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "interlock-auditor", version: "0.1.0" },
  });
}

export async function listTools() {
  const r = await rpc("tools/list");
  return r.tools ?? [];
}

export async function callTool(name, args = {}) {
  return rpc("tools/call", { name, arguments: args });
}

/** Unwrap the text payload MCP tool results carry. */
function textOf(result) {
  return (result?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** Tool results arrive as `{"rows":[...]}` in a text block. Pull the rows out. */
export function rowsOf(result) {
  try {
    const parsed = JSON.parse(textOf(result));
    return Array.isArray(parsed?.rows) ? parsed.rows : [];
  } catch {
    return [];
  }
}

/** Minimal fixed-width table so console output is readable rather than raw JSON. */
export function formatRows(rows, columns) {
  if (rows.length === 0) return "  (no rows)";
  const cols = columns ?? Object.keys(rows[0]);
  const width = Object.fromEntries(
    cols.map((c) => [
      c,
      Math.min(
        Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)),
        46,
      ),
    ]),
  );
  const clip = (v, w) => {
    const s = String(v ?? "");
    return (s.length > w ? `${s.slice(0, w - 1)}…` : s).padEnd(w);
  };

  const head = `  ${cols.map((c) => clip(c, width[c])).join("  ")}`;
  const rule = `  ${cols.map((c) => "-".repeat(width[c])).join("  ")}`;
  const body = rows.map((r) => `  ${cols.map((c) => clip(r[c], width[c])).join("  ")}`);
  return [head, rule, ...body].join("\n");
}

/**
 * Investigate the most recent conflicts, entirely through the MCP server.
 *
 * This is the console doing its actual job. Every query below goes over MCP
 * rather than over our own pooled connection, which means each one is audit
 * logged by CockroachDB Cloud and none of them can write. That is the point:
 * an auditor reconstructing an incident should leave a trail and change
 * nothing.
 */
export async function auditRecentConflicts({ limit = 5 } = {}) {
  // NOTE: no follower read here, deliberately.
  //
  // `AS OF SYSTEM TIME follower_read_timestamp()` would be the right choice for
  // an auditor — history a few seconds stale is exactly the trade an
  // investigation should make, and it keeps a console someone left open off the
  // leaseholder that live adjudication depends on.
  //
  // The managed MCP server rejects it:
  //
  //   inconsistent AS OF SYSTEM TIME timestamp; expected: …, got: …
  //
  // It evaluates the expression separately from the statement it wraps, so a
  // dynamically-computed timestamp cannot agree with itself across the two.
  // Reported as feedback in docs/SUBMISSION.md. Our own connection has no such
  // problem, so the API's audit feed does use follower reads.
  //
  // Single line, no trailing semicolon: the server enforces exactly one
  // statement per call, which is part of how it stays safe by default.
  const query =
    `SELECT ag.name AS agent, a.verdict::STRING AS verdict, a.detected_by, ` +
    `a.steps_repaired, a.steps_total, a.model_id, left(a.rationale, 80) AS rationale ` +
    `FROM adjudication a ` +
    `JOIN intent i ON i.id = a.intent_id ` +
    `JOIN agent ag ON ag.id = i.agent_id ` +
    `ORDER BY a.decided_at DESC LIMIT ${Number(limit)}`;

  return rowsOf(await callTool("select_query", { database: "interlock", query }));
}

/** Confirm the resilience posture through the audited channel, not our own. */
export async function auditTopology() {
  return rowsOf(
    await callTool("show_statement", {
      database: "interlock",
      query: "SHOW REGIONS FROM DATABASE interlock",
    }),
  );
}

/* -------------------------------------------------------------------- main */

const isMain = process.argv[1]?.endsWith("mcp.js");
if (isMain) {
  const ok = (s) => `\x1b[32mOK\x1b[0m    ${s}`;
  const dim = (s) => `\x1b[2m${s}\x1b[0m`;
  const b = (s) => `\x1b[1m${s}\x1b[0m`;

  console.log(b("\nManaged MCP Server -- auditor console\n"));

  const init = await initialize();
  console.log(
    ok(
      `connected to ${init.serverInfo?.name} v${init.serverInfo?.version} ` +
        `(protocol ${init.protocolVersion})`,
    ),
  );
  console.log(dim(`      auth: service-account API key, no OAuth round-trip needed`));

  const tools = await listTools();
  const readOnly = tools.filter((t) =>
    /^(select_query|explain_query|show_|get_|list_)/.test(t.name),
  );
  console.log(
    ok(
      `${tools.length} tools exposed, ${readOnly.length} of them read-only ` +
        `(${readOnly.map((t) => t.name).slice(0, 4).join(", ")}, …)`,
    ),
  );

  console.log(b("\nRecent conflict rulings") + dim("  (queried over MCP, audit logged)\n"));
  try {
    const rows = await auditRecentConflicts({ limit: 6 });
    console.log(
      rows.length
        ? formatRows(rows, [
            "agent",
            "verdict",
            "detected_by",
            "steps_repaired",
            "steps_total",
            "rationale",
          ])
        : dim("  no adjudications yet — run `npm run demo` or `npm run bench`"),
    );
  } catch (e) {
    console.log(dim(`  ${e.message}`));
  }

  console.log(b("\nResilience posture") + dim("  (confirmed through the audited channel)\n"));
  try {
    const topo = await auditTopology();
    console.log(formatRows(topo, ["region", "primary", "zones"]));
  } catch (e) {
    console.log(dim(`  ${e.message}`));
  }

  console.log(
    dim(
      "\n  Every statement above travelled over the managed MCP server: read-only,\n" +
        "  audit logged, no custom proxy. This console can reconstruct an incident;\n" +
        "  it cannot alter the incident it is reconstructing.\n",
    ),
  );
}
