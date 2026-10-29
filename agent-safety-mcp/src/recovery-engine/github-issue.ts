import type { ActionVerifier } from "./reconciliation";
import { Action, Verdict, VerdictDisposition } from "./types";

export const GITHUB_CREATE_ISSUE = "github.create_issue";
const API = "https://api.github.com";

export function githubToken(): string | undefined {
  const token = process.env.GITHUB_TOKEN;
  return token && token.trim() ? token.trim() : undefined;
}

/** The single repository this deployment is permitted to create and verify issues in. */
export function githubRepository(): string | undefined {
  const configured = process.env.GITHUB_REPOSITORY?.trim();
  if (!configured) return undefined;
  const parts = configured.split("/");
  if (parts.length !== 2) return undefined;
  const [owner, repository] = parts;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) return undefined;
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repository) || repository === "." || repository === "..") return undefined;
  return `${owner}/${repository}`;
}

export function assertConfiguredGithubRepository(args: { owner: string; repository: string }): void {
  const configured = githubRepository();
  if (!configured) throw new Error("GITHUB_REPOSITORY must be configured as owner/repository");
  if (`${args.owner}/${args.repository}`.toLowerCase() !== configured.toLowerCase()) {
    throw new Error("GitHub action repository does not match GITHUB_REPOSITORY");
  }
}

export function validateCreateIssueArgs(args: any): asserts args is {
  owner: string; repository: string; title: string; body: string;
} {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("arguments must be an object");
  const keys = Object.keys(args).sort().join(",");
  if (keys !== "body,owner,repository,title") throw new Error("github.create_issue requires exactly owner, repository, title, and body");
  if (typeof args.owner !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(args.owner)) throw new Error("owner is invalid");
  if (typeof args.repository !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(args.repository) || args.repository === "." || args.repository === "..") throw new Error("repository is invalid");
  if (typeof args.title !== "string" || !args.title.trim() || args.title.length > 256) throw new Error("title must be 1–256 characters");
  if (typeof args.body !== "string" || args.body.length > 65536) throw new Error("body must be a string no longer than 65536 characters");
}

export function githubMarker(action: Action): string {
  return `<!-- agent-safety-mcp-action:${action.idemKey} -->`;
}

export class GitHubIssueVerifier implements ActionVerifier {
  constructor(private token: string, private fetcher: typeof fetch = fetch) {}

  async verify(action: Action): Promise<Verdict> {
    const unknown = (reason: string): Verdict => ({ disposition: VerdictDisposition.Unknown, externalRef: "", outcome: {}, reason });
    if (action.actionType !== GITHUB_CREATE_ISSUE) return unknown("Unsupported action type");
    try { validateCreateIssueArgs(action.actionArgs); } catch { return unknown("Invalid persisted GitHub issue arguments"); }
    try { assertConfiguredGithubRepository(action.actionArgs); } catch { return unknown("Persisted GitHub issue repository is not the configured repository"); }
    const { owner, repository, title, body } = action.actionArgs;
    const marker = githubMarker(action);
    try {
      // Enumerate the authoritative repository issues endpoint. An incomplete or
      // failed listing can never establish non-application.
      let matchingIssue: any;
      for (let page = 1; page <= 100; page++) {
        const response = await this.fetcher(`${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues?state=all&per_page=100&page=${page}`, {
          headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${this.token}`, "X-GitHub-Api-Version": "2022-11-28" },
        });
        if (!response.ok) return unknown(`GitHub issue lookup returned HTTP ${response.status}`);
        const issues: any = await response.json();
        if (!Array.isArray(issues)) return unknown("GitHub issue lookup returned an inconclusive response");
        const matches = issues.filter((issue) => !issue?.pull_request && typeof issue?.body === "string" && issue.body.includes(marker));
        if (matches.length > 1 || (matches.length === 1 && matchingIssue)) {
          return unknown("Multiple GitHub issues contain the action correlation marker");
        }
        if (matches.length === 1) matchingIssue = matches[0];
        if (issues.length < 100) {
          if (!matchingIssue) return unknown("No matching issue is currently visible; GitHub lookup cannot prove non-application after an ambiguous request");
          if (matchingIssue.title !== title || matchingIssue.body !== `${body}${body ? "\n\n" : ""}${marker}`) return unknown("Issue marker matched but issue content did not");
          if (!Number.isSafeInteger(matchingIssue.number) || matchingIssue.number < 1 || typeof matchingIssue.html_url !== "string") return unknown("GitHub issue response is missing a valid issue reference");
          return { disposition: VerdictDisposition.Applied, externalRef: String(matchingIssue.number), outcome: { status: "success", issue_number: matchingIssue.number, html_url: matchingIssue.html_url }, reason: "GitHub repository API confirmed the issue and correlation marker" };
        }
      }
      return unknown("GitHub issue listing exceeded the verification limit");
    } catch {
      return unknown("GitHub issue lookup failed");
    }
  }
}

export async function createGitHubIssue(token: string, action: Action, fetcher: typeof fetch = fetch): Promise<void> {
  validateCreateIssueArgs(action.actionArgs);
  assertConfiguredGithubRepository(action.actionArgs);
  const { owner, repository, title, body } = action.actionArgs;
  const response = await fetcher(`${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues`, {
    method: "POST", headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
    body: JSON.stringify({ title, body: `${body}${body ? "\n\n" : ""}${githubMarker(action)}` }),
  });
  if (!response.ok) {
    // A client error from GitHub means the create was rejected. Server errors and
    // throttling remain ambiguous and must be reconciled without retrying.
    if (response.status === 422) throw Object.assign(new Error("GitHub rejected the issue payload (HTTP 422)"), { confirmedNotApplied: true });
    throw new Error(`GitHub issue creation outcome is ambiguous (HTTP ${response.status})`);
  }
}

const attemptedIssueActions = new Set<string>();

/** One-shot executor: once a POST may have been sent, this process never repeats it. */
export class GitHubIssueExecutor {
  constructor(private token: string, private fetcher: typeof fetch = fetch) {}

  async execute(action: Action): Promise<Verdict> {
    const unknown = (reason: string): Verdict => ({ disposition: VerdictDisposition.Unknown, externalRef: "", outcome: {}, reason });
    if (action.status !== "PENDING" || action.effectState !== "IN_PROGRESS" || !action.leaseOwner || !action.leaseExpires || action.leaseExpires.getTime() <= Date.now()) {
      return unknown("Action is not in progress under a live lease");
    }
    try {
      validateCreateIssueArgs(action.actionArgs);
      assertConfiguredGithubRepository(action.actionArgs);
    } catch { return unknown("GitHub action repository is not the configured repository"); }
    if (attemptedIssueActions.has(action.idemKey)) return unknown("Issue creation was already attempted; refusing to retry");
    attemptedIssueActions.add(action.idemKey);
    try {
      await createGitHubIssue(this.token, action, this.fetcher);
      return await new GitHubIssueVerifier(this.token, this.fetcher).verify(action);
    } catch (error: any) {
      if (error?.confirmedNotApplied) return { disposition: VerdictDisposition.NotApplied, externalRef: "", outcome: { status: "failed" }, reason: "GitHub rejected the issue payload" };
      return unknown("GitHub create outcome is ambiguous; the request will not be retried");
    }
  }
}
