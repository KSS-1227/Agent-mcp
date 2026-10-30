import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Synthetic, non-resolvable PostgreSQL URL. getActionProtocolTools() validates the
// prefix before the mocked database factory is consulted, so this test supplies its
// own value instead of depending on an ambient .env.
const SYNTHETIC_DATABASE_URL = "postgresql://tester@isolation.invalid:5432/agent_safety_test";
import { AgentService, setAgentService } from "../../src/core/agent.service";
import { TaskService } from "../../src/core/task.service";
import {
  IntentService,
  setIntentService,
} from "../../src/conflict-engine/intent.service";
import { ActionState } from "../../src/recovery-engine/types";

const databaseMock = vi.hoisted(() => ({
  rows: new Map<string, Record<string, any>>(),
  episodes: new Map<string, Record<string, any>>(),
  actionInsertEpisodeChecks: [] as Array<{ episodeId: string; existed: boolean }>,
  query: vi.fn(),
  failEffectUpdate: false,
  throwEffectUpdate: false,
}));

vi.mock("../../src/database/client", () => ({
  createDatabaseClient: () => ({ pool: { query: databaseMock.query, connect: async () => ({ query: databaseMock.query, release: () => {} }) } }),
}));

import { getActionProtocolTools } from "../../src/mcp/tools/actions";

describe("prepare_action effect lifecycle", () => {
  const agentService = new AgentService();
  const taskService = new TaskService();
  const intentService = new IntentService();
  const owner = agentService.registerAgent("lifecycle-owner", "Lifecycle owner");

  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", SYNTHETIC_DATABASE_URL);
    vi.stubEnv("NODE_ENV", "test");
    databaseMock.rows.clear();
    databaseMock.episodes.clear();
    databaseMock.actionInsertEpisodeChecks = [];
    databaseMock.failEffectUpdate = false;
    databaseMock.throwEffectUpdate = false;
    databaseMock.query.mockReset();
    databaseMock.query.mockImplementation(
      async (text: string, values: any[] = []) => {
        if (text.startsWith("BEGIN") || text === "COMMIT" || text === "ROLLBACK") return { rowCount: 0, rows: [] };
        if (text.includes("SELECT resource_id, observed_version FROM intent_reads")) return { rowCount: 0, rows: [] };
        if (text.includes("INSERT INTO action_resource_versions")) return { rowCount: 1, rows: [] };
        if (text.includes("INSERT INTO episodes")) {
          const [episodeId, narrative] = values;
          if (databaseMock.episodes.has(episodeId)) {
            if (!text.includes("ON CONFLICT (episode_id) DO NOTHING")) {
              throw new Error("Episode collision must not overwrite existing data");
            }
            return { rowCount: 0, rows: [] };
          }
          const episode = { episode_id: episodeId, narrative, outcome: "pending", status: "pending", embedding: null };
          databaseMock.episodes.set(episodeId, episode);
          return { rowCount: 1, rows: [{ episode_id: episodeId }] };
        }

        if (text.includes("INSERT INTO actions") && text.includes("ON CONFLICT")) {
          const [id, episodeId, agentId, actionType, args] = values;
          databaseMock.actionInsertEpisodeChecks.push({
            episodeId,
            existed: databaseMock.episodes.has(episodeId),
          });
          if (databaseMock.rows.has(id)) return { rowCount: 0, rows: [] };
          databaseMock.rows.set(id, {
            idempotency_key: id,
            episode_id: episodeId,
            agent_id: agentId,
            action_type: actionType,
            arguments: args,
            status: ActionState.Pending,
            lease_owner: agentId,
            lease_expires_at: new Date(Date.now() + 60_000),
            external_reference: "",
            coalesce: "",
            outcome: {},
            attempts: 1,
            created_at: new Date(),
            effect_state: "NOT_STARTED",
          });
          return { rowCount: 1, rows: [{ idempotency_key: id }] };
        }

        if (text.includes("SET LOCAL lock_timeout")) return { rowCount: 0, rows: [] };
        if (text.includes("AS difference")) return { rowCount: 1, rows: [{ difference: 0 }] };
        if (text.includes("FROM action_resource_versions")) return { rowCount: 0, rows: [] };
        if (text.includes("UPDATE actions") && text.includes("effect_state = 'IN_PROGRESS'")) {
          if (databaseMock.throwEffectUpdate) {
            throw new Error("effect-state database unavailable");
          }
          if (databaseMock.failEffectUpdate) return { rowCount: 0, rows: [] };
          const [id, leaseOwner] = values;
          const row = databaseMock.rows.get(id);
          if (
            !row ||
            row.status !== ActionState.Pending ||
            row.effect_state !== "NOT_STARTED" ||
            row.lease_owner !== leaseOwner ||
            row.lease_expires_at.getTime() <= Date.now()
          ) {
            return { rowCount: 0, rows: [] };
          }
          row.effect_state = "IN_PROGRESS";
          row.effect_started_at = new Date();
          return { rowCount: 1, rows: [{ idempotency_key: id }] };
        }

        if (text.includes("SELECT idempotency_key, episode_id, agent_id")) {
          const row = databaseMock.rows.get(values[0]);
          return row
            ? { rowCount: 1, rows: [{ ...row, coalesce: row.external_reference }] }
            : { rowCount: 0, rows: [] };
        }

        throw new Error(`Unexpected SQL in test: ${text}`);
      }
    );

    taskService.clear();
    intentService.clear();
    setAgentService(agentService);
    setIntentService(intentService);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function getPrepareTool() {
    return getActionProtocolTools().find((tool) => tool.name === "prepare_action")!;
  }

  function makeIntent() {
    const task = taskService.createTask(owner.id, "Action lifecycle task");
    const intent = intentService.declareIntent(
      owner.id,
      task.id,
      "Execute lifecycle action",
      [],
      [{ description: "Perform external operation" }]
    );
    return { intent, step: intentService.getIntentSteps(intent.id)[0] };
  }

  it("marks the effect IN_PROGRESS before returning an owned action", async () => {
    const { intent, step } = makeIntent();
    const result = await getPrepareTool()._handler({
      intent_id: intent.id,
      step_id: step.id,
      action_type: "lifecycle_action",
      arguments: { item: "one" },
    });

    expect(result.disposition).toBe("OWNED");
    expect(databaseMock.rows.get(result.action_id)?.effect_state).toBe(
      "IN_PROGRESS"
    );
    const expectedEpisodeId = `${intent.id}:${step.id}`;
    expect(databaseMock.actionInsertEpisodeChecks).toEqual([
      { episodeId: expectedEpisodeId, existed: true },
    ]);
    expect(databaseMock.episodes.get(expectedEpisodeId)).toMatchObject({
      episode_id: expectedEpisodeId,
      narrative: step.description,
      outcome: "pending",
      status: "pending",
      embedding: null,
    });
  });

  it("does not overwrite an existing episode when preparing an action", async () => {
    const { intent, step } = makeIntent();
    const episodeId = `${intent.id}:${step.id}`;
    const existingEpisode = {
      episode_id: episodeId,
      narrative: "Existing recovery narrative",
      outcome: "recovered",
      status: "resolved",
      embedding: "preserved-vector",
    };
    databaseMock.episodes.set(episodeId, { ...existingEpisode });

    await getPrepareTool()._handler({
      intent_id: intent.id,
      step_id: step.id,
      action_type: "lifecycle_action",
      arguments: { item: "existing-episode" },
    });

    expect(databaseMock.actionInsertEpisodeChecks).toEqual([
      { episodeId, existed: true },
    ]);
    expect(databaseMock.query.mock.calls[0][0]).toContain("ON CONFLICT (episode_id) DO NOTHING");
    expect(databaseMock.episodes.get(episodeId)).toEqual(existingEpisode);
  });

  it("does not grant an owned action when the IN_PROGRESS update affects no row", async () => {
    const { intent, step } = makeIntent();
    databaseMock.failEffectUpdate = true;

    await expect(
      getPrepareTool()._handler({
        intent_id: intent.id,
        step_id: step.id,
        action_type: "lifecycle_action",
        arguments: { item: "two" },
      })
    ).rejects.toThrow(/not awaiting execution/);
    const [row] = databaseMock.rows.values();
    expect(row.effect_state).toBe("NOT_STARTED");
  });

  it("does not grant an owned action when the IN_PROGRESS update fails", async () => {
    const { intent, step } = makeIntent();
    databaseMock.throwEffectUpdate = true;

    await expect(
      getPrepareTool()._handler({
        intent_id: intent.id,
        step_id: step.id,
        action_type: "lifecycle_action",
        arguments: { item: "three" },
      })
    ).rejects.toThrow(/effect-state database unavailable/);
    const [row] = databaseMock.rows.values();
    expect(row.effect_state).toBe("NOT_STARTED");
  });
});
