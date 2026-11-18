import type { CodingMissionStore } from "@agent-control-stack/coding-mission";
import type { FactoryGitReader } from "./verify.js";

/**
 * F8: authorized, idempotent draft PR creation.
 *
 * The only external side effect the factory has. It publishes the already-verified integrated
 * commit as a DRAFT pull request, and only under an ACS-persisted human approval bound to exactly
 * this repository, target branch, head commit, tree, side effect and idempotency marker. The target
 * branch head and the local tree are re-read immediately before the side effect. Merge, push to
 * the target branch and deploy do not exist on this boundary.
 *
 * Idempotency uses the mission store's effect reservation: one owner per effect; a crash or remote
 * error leaves the effect `unknown`, which is reconciled by looking the PR up, never by creating
 * another one blindly.
 */
export const FACTORY_DRAFT_PR_EFFECT = "factory_draft_pull_request" as const;
export const FACTORY_DRAFT_PR_SIDE_EFFECT = "open_draft_pull_request" as const;

export type FactoryPublishStore = Pick<
  CodingMissionStore,
  "require" | "workUnits" | "reserveEffect" | "succeedEffect" | "effect" | "clearEffect"
>;

/** Persisted by the ACS approval flow. F8 consumes approvals; it never creates one. */
export interface FactoryPublicationApproval {
  approvalId: string;
  approverId: string;
  approverKind: "human" | "agent" | "service";
  missionId: string;
  repository: string;
  targetBranch: string;
  headSha: string;
  treeSha: string;
  sideEffect: string;
  idempotencyKey: string;
  expiresAt: string;
  revoked: boolean;
}

export interface FactoryApprovalSource {
  get(approvalId: string): FactoryPublicationApproval | undefined;
}

export interface FactoryPullRequest {
  number: number;
  url: string;
  headSha: string;
  draft: boolean;
}

/** Draft-only remote boundary. Deliberately has no merge, no base-branch push, no deploy. */
export interface FactoryRemote {
  branchHead(branch: string): Promise<string | undefined>;
  /** Push exactly `sha` to a factory-owned branch. Must refuse to move an existing branch elsewhere. */
  pushFactoryBranch(branch: string, sha: string): Promise<void>;
  findOpenPull(headBranch: string): Promise<FactoryPullRequest | undefined>;
  createDraftPull(input: { headBranch: string; baseBranch: string; title: string; body: string }): Promise<FactoryPullRequest>;
}

export type FactoryPublishResult =
  | { status: "published"; pullRequest: FactoryPullRequest; replayed: boolean }
  | { status: "refused"; reason: string }
  | { status: "conflict"; reason: string }
  /** The side effect may or may not have happened. Nothing will be retried until reconciled. */
  | { status: "uncertain"; reason: string };

export function factoryPublicationIdempotencyKey(missionId: string, headSha: string): string {
  return "factory-pr:" + missionId + ":" + headSha;
}

export function factoryBranch(missionId: string): string {
  return "acs/factory/" + missionId;
}

export async function publishFactoryDraft(
  deps: {
    store: FactoryPublishStore;
    approvals: FactoryApprovalSource;
    remote: FactoryRemote;
    git: FactoryGitReader;
    now?: () => Date;
  },
  input: { missionId: string; approvalId: string; operatorId: string; targetBranch: string; title: string }
): Promise<FactoryPublishResult> {
  const mission = deps.store.require(input.missionId);
  const units = deps.store.workUnits(input.missionId);
  if (units.length === 0 || units.some((unit) => unit.status !== "succeeded" || !unit.resultHash)) {
    return { status: "refused", reason: "mission_not_verified" };
  }
  const head = await deps.git.commit("HEAD");
  if (!head) return { status: "refused", reason: "workspace_head_missing" };
  const tree = await deps.git.tree(head);
  if (!tree) return { status: "refused", reason: "workspace_tree_missing" };
  if (!(await deps.git.isAncestor(mission.baseSha, head))) return { status: "refused", reason: "base_not_ancestor" };

  const branch = factoryBranch(input.missionId);
  const key = factoryPublicationIdempotencyKey(input.missionId, head);
  const prior = deps.store.effect(input.missionId, FACTORY_DRAFT_PR_EFFECT);
  if (prior?.outcome === "succeeded") {
    const detail = prior.detail as { pullRequest?: FactoryPullRequest; idempotencyKey?: string } | undefined;
    if (detail?.idempotencyKey !== key || !detail.pullRequest) return { status: "conflict", reason: "published_for_other_head" };
    return { status: "published", pullRequest: detail.pullRequest, replayed: true };
  }

  const approval = deps.approvals.get(input.approvalId);
  const nowMs = (deps.now?.() ?? new Date()).getTime();
  if (!approval || approval.revoked) return { status: "refused", reason: "approval_missing_or_revoked" };
  if (!(Date.parse(approval.expiresAt) > nowMs)) return { status: "refused", reason: "approval_expired" };
  if (approval.approverKind !== "human") return { status: "refused", reason: "approval_not_human" };
  if (approval.approverId !== input.operatorId) return { status: "refused", reason: "approval_operator_mismatch" };
  if (
    approval.missionId !== input.missionId ||
    approval.repository !== mission.repository ||
    approval.targetBranch !== input.targetBranch ||
    approval.headSha !== head ||
    approval.treeSha !== tree ||
    approval.sideEffect !== FACTORY_DRAFT_PR_SIDE_EFFECT ||
    approval.idempotencyKey !== key
  ) {
    return { status: "refused", reason: "approval_binding_mismatch" };
  }

  const reservation = deps.store.reserveEffect(input.missionId, FACTORY_DRAFT_PR_EFFECT);
  if (reservation === "unknown") {
    // A previous attempt may have created the PR. Look, never create blindly.
    let existing: FactoryPullRequest | undefined;
    try {
      existing = await deps.remote.findOpenPull(branch);
    } catch {
      return { status: "uncertain", reason: "reconcile_lookup_failed" };
    }
    if (existing && existing.headSha === head) {
      deps.store.succeedEffect(input.missionId, FACTORY_DRAFT_PR_EFFECT, existing.url, { pullRequest: existing, idempotencyKey: key, approvalId: approval.approvalId });
      return { status: "published", pullRequest: existing, replayed: true };
    }
    return { status: "uncertain", reason: existing ? "reconcile_head_mismatch" : "reconcile_pull_not_found" };
  }
  if (reservation === "succeeded") {
    const detail = deps.store.effect(input.missionId, FACTORY_DRAFT_PR_EFFECT)?.detail as { pullRequest?: FactoryPullRequest } | undefined;
    if (!detail?.pullRequest) return { status: "uncertain", reason: "effect_detail_missing" };
    return { status: "published", pullRequest: detail.pullRequest, replayed: true };
  }

  // We own the effect. Recheck everything that could have moved, immediately before the side effect.
  try {
    // Until the push starts, provably nothing external happened: release the reservation on refusal
    // so a later, valid attempt is not wedged behind an `unknown` that never had a side effect.
    const target = await deps.remote.branchHead(input.targetBranch).catch((error: unknown) => {
      deps.store.clearEffect(input.missionId, FACTORY_DRAFT_PR_EFFECT);
      throw error;
    });
    if (target !== mission.baseSha) {
      deps.store.clearEffect(input.missionId, FACTORY_DRAFT_PR_EFFECT);
      return { status: "conflict", reason: target ? "target_advanced" : "target_missing" };
    }
    if ((await deps.git.commit("HEAD")) !== head || (await deps.git.tree(head)) !== tree) {
      deps.store.clearEffect(input.missionId, FACTORY_DRAFT_PR_EFFECT);
      return { status: "conflict", reason: "workspace_changed" };
    }
    await deps.remote.pushFactoryBranch(branch, head);
    const pullRequest =
      (await deps.remote.findOpenPull(branch)) ??
      (await deps.remote.createDraftPull({
        headBranch: branch,
        baseBranch: input.targetBranch,
        title: input.title,
        body: pullRequestBody({ missionId: input.missionId, base: mission.baseSha, head, tree, approval, units, key })
      }));
    if (!pullRequest.draft) return { status: "uncertain", reason: "pull_request_not_draft" };
    if (pullRequest.headSha !== head) return { status: "uncertain", reason: "pull_request_head_mismatch" };
    deps.store.succeedEffect(input.missionId, FACTORY_DRAFT_PR_EFFECT, pullRequest.url, {
      pullRequest,
      idempotencyKey: key,
      approvalId: approval.approvalId
    });
    return { status: "published", pullRequest, replayed: false };
  } catch (error) {
    // Rate limit, network, or crash mid-call: the effect stays `unknown` and is reconciled later.
    return { status: "uncertain", reason: "remote_error: " + String((error as Error).message ?? error).slice(0, 200) };
  }
}

function pullRequestBody(input: {
  missionId: string;
  base: string;
  head: string;
  tree: string;
  approval: FactoryPublicationApproval;
  units: { unitId: string; resultHash?: string }[];
  key: string;
}): string {
  return [
    "Draft opened by the ACS AI Factory. ACS never merges or deploys this change.",
    "",
    "## Provenance",
    `- Mission: \`${input.missionId}\``,
    `- Base: \`${input.base}\``,
    `- Head: \`${input.head}\` (tree \`${input.tree}\`)`,
    `- Approval: \`${input.approval.approvalId}\` by \`${input.approval.approverId}\``,
    `- Idempotency: \`${input.key}\``,
    "",
    "## Attested checks (ACS independent verification, not Swarm self-report)",
    ...input.units.map((unit) => `- \`${unit.unitId}\`: verified result \`${unit.resultHash}\``),
    "",
    "## Rollback",
    "Close this draft pull request. Nothing was merged, pushed to the base branch, or deployed."
  ].join("\n");
}

/** GitHub REST implementation. Draft-only; pushes only to `acs/factory/*` via the injected git push. */
export function createGitHubFactoryRemote(options: {
  owner: string;
  repository: string;
  tokenSource: () => string | undefined;
  /** Pushes `sha` to `refs/heads/<branch>` without force. Implemented with git by the caller. */
  push: (branch: string, sha: string) => Promise<void>;
  apiBase?: string;
  fetchImpl?: typeof fetch;
}): FactoryRemote {
  const fetchImpl = options.fetchImpl ?? fetch;
  const root = (options.apiBase ?? "https://api.github.com").replace(/\/+$/u, "") +
    "/repos/" + encodeURIComponent(options.owner) + "/" + encodeURIComponent(options.repository);
  const headers = () => {
    const token = options.tokenSource();
    if (!token) throw new Error("publication token unavailable");
    return {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28"
    };
  };
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await fetchImpl(root + path, { ...init, headers: headers(), redirect: "error" });
    if (response.status === 403 || response.status === 429) throw new Error("rate_limited_or_forbidden_" + response.status);
    return response;
  };
  const toPull = (pull: { number: number; html_url: string; head?: { sha?: string }; draft?: boolean }): FactoryPullRequest => ({
    number: pull.number,
    url: pull.html_url,
    headSha: pull.head?.sha ?? "",
    draft: pull.draft === true
  });
  return {
    async branchHead(branch) {
      const response = await call("/git/ref/heads/" + branch.split("/").map(encodeURIComponent).join("/"));
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error("branch lookup failed " + response.status);
      const body = (await response.json()) as { object?: { sha?: string } };
      return body.object?.sha;
    },
    async pushFactoryBranch(branch, sha) {
      if (!branch.startsWith("acs/factory/")) throw new Error("refusing to push outside acs/factory/*");
      await options.push(branch, sha);
    },
    async findOpenPull(headBranch) {
      const response = await call("/pulls?state=open&head=" + encodeURIComponent(options.owner + ":" + headBranch));
      if (!response.ok) throw new Error("pull lookup failed " + response.status);
      const pulls = (await response.json()) as { number: number; html_url: string; head?: { sha?: string }; draft?: boolean }[];
      return pulls[0] ? toPull(pulls[0]) : undefined;
    },
    async createDraftPull(input) {
      const response = await call("/pulls", {
        method: "POST",
        body: JSON.stringify({ title: input.title, body: input.body, head: input.headBranch, base: input.baseBranch, draft: true })
      });
      if (!response.ok) throw new Error("pull create failed " + response.status);
      return toPull((await response.json()) as { number: number; html_url: string; head?: { sha?: string }; draft?: boolean });
    }
  };
}
