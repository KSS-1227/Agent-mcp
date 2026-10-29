/**
 * The adjudicator investigates before it rules — over MCP, read-only.
 *
 * WHY THIS IS DIFFERENT FROM HOW MCP IS USUALLY USED
 * The managed MCP server is normally framed as a console for a human: ask your
 * database questions in natural language. Here it is a tool belt for the
 * *agent* that has to make the call.
 *
 * When a commit threatens an in-flight plan, the adjudicator sees the plan, the
 * commit, and the diff. Sometimes that is enough. Sometimes the honest answer
 * is "I need to look something up" — has this resource been churning all
 * morning, or is this the first change in an hour? Is the committing agent
 * making one considered change or thrashing?
 *
 * A model that cannot look things up has to guess. One that can, does not.
 *
 * WHY MCP RATHER THAN OUR OWN CONNECTION
 * We already hold a database connection; routing these lookups through it would
 * be faster and simpler. Going over MCP buys two things that matter more than
 * speed here:
 *
 *   1. The server is read-only by default. An agent investigating an incident
 *      is structurally incapable of altering the incident. That is not a policy
 *      we enforce, it is a channel that cannot express the mutation.
 *
 *   2. Every lookup is audit-logged by CockroachDB Cloud, outside our own
 *      logging. When an automated decision is questioned later, the record of
 *      what the decider looked at is not kept by the decider.
 *
 * The investigation budget is deliberately small: one round, three tools. An
 * adjudicator that can investigate indefinitely costs more than the work it is
 * protecting, which is the trap this whole project is about.
 */
import { callTool, rowsOf } from "./mcp.js";

/** What the adjudicator is allowed to ask. All read-only, all bounded. */
export const INVESTIGATIONS = {
  resource_history: {
    describe:
      "Recent commits against the contended resource. Use to tell a one-off change from sustained churn.",
    async run({ resourceId }) {
      const query =
        `SELECT ag.name AS agent, c.prev_version, c.new_version, ` +
        `left(c.statement, 90) AS statement, c.committed_at ` +
        `FROM commit_log c JOIN agent ag ON ag.id = c.agent_id ` +
        `WHERE c.resource_id = '${resourceId}' ` +
        `ORDER BY c.committed_at DESC LIMIT 5`;
      return rowsOf(await callTool("select_query", { database: "interlock", query }));
    },
  },

  agent_track_record: {
    describe:
      "How this agent's previous intents were ruled. Use to weigh whether its plans usually survive.",
    async run({ agentId }) {
      const query =
        `SELECT a.verdict::STRING AS verdict, a.steps_repaired, a.steps_total, ` +
        `left(a.rationale, 80) AS rationale ` +
        `FROM adjudication a JOIN intent i ON i.id = a.intent_id ` +
        `WHERE i.agent_id = '${agentId}' ` +
        `ORDER BY a.decided_at DESC LIMIT 5`;
      return rowsOf(await callTool("select_query", { database: "interlock", query }));
    },
  },

  contention_now: {
    describe:
      "Other intents currently open against the same resource. Use to judge whether repairing is even worth it.",
    async run({ resourceId }) {
      const query =
        `SELECT ag.name AS agent, i.status::STRING AS status, ` +
        `left(i.statement, 90) AS statement ` +
        `FROM intent i ` +
        `JOIN intent_read ir ON ir.intent_id = i.id ` +
        `JOIN agent ag ON ag.id = i.agent_id ` +
        `WHERE ir.resource_id = '${resourceId}' AND i.status IN ('open','threatened') ` +
        `LIMIT 5`;
      return rowsOf(await callTool("select_query", { database: "interlock", query }));
    },
  },
};

export const INVESTIGATION_MENU = Object.entries(INVESTIGATIONS)
  .map(([name, v]) => `  ${name} — ${v.describe}`)
  .join("\n");

/**
 * Run one requested investigation.
 * Unknown names return null rather than throwing: a model inventing a tool name
 * should cost us a skipped lookup, not a failed adjudication.
 */
export async function investigate(name, args) {
  const tool = INVESTIGATIONS[name];
  if (!tool) return null;
  try {
    const rows = await tool.run(args);
    return { name, rows: rows.slice(0, 5) };
  } catch (e) {
    // MCP being unavailable must degrade the ruling's evidence, never block it.
    return { name, error: e.message?.split("\n")[0]?.slice(0, 120) };
  }
}
