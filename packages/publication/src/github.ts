import type { WorkItemStore } from "@agent-control-stack/work-items";
import type { PublicationRecord, PublicationStore, PullRequestClient } from "./index.js";

export function createSqlitePublicationStore(store: Pick<WorkItemStore, "getPublicationByIdempotency" | "recordPublication">): PublicationStore {
  return {
    getByIdempotency: (key) => store.getPublicationByIdempotency(key) as PublicationRecord | undefined,
    record: (record) => store.recordPublication({ workItemId: record.workItemId, attemptId: record.attemptId, branch: record.branch, commitSha: record.commitSha, pullRequestUrl: record.pullRequestUrl, idempotencyKey: record.idempotencyKey }, { via: "domain_service" }) as unknown as PublicationRecord
  };
}

export interface GitHubClientOptions {
  owner: string;
  repository: string;
  tokenSource: () => string | undefined;
  fetchImpl?: typeof fetch;
}

/** ACS-owned GitHub boundary. It performs PR create/update only; never merge/deploy. */
export class GitHubPullRequestClient implements PullRequestClient {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: GitHubClientOptions) { this.fetchImpl = options.fetchImpl ?? fetch; }

  async createOrUpdate(input: { branch: string; commitSha: string; title: string; body: string; idempotencyKey: string }): Promise<{ url: string }> {
    const token = this.options.tokenSource();
    if (!token) throw new Error("GitHub publication token is unavailable");
    const base = `https://api.github.com/repos/${encodeURIComponent(this.options.owner)}/${encodeURIComponent(this.options.repository)}`;
    const headers = { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" };
    const existingResponse = await this.fetchImpl(`${base}/pulls?head=${encodeURIComponent(`${this.options.owner}:${input.branch}`)}&state=open`, { headers });
    if (!existingResponse.ok) throw new Error(`GitHub PR lookup failed: ${existingResponse.status}`);
    const existing = await existingResponse.json() as Array<{ number: number; html_url: string }>;
    const payload = { title: input.title, body: `${input.body}\n\nACS commit: ${input.commitSha}\nACS idempotency: ${input.idempotencyKey}` };
    if (existing[0]) {
      const response = await this.fetchImpl(`${base}/pulls/${existing[0].number}`, { method: "PATCH", headers, body: JSON.stringify(payload) });
      if (!response.ok) throw new Error(`GitHub PR update failed: ${response.status}`);
      return { url: existing[0].html_url };
    }
    const response = await this.fetchImpl(`${base}/pulls`, { method: "POST", headers, body: JSON.stringify({ ...payload, head: input.branch, base: "main" }) });
    if (!response.ok) throw new Error(`GitHub PR create failed: ${response.status}`);
    const created = await response.json() as { html_url: string };
    return { url: created.html_url };
  }
}
