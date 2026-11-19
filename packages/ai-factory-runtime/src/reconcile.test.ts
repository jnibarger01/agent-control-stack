import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CodingMissionStore } from "@agent-control-stack/coding-mission";
import { FACTORY_DRAFT_PR_SIDE_EFFECT, factoryPublicationIdempotencyKey, publishFactoryDraft } from "./publish.js";
import { createFactoryGitReader } from "./verify.js";
import {
  cancelFactoryMission,
  createFileAttemptRegistry,
  processIdentity,
  reconcileFactoryOnBoot,
  reconcileFactoryPublication,
  revokeFactoryAttempt,
  signalIfSameProcess
} from "./reconcile.js";
// @ts-expect-error -- plain ESM test fixture without type declarations
import { createFileRemote } from "./__fixtures__/crash-publish.mjs";

const FIXTURES = fileURLToPath(new URL("./__fixtures__/", import.meta.url));
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const gitEnv = { PATH: "/usr/bin:/bin", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...gitEnv, HOME: cwd } }).trim();
const MISSION = "factory-" + "c".repeat(48);

function world(options: { verified?: boolean } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "acs-factory-f9-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const repoDir = join(dir, "repo");
  mkdirSync(repoDir);
  git(repoDir, "init", "-q", "-b", "main");
  writeFileSync(join(repoDir, "a.txt"), "a\n");
  git(repoDir, "add", ".");
  git(repoDir, "commit", "-q", "-m", "base");
  const base = git(repoDir, "rev-parse", "HEAD");
  writeFileSync(join(repoDir, "a.txt"), "b\n");
  git(repoDir, "commit", "-qam", "change");
  const head = git(repoDir, "rev-parse", "HEAD");
  const tree = git(repoDir, "rev-parse", "HEAD^{tree}");
  const dbPath = join(dir, "control.db");
  const store = new CodingMissionStore(dbPath);
  const now = new Date().toISOString();
  store.create({
    missionId: MISSION,
    repository: "jnibarger01/agent-control-stack",
    baseRef: base,
    baseSha: base,
    summary: "acs.ai-factory.v1 order=o intent=" + "d".repeat(64),
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
    store.completeOperation(MISSION, "u1", "t1", { resultHash: "9".repeat(64), files: ["a.txt"] }, now);
  }
  store.close();
  const remoteFile = join(dir, "remote.json");
  writeFileSync(remoteFile, JSON.stringify({ branches: { main: base }, pulls: [], creates: 0 }));
  const approval = {
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
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    revoked: false
  };
  const input = { missionId: MISSION, approvalId: "appr-1", operatorId: "operator-1", targetBranch: "main", title: "Factory change" };
  const remoteState = () => JSON.parse(readFileSync(remoteFile, "utf8")) as { branches: Record<string, string>; pulls: unknown[]; creates: number };
  return { dir, repoDir, dbPath, remoteFile, approval, input, head, remoteState };
}

/** Run the real publisher in a child process that SIGKILLs itself at `checkpoint`. */
function crashAt(w: ReturnType<typeof world>, checkpoint: string) {
  const result = spawnSync(
    process.execPath,
    [join(FIXTURES, "crash-publish.mjs"), w.dbPath, w.repoDir, w.remoteFile, checkpoint, JSON.stringify(w.approval), JSON.stringify(w.input)],
    { encoding: "utf8", timeout: 30_000 }
  );
  return result.signal;
}

/** "Restart": a fresh store handle in this process against the same database file. */
async function restartAndPublish(w: ReturnType<typeof world>) {
  const store = new CodingMissionStore(w.dbPath);
  try {
    return await publishFactoryDraft(
      { store, approvals: { get: () => w.approval as never }, remote: createFileRemote(w.remoteFile), git: createFactoryGitReader(w.repoDir) },
      w.input
    );
  } finally {
    store.close();
  }
}

describe("F9 kill -9 at every publication crash window, restart across the process boundary", () => {
  it("after the PR was created but before it was recorded: restart reconciles to the same PR (no duplicate)", async () => {
    const w = world();
    expect(crashAt(w, "after_create")).toBe("SIGKILL");
    expect(w.remoteState().creates).toBe(1);
    expect(await restartAndPublish(w)).toMatchObject({ status: "published", replayed: true });
    expect(await restartAndPublish(w)).toMatchObject({ status: "published", replayed: true });
    expect(w.remoteState().creates).toBe(1);
  });

  it("after reserving but before any push: restart stays uncertain, reconciliation proves no side effect, then one PR", async () => {
    const w = world();
    expect(crashAt(w, "branchHead")).toBe("SIGKILL");
    expect(await restartAndPublish(w)).toEqual({ status: "uncertain", reason: "reconcile_pull_not_found" });
    const store = new CodingMissionStore(w.dbPath);
    try {
      expect(await reconcileFactoryPublication({ store, remote: createFileRemote(w.remoteFile) }, { missionId: MISSION, expectedHead: w.head })).toEqual({
        status: "cleared_no_side_effect"
      });
    } finally {
      store.close();
    }
    expect(await restartAndPublish(w)).toMatchObject({ status: "published", replayed: false });
    expect(w.remoteState().creates).toBe(1);
  });

  it("after pushing the branch but before the PR: stays uncertain for an operator, never a blind create", async () => {
    const w = world();
    expect(crashAt(w, "after_push")).toBe("SIGKILL");
    expect((await restartAndPublish(w)).status).toBe("uncertain");
    const store = new CodingMissionStore(w.dbPath);
    try {
      expect(await reconcileFactoryPublication({ store, remote: createFileRemote(w.remoteFile) }, { missionId: MISSION, expectedHead: w.head })).toEqual({
        status: "uncertain",
        reason: "branch_pushed_without_open_pull"
      });
    } finally {
      store.close();
    }
    expect(w.remoteState().creates).toBe(0);
  });
});

describe("F9 attempt orphaning, identity-checked kill, revocation and cancellation", () => {
  it("reconciles an attempt orphaned by an ACS kill -9: kills the recorded process, marks the unit unknown, refuses blind retry", async () => {
    const w = world({ verified: false });
    const registryPath = join(w.dir, "attempts.json");
    const ready = join(w.dir, "ready.json");
    const acs = spawn(process.execPath, [join(FIXTURES, "crash-attempt.mjs"), w.dbPath, registryPath, MISSION, "u1", ready], { stdio: "ignore" });
    for (let i = 0; i < 100 && !existsSync(ready); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    const { pid } = JSON.parse(readFileSync(ready, "utf8")) as { pid: number };
    acs.kill("SIGKILL");
    await new Promise((resolve) => acs.once("exit", resolve));
    expect(processIdentity(pid)).toBeDefined();

    const store = new CodingMissionStore(w.dbPath);
    cleanups.push(() => store.close());
    const report = await reconcileFactoryOnBoot({ store, registry: createFileAttemptRegistry(registryPath), missionIds: [MISSION] });
    expect(report.killed).toEqual([{ missionId: MISSION, unitId: "u1", outcome: "signalled" }]);
    expect(report.markedUnknown).toEqual([{ missionId: MISSION, unitId: "u1" }]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(processIdentity(pid)).toBeUndefined();
    expect(store.workUnitClaim(MISSION, "u1")?.status).toBe("unknown");
    expect(store.retryUnit(MISSION, "u1", new Date().toISOString())).toMatchObject({ ok: false, outcome: "retry_unsafe" });
    expect(createFileAttemptRegistry(registryPath).list()).toEqual([]);
  });

  it("never signals a recycled pid: identity must match pid and kernel start time", async () => {
    const child = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    cleanups.push(() => child.kill("SIGKILL"));
    const identity = processIdentity(child.pid!)!;
    expect(signalIfSameProcess({ ...identity, startTicks: String(Number(identity.startTicks) + 1) })).toBe("identity_mismatch");
    expect(processIdentity(child.pid!)).toBeDefined();
    expect(signalIfSameProcess(identity)).toBe("signalled");
    await new Promise((resolve) => child.once("exit", resolve));
    expect(signalIfSameProcess(identity)).toBe("gone");
  });

  it("revocation moves the fence before killing, so a late result is fenced and nothing is replayed", () => {
    const w = world({ verified: false });
    const store = new CodingMissionStore(w.dbPath);
    cleanups.push(() => store.close());
    const registry = createFileAttemptRegistry(join(w.dir, "attempts.json"));
    store.claimUnit(MISSION, "u1", { token: "live", workerId: "w", route: {}, claimedAt: new Date().toISOString() });
    const child = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    cleanups.push(() => child.kill("SIGKILL"));
    registry.put({ missionId: MISSION, unitId: "u1", claimToken: "live", process: processIdentity(child.pid!)!, startedAt: new Date().toISOString() });
    expect(revokeFactoryAttempt({ store, registry }, { missionId: MISSION, unitId: "u1", claimToken: "stale" })).toEqual({ fenceMoved: false, process: "none" });
    expect(revokeFactoryAttempt({ store, registry }, { missionId: MISSION, unitId: "u1", claimToken: "live" })).toEqual({ fenceMoved: true, process: "signalled" });
    expect(store.workUnitClaim(MISSION, "u1")?.status).toBe("unknown");
    // The factory fence (dispatch F6 and verification F7) requires status "running", so the old
    // claim is no longer current. Note: the store's own completeOperation still accepts an `unknown`
    // unit under its claim token (existing reconciliation semantics); the factory never calls it there.
    const claim = store.workUnitClaim(MISSION, "u1");
    expect(claim?.claimToken).toBe("live");
    expect(claim?.status === "running").toBe(false);
  });

  it("a late verification for a revoked attempt is fenced as stale and changes nothing", async () => {
    const w = world({ verified: false });
    const store = new CodingMissionStore(w.dbPath);
    cleanups.push(() => store.close());
    store.claimUnit(MISSION, "u1", { token: "live", workerId: "w", route: {}, claimedAt: new Date().toISOString() });
    revokeFactoryAttempt({ store, registry: createFileAttemptRegistry(join(w.dir, "attempts.json")) }, { missionId: MISSION, unitId: "u1", claimToken: "live" });
    const { verifyFactoryResult } = await import("./verify.js");
    const result = await verifyFactoryResult(
      {
        store,
        git: createFactoryGitReader(w.repoDir),
        runner: { run: async () => ({ exitCode: 0, output: "" }) },
        verifier: { id: "claude-verifier", verify: async () => ({ verdict: "PASS", summary: "" }) }
      },
      { missionId: MISSION, unitId: "u1", claimToken: "live", intent: {}, unitPaths: ["a.txt"], acceptanceCommands: [["true"]], envelope: {} as never, evidence: {} as never }
    );
    expect(result).toEqual({ status: "stale", reason: "claim_not_current" });
    expect(store.workUnitClaim(MISSION, "u1")?.status).toBe("unknown");
  });

  it("cancellation reports uncertain in-flight work and a published PR, and never claims a rollback", async () => {
    const w = world();
    const store = new CodingMissionStore(w.dbPath);
    cleanups.push(() => store.close());
    const published = await publishFactoryDraft(
      { store, approvals: { get: () => w.approval as never }, remote: createFileRemote(w.remoteFile), git: createFactoryGitReader(w.repoDir) },
      w.input
    );
    expect(published.status).toBe("published");
    store.addWorkUnits(MISSION, [{ unitId: "u2", kind: "coding", title: "unit two", verificationPolicy: "none" }], new Date().toISOString());
    store.claimUnit(MISSION, "u2", { token: "t2", workerId: "w", route: {}, claimedAt: new Date().toISOString() });
    const report = cancelFactoryMission({ store, registry: createFileAttemptRegistry(join(w.dir, "attempts.json")) }, { missionId: MISSION, reason: "operator_cancelled", now: new Date().toISOString() });
    expect(report).toMatchObject({ uncertainUnits: ["u2"], publication: "published_not_rolled_back", rollbackClaimed: false });
  });
});

describe("F9 regression: reconciled publication replays as the same PR", () => {
  it("a PR recorded by reconciliation is recognised by the publisher's next replay", async () => {
    const w = world();
    expect(crashAt(w, "after_create")).toBe("SIGKILL");
    const store = new CodingMissionStore(w.dbPath);
    try {
      expect(await reconcileFactoryPublication({ store, remote: createFileRemote(w.remoteFile) }, { missionId: MISSION, expectedHead: w.head })).toMatchObject({
        status: "reconciled_published"
      });
    } finally {
      store.close();
    }
    expect(await restartAndPublish(w)).toMatchObject({ status: "published", replayed: true });
    expect(w.remoteState().creates).toBe(1);
  });
});
