import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodingMissionStore } from "@agent-control-stack/coding-mission";
import { createFactoryGitReader } from "./verify.js";
import {
  FACTORY_DRAFT_PR_SIDE_EFFECT,
  createGitHubFactoryRemote,
  factoryPublicationIdempotencyKey,
  publishFactoryDraft,
  type FactoryPublicationApproval,
  type FactoryPullRequest,
  type FactoryRemote
} from "./publish.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const gitEnv = { PATH: "/usr/bin:/bin", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...gitEnv, HOME: cwd } }).trim();
const MISSION = "factory-" + "b".repeat(48);

function setup(options: { verified?: boolean } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "acs-factory-pub-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q", "-b", "main");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/a.ts"), "a\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
  const base = git(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "src/a.ts"), "b\n");
  git(dir, "commit", "-qam", "change");
  const head = git(dir, "rev-parse", "HEAD");
  const tree = git(dir, "rev-parse", "HEAD^{tree}");
  const store = new CodingMissionStore(join(dir, ".control.db"));
  cleanups.push(() => store.close());
  const now = new Date().toISOString();
  store.create({
    missionId: MISSION,
    repository: "jnibarger01/agent-control-stack",
    baseRef: base,
    baseSha: base,
    summary: "acs.ai-factory.v1 order=o intent=" + "c".repeat(64),
    branch: "acs/mission/" + MISSION,
    deploymentRequired: false,
    deploymentAction: "none",
    deploymentImpact: "Draft pull request only.",
    now,
    initiatorId: "alice"
  });
  store.addWorkUnits(MISSION, [{ unitId: "u1", kind: "coding", title: "unit one", verificationPolicy: "none" }], now);
  if (options.verified !== false) {
    store.claimUnit(MISSION, "u1", { token: "t1", workerId: "w", route: {}, claimedAt: now });
    store.completeOperation(MISSION, "u1", "t1", { resultHash: "9".repeat(64), files: ["src/a.ts"] }, now);
  }
  const approval: FactoryPublicationApproval = {
    approvalId: "appr-1",
    approverId: "operator-1",
    approverKind: "human",
    missionId: MISSION,
    repository: "jnibarger01/agent-control-stack",
    targetBranch: "main",
    headSha: head,
    treeSha: tree,
    sideEffect: FACTORY_DRAFT_PR_SIDE_EFFECT,
    idempotencyKey: factoryPublicationIdempotencyKey(MISSION, head),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    revoked: false
  };
  return { dir, base, head, tree, store, approval, git: createFactoryGitReader(dir) };
}

function fakeRemote(base: string, options: { failCreate?: boolean; createdDespiteError?: boolean } = {}) {
  const calls: string[] = [];
  const pulls: FactoryPullRequest[] = [];
  const branches = new Map<string, string>([["main", base]]);
  const remote: FactoryRemote = {
    async branchHead(branch) {
      calls.push("branchHead:" + branch);
      return branches.get(branch);
    },
    async pushFactoryBranch(branch, sha) {
      calls.push("push:" + branch);
      if (branches.has(branch) && branches.get(branch) !== sha) throw new Error("non-fast-forward");
      branches.set(branch, sha);
    },
    async findOpenPull(head) {
      calls.push("find:" + head);
      return pulls.find((pull) => pull.url.endsWith(head));
    },
    async createDraftPull(input) {
      calls.push("create:" + input.headBranch);
      const pull = { number: pulls.length + 1, url: "https://github.test/pull/" + input.headBranch, headSha: branches.get(input.headBranch)!, draft: true, body: input.body } as FactoryPullRequest & { body: string };
      if (options.failCreate) {
        if (options.createdDespiteError) pulls.push(pull);
        throw new Error("rate_limited_or_forbidden_429");
      }
      pulls.push(pull);
      return pull;
    }
  };
  return { remote, calls, pulls, branches };
}

const input = { missionId: MISSION, approvalId: "appr-1", operatorId: "operator-1", targetBranch: "main", title: "Factory change" };

describe("F8 authorized, idempotent draft PR publication", () => {
  it("opens exactly one draft PR with provenance, attested checks and rollback, and replays it", async () => {
    const ctx = setup();
    const fake = fakeRemote(ctx.base);
    const deps = { store: ctx.store, approvals: { get: () => ctx.approval }, remote: fake.remote, git: ctx.git };
    const first = await publishFactoryDraft(deps, input);
    expect(first).toMatchObject({ status: "published", replayed: false, pullRequest: { draft: true, headSha: ctx.head } });
    const second = await publishFactoryDraft(deps, input);
    expect(second).toMatchObject({ status: "published", replayed: true });
    expect(fake.calls.filter((call) => call.startsWith("create:"))).toHaveLength(1);
    const body = (fake.pulls[0] as FactoryPullRequest & { body: string }).body;
    expect(body).toContain(ctx.head);
    expect(body).toContain("9".repeat(64));
    expect(body).toContain("## Rollback");
    expect(body).toContain("appr-1");
  });

  it.each([
    ["no approval", () => undefined, "approval_missing_or_revoked"],
    ["a revoked approval", (a: FactoryPublicationApproval) => ({ ...a, revoked: true }), "approval_missing_or_revoked"],
    ["an expired approval", (a: FactoryPublicationApproval) => ({ ...a, expiresAt: new Date(Date.now() - 1).toISOString() }), "approval_expired"],
    ["an agent approval", (a: FactoryPublicationApproval) => ({ ...a, approverKind: "agent" as const }), "approval_not_human"],
    ["another operator's approval", (a: FactoryPublicationApproval) => ({ ...a, approverId: "mallory" }), "approval_operator_mismatch"],
    ["a merge side effect", (a: FactoryPublicationApproval) => ({ ...a, sideEffect: "merge" }), "approval_binding_mismatch"],
    ["another head", (a: FactoryPublicationApproval) => ({ ...a, headSha: "f".repeat(40) }), "approval_binding_mismatch"],
    ["another tree", (a: FactoryPublicationApproval) => ({ ...a, treeSha: "f".repeat(40) }), "approval_binding_mismatch"],
    ["another repository", (a: FactoryPublicationApproval) => ({ ...a, repository: "evil/repo" }), "approval_binding_mismatch"],
    ["another target", (a: FactoryPublicationApproval) => ({ ...a, targetBranch: "release" }), "approval_binding_mismatch"]
  ])("refuses %s without touching the remote", async (_label, mutate, reason) => {
    const ctx = setup();
    const fake = fakeRemote(ctx.base);
    const result = await publishFactoryDraft(
      { store: ctx.store, approvals: { get: () => mutate(ctx.approval) as FactoryPublicationApproval | undefined }, remote: fake.remote, git: ctx.git },
      input
    );
    expect(result).toEqual({ status: "refused", reason });
    expect(fake.calls).toEqual([]);
  });

  it("refuses an unverified mission", async () => {
    const ctx = setup({ verified: false });
    const fake = fakeRemote(ctx.base);
    expect(await publishFactoryDraft({ store: ctx.store, approvals: { get: () => ctx.approval }, remote: fake.remote, git: ctx.git }, input)).toEqual({
      status: "refused",
      reason: "mission_not_verified"
    });
  });

  it("refuses when the target advanced, and when the workspace changed after approval", async () => {
    const ctx = setup();
    const fake = fakeRemote(ctx.base);
    fake.branches.set("main", "e".repeat(40));
    expect(await publishFactoryDraft({ store: ctx.store, approvals: { get: () => ctx.approval }, remote: fake.remote, git: ctx.git }, input)).toEqual({
      status: "conflict",
      reason: "target_advanced"
    });
    expect(fake.calls.some((call) => call.startsWith("push:"))).toBe(false);
    // Nothing external happened, so the reservation is released: once the target is back, it publishes.
    expect(ctx.store.effect(MISSION, "factory_draft_pull_request")).toBeUndefined();
    fake.branches.set("main", ctx.base);
    expect(
      (await publishFactoryDraft({ store: ctx.store, approvals: { get: () => ctx.approval }, remote: fake.remote, git: ctx.git }, input)).status
    ).toBe("published");

    const moved = setup();
    writeFileSync(join(moved.dir, "src/a.ts"), "c\n");
    git(moved.dir, "commit", "-qam", "late change");
    const fake2 = fakeRemote(moved.base);
    expect(await publishFactoryDraft({ store: moved.store, approvals: { get: () => moved.approval }, remote: fake2.remote, git: moved.git }, input)).toEqual({
      status: "refused",
      reason: "approval_binding_mismatch"
    });
  });

  it("leaves a recoverable uncertain state on a rate limit and reconciles by lookup, never a second create", async () => {
    const ctx = setup();
    const failing = fakeRemote(ctx.base, { failCreate: true, createdDespiteError: true });
    const deps = { store: ctx.store, approvals: { get: () => ctx.approval }, remote: failing.remote, git: ctx.git };
    const first = await publishFactoryDraft(deps, input);
    expect(first).toMatchObject({ status: "uncertain" });
    expect(ctx.store.effect(MISSION, "factory_draft_pull_request")?.outcome).toBe("unknown");
    const reconciled = await publishFactoryDraft(deps, input);
    expect(reconciled).toMatchObject({ status: "published", replayed: true });
    expect(failing.calls.filter((call) => call.startsWith("create:"))).toHaveLength(1);

    const lost = setup();
    const neverCreated = fakeRemote(lost.base, { failCreate: true, createdDespiteError: false });
    const lostDeps = { store: lost.store, approvals: { get: () => lost.approval }, remote: neverCreated.remote, git: lost.git };
    expect((await publishFactoryDraft(lostDeps, input)).status).toBe("uncertain");
    expect(await publishFactoryDraft(lostDeps, input)).toEqual({ status: "uncertain", reason: "reconcile_pull_not_found" });
    expect(neverCreated.calls.filter((call) => call.startsWith("create:"))).toHaveLength(1);
  });
});

describe("F8 GitHub remote is draft-only", () => {
  it("creates drafts, refuses non-factory pushes, and surfaces rate limits", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/pulls") && init.method === "POST") {
        return new Response(JSON.stringify({ number: 5, html_url: "https://github.test/pull/5", head: { sha: "a".repeat(40) }, draft: true }), { status: 201 });
      }
      return new Response("[]", { status: 429 });
    }) as typeof fetch;
    const pushes: string[] = [];
    const remote = createGitHubFactoryRemote({
      owner: "o",
      repository: "r",
      tokenSource: () => "tok",
      push: async (branch) => void pushes.push(branch),
      fetchImpl
    });
    const created = await remote.createDraftPull({ headBranch: "acs/factory/x", baseBranch: "main", title: "t", body: "b" });
    expect(created.draft).toBe(true);
    expect(JSON.parse(String(requests[0]!.init.body))).toMatchObject({ draft: true, base: "main", head: "acs/factory/x" });
    await expect(remote.pushFactoryBranch("main", "a".repeat(40))).rejects.toThrow(/acs\/factory/u);
    expect(pushes).toEqual([]);
    await expect(remote.findOpenPull("acs/factory/x")).rejects.toThrow(/rate_limited/u);
    expect(Object.keys(remote).sort()).toEqual(["branchHead", "createDraftPull", "findOpenPull", "pushFactoryBranch"]);
  });
});
