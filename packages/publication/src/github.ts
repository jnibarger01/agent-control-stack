import type { WorkItemStore } from "@agent-control-stack/work-items";
import type { PublicationRecord, PublicationStore, PullRequestClient } from "./index.js";

export function createSqlitePublicationStore(
  store: Pick<
    WorkItemStore,
    "getPublicationByIdempotency" | "recordPublication" | "getValidationRunForAttempt" | "getCurrentExecutionPlan"
  >
): PublicationStore {
  return {
    getByIdempotency: (key) => store.getPublicationByIdempotency(key) as PublicationRecord | undefined,
    record: (record) => store.recordPublication({ workItemId: record.workItemId, attemptId: record.attemptId, branch: record.branch, commitSha: record.commitSha, pullRequestUrl: record.pullRequestUrl, idempotencyKey: record.idempotencyKey }, { via: "domain_service" }) as unknown as PublicationRecord,
    getValidationRunForAttempt: (attemptId) => {
      const run = store.getValidationRunForAttempt(attemptId);
      return run ? { passed: run.passed } : undefined;
    },
    planAllowsPush: (workItemId) => {
      const plan = store.getCurrentExecutionPlan(workItemId);
      // The current execution-plan schema hardcodes allowPush to the
      // literal `false` (production dry-run boundary): this is written to
      // stay correct if that constraint is ever relaxed to a real boolean,
      // rather than baking in "always false" here too.
      return (plan?.definition.constraints.allowPush as boolean | undefined) === true;
    }
  };
}

export interface GitHubClientOptions {
  owner: string;
  repository: string;
  tokenSource: () => string | undefined;
  /**
   * Base branch new PRs target. Defaults to the repository's actual
   * configured default branch (resolved once and cached) rather than
   * assuming every repository uses "main".
   */
  baseBranch?: string;
  fetchImpl?: typeof fetch;
}

/** ACS-owned GitHub boundary. It performs PR create/update only; never merge/deploy. */
export class GitHubPullRequestClient implements PullRequestClient {
  private readonly fetchImpl: typeof fetch;
  private resolvedBaseBranch: string | undefined;
  constructor(private readonly options: GitHubClientOptions) { this.fetchImpl = options.fetchImpl ?? fetch; }

  private authHeaders(token: string) {
    return { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" };
  }

  private async resolveBaseBranch(base: string, token: string): Promise<string> {
    if (this.options.baseBranch) return this.options.baseBranch;
    if (this.resolvedBaseBranch) return this.resolvedBaseBranch;
    const response = await this.fetchImpl(base, { headers: this.authHeaders(token) });
    if (!response.ok) throw new Error(`GitHub repository lookup failed: ${response.status}`);
    const repository = await response.json() as { default_branch?: string };
    if (!repository.default_branch) throw new Error("GitHub repository lookup did not return a default branch");
    this.resolvedBaseBranch = repository.default_branch;
    return this.resolvedBaseBranch;
  }

  async createOrUpdate(input: { branch: string; commitSha: string; title: string; body: string; idempotencyKey: string }): Promise<{ url: string }> {
    const token = this.options.tokenSource();
    if (!token) throw new Error("GitHub publication token is unavailable");
    const base = `https://api.github.com/repos/${encodeURIComponent(this.options.owner)}/${encodeURIComponent(this.options.repository)}`;
    const headers = this.authHeaders(token);
    const existingResponse = await this.fetchImpl(`${base}/pulls?head=${encodeURIComponent(`${this.options.owner}:${input.branch}`)}&state=open`, { headers });
    if (!existingResponse.ok) throw new Error(`GitHub PR lookup failed: ${existingResponse.status}`);
    const existing = await existingResponse.json() as Array<{ number: number; html_url: string }>;
    const payload = { title: input.title, body: `${input.body}\n\nACS commit: ${input.commitSha}\nACS idempotency: ${input.idempotencyKey}` };
    if (existing[0]) {
      const response = await this.fetchImpl(`${base}/pulls/${existing[0].number}`, { method: "PATCH", headers, body: JSON.stringify(payload) });
      if (!response.ok) throw new Error(`GitHub PR update failed: ${response.status}`);
      return { url: existing[0].html_url };
    }
    const baseBranch = await this.resolveBaseBranch(base, token);
    const response = await this.fetchImpl(`${base}/pulls`, { method: "POST", headers, body: JSON.stringify({ ...payload, head: input.branch, base: baseBranch }) });
    if (!response.ok) throw new Error(`GitHub PR create failed: ${response.status}`);
    const created = await response.json() as { html_url: string };
    return { url: created.html_url };
  }
}
