import { afterEach, describe, expect, it, vi } from "vitest";
import { Action, ActionState, EffectState, VerdictDisposition } from "../../src/recovery-engine/types";
import {
  GitHubIssueExecutor,
  githubMarker,
} from "../../src/recovery-engine/github-issue";

const testAction = (): Action => ({
  idemKey: "d".repeat(64),
  episodeId: "episode",
  agentId: "agent",
  actionType: "github.create_issue",
  actionArgs: { owner: "octo-org", repository: "widgets", title: "Fault injection test", body: "test" },
  status: ActionState.Pending,
  effectState: EffectState.InProgress,
  leaseOwner: "agent",
  leaseExpires: new Date(Date.now() + 60_000),
  externalRef: "",
  outcome: {},
  attempts: 1,
});

const response = (status: number) => ({ ok: status >= 200 && status < 300, status, json: async () => ({}) } as Response);

afterEach(() => { vi.unstubAllEnvs(); });

describe("GitHub post-success crash seam", () => {
  it("has no mutable fault-injection capability in production execution", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GITHUB_REPOSITORY", "octo-org/widgets");
    const action = testAction();
    const issue = { number: 11, title: action.actionArgs.title, body: `${action.actionArgs.body}\n\n${githubMarker(action)}`, html_url: "https://github.com/octo-org/widgets/issues/11" };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(201))
      .mockResolvedValueOnce({ ...response(200), json: async () => [issue] } as Response);
    const hook = vi.fn();
    const mutableOptions: any = { afterSuccessfulPost: hook };
    const Executor: any = GitHubIssueExecutor;
    const executor = new Executor("test-token", fetcher, mutableOptions);
    mutableOptions.afterSuccessfulPost = () => { throw new Error("should never run"); };

    const verdict = await executor.execute(action);
    expect(verdict.disposition).toBe(VerdictDisposition.Applied);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][1]?.method).toBe("POST");
    expect(hook).not.toHaveBeenCalled();
  });
});
