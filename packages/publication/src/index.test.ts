import { describe, expect, it, vi } from "vitest";
import { publishValidatedAttempt, type PublicationRecord, type PublicationStore } from "./index.js";

type GitResult = { stdout: string; stderr: string; exitCode: number };
type GitRunner = (args: string[]) => Promise<GitResult>;

function defaultGitRunner(branch = "acs/attempt/attempt-1"): GitRunner {
  return vi.fn(async (args: string[]): Promise<GitResult> => {
    if (args[0] === "symbolic-ref") return { stdout: `${branch}\n`, stderr: "", exitCode: 0 };
    if (args[0] === "rev-parse") return { stdout: "abc123\n", stderr: "", exitCode: 0 };
    if (args[0] === "diff" && args.includes("--name-only")) return { stdout: "src/index.ts\n", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 0 };
  });
}

function input(overrides: Partial<Parameters<typeof publishValidatedAttempt>[0]> = {}) {
  return {
    workItemId: "work-1",
    attemptId: "attempt-1",
    workspacePath: "/workspace",
    branch: "acs/attempt/attempt-1",
    title: "Fix",
    body: "Evidence",
    leaseIsCurrent: vi.fn(async () => true),
    gitRunner: defaultGitRunner(),
    ...overrides
  };
}

function testStore(overrides: Partial<PublicationStore> = {}): PublicationStore {
  return {
    getByIdempotency: () => undefined,
    record: (record: PublicationRecord) => record,
    getValidationRunForAttempt: () => ({ passed: true }),
    planAllowsPush: () => true,
    ...overrides
  };
}

function memoryStore(): PublicationStore {
  const records = new Map<string, PublicationRecord>();
  return testStore({
    getByIdempotency: (key: string) => records.get(key),
    record: (record: PublicationRecord) => {
      records.set(record.idempotencyKey, record);
      return record;
    }
  });
}

describe("publishValidatedAttempt", () => {
  it("creates one PR and replays idempotently", async () => {
    const store = memoryStore();
    const github = { createOrUpdate: vi.fn(async () => ({ url: "https://github.com/acme/repo/pull/1" })) };
    const first = await publishValidatedAttempt(input(), store, github);
    const second = await publishValidatedAttempt(input(), store, github);
    expect(second).toEqual(first);
    expect(github.createOrUpdate).toHaveBeenCalledTimes(1);
  });

  it("refuses stale lease before any external publication", async () => {
    const github = { createOrUpdate: vi.fn() };
    await expect(publishValidatedAttempt(input({ leaseIsCurrent: vi.fn(async () => false) }), testStore(), github)).rejects.toThrow("current lease");
    expect(github.createOrUpdate).not.toHaveBeenCalled();
  });

  it("refuses when there is no persisted passing validation for the attempt", async () => {
    const github = { createOrUpdate: vi.fn() };
    await expect(
      publishValidatedAttempt(input(), testStore({ getValidationRunForAttempt: () => undefined }), github)
    ).rejects.toThrow(/persisted, independently-run passing validation/);
    expect(github.createOrUpdate).not.toHaveBeenCalled();
  });

  it("refuses a self-reported validation success that the store never actually persisted", async () => {
    const github = { createOrUpdate: vi.fn() };
    await expect(
      publishValidatedAttempt(input(), testStore({ getValidationRunForAttempt: () => ({ passed: false }) }), github)
    ).rejects.toThrow(/persisted, independently-run passing validation/);
    expect(github.createOrUpdate).not.toHaveBeenCalled();
  });

  it("refuses to push when the work item's current execution plan does not authorize a push", async () => {
    const runner = defaultGitRunner();
    const github = { createOrUpdate: vi.fn() };
    await expect(
      publishValidatedAttempt(input({ gitRunner: runner }), testStore({ planAllowsPush: () => false }), github)
    ).rejects.toThrow(/does not authorize a push/);
    expect(github.createOrUpdate).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalledWith(expect.arrayContaining(["push"]));
  });

  it("refuses a branch not owned by the attempt, before touching git", async () => {
    const runner = defaultGitRunner();
    const github = { createOrUpdate: vi.fn() };
    await expect(
      publishValidatedAttempt(input({ branch: "acs/attempt/someone-else", gitRunner: runner }), testStore(), github)
    ).rejects.toThrow(/not owned by attempt/);
    expect(runner).not.toHaveBeenCalled();
    expect(github.createOrUpdate).not.toHaveBeenCalled();
  });

  it("refuses when the workspace HEAD is detached, even though the caller-supplied branch matches", async () => {
    const runner: GitRunner = vi.fn(async (args: string[]): Promise<GitResult> => {
      if (args[0] === "symbolic-ref") return { stdout: "", stderr: "fatal: ref HEAD is not a symbolic ref", exitCode: 1 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const github = { createOrUpdate: vi.fn() };
    await expect(
      publishValidatedAttempt(input({ gitRunner: runner }), testStore(), github)
    ).rejects.toThrow(/HEAD is detached/);
    expect(github.createOrUpdate).not.toHaveBeenCalled();
  });

  it("refuses when the workspace is actually checked out on a different branch than the attempt claims", async () => {
    const runner = defaultGitRunner("some-other-branch");
    const github = { createOrUpdate: vi.fn() };
    await expect(
      publishValidatedAttempt(input({ gitRunner: runner }), testStore(), github)
    ).rejects.toThrow(/is actually on branch "some-other-branch"/);
    expect(github.createOrUpdate).not.toHaveBeenCalled();
  });

  it("refuses publication when the workspace has no staged changes after git add", async () => {
    const runner: GitRunner = vi.fn(async (args: string[]): Promise<GitResult> => {
      if (args[0] === "symbolic-ref") return { stdout: "acs/attempt/attempt-1\n", stderr: "", exitCode: 0 };
      if (args[0] === "diff" && args.includes("--name-only")) return { stdout: "", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const github = { createOrUpdate: vi.fn() };
    await expect(
      publishValidatedAttempt(input({ gitRunner: runner }), testStore(), github)
    ).rejects.toThrow(/no staged changes/);
    expect(github.createOrUpdate).not.toHaveBeenCalled();
  });

  it("commits and pushes the real workspace diff before opening the PR (commit/push is not optional)", async () => {
    const calls: string[][] = [];
    const runner: GitRunner = vi.fn(async (args: string[]): Promise<GitResult> => {
      calls.push(args);
      if (args[0] === "symbolic-ref") return { stdout: "acs/attempt/attempt-1\n", stderr: "", exitCode: 0 };
      if (args[0] === "rev-parse") return { stdout: "real-sha-789\n", stderr: "", exitCode: 0 };
      if (args[0] === "diff" && args.includes("--name-only")) return { stdout: "src/index.ts\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const store = memoryStore();
    const github = { createOrUpdate: vi.fn(async () => ({ url: "https://github.com/acme/repo/pull/2" })) };
    const record = await publishValidatedAttempt(input({ gitRunner: runner, branch: "acs/attempt/attempt-1" }), store, github);

    expect(calls.some((call) => call[0] === "add" && call.includes("-A"))).toBe(true);
    expect(calls.some((call) => call.includes("commit") && call.includes("-m"))).toBe(true);
    expect(calls.some((call) => call[0] === "push" && call.includes("HEAD:refs/heads/acs/attempt/attempt-1"))).toBe(true);
    expect(record.commitSha).toBe("real-sha-789");
    expect(github.createOrUpdate).toHaveBeenCalledWith(expect.objectContaining({ commitSha: "real-sha-789", branch: "acs/attempt/attempt-1" }));

    // push must be issued strictly after the commit, and the PR must be opened strictly after the push.
    const commitIndex = calls.findIndex((call) => call.includes("commit"));
    const pushIndex = calls.findIndex((call) => call[0] === "push");
    expect(commitIndex).toBeGreaterThanOrEqual(0);
    expect(pushIndex).toBeGreaterThan(commitIndex);
  });

  it("refuses publication when git commit fails", async () => {
    const runner: GitRunner = vi.fn(async (args: string[]): Promise<GitResult> => {
      if (args[0] === "symbolic-ref") return { stdout: "acs/attempt/attempt-1\n", stderr: "", exitCode: 0 };
      if (args[0] === "diff" && args.includes("--name-only")) return { stdout: "src/index.ts\n", stderr: "", exitCode: 0 };
      if (args.includes("commit")) return { stdout: "", stderr: "nothing to commit", exitCode: 1 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const github = { createOrUpdate: vi.fn() };
    await expect(
      publishValidatedAttempt(input({ gitRunner: runner }), testStore(), github)
    ).rejects.toThrow(/git commit failed/);
    expect(github.createOrUpdate).not.toHaveBeenCalled();
  });

  it("refuses publication when git push fails, without opening a PR", async () => {
    const runner: GitRunner = vi.fn(async (args: string[]): Promise<GitResult> => {
      if (args[0] === "symbolic-ref") return { stdout: "acs/attempt/attempt-1\n", stderr: "", exitCode: 0 };
      if (args[0] === "rev-parse") return { stdout: "abc123\n", stderr: "", exitCode: 0 };
      if (args[0] === "diff" && args.includes("--name-only")) return { stdout: "src/index.ts\n", stderr: "", exitCode: 0 };
      if (args[0] === "push") return { stdout: "", stderr: "! [rejected] non-fast-forward", exitCode: 1 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const github = { createOrUpdate: vi.fn() };
    await expect(
      publishValidatedAttempt(input({ gitRunner: runner }), testStore(), github)
    ).rejects.toThrow(/git push failed/);
    expect(github.createOrUpdate).not.toHaveBeenCalled();
  });

  it("re-checks the lease immediately before pushing and refuses if it went stale, without pushing", async () => {
    const runner = defaultGitRunner();
    let leaseCalls = 0;
    const leaseIsCurrent = vi.fn(async () => {
      leaseCalls += 1;
      // current for the first (entry) check, stale by the pre-push recheck.
      return leaseCalls <= 1;
    });
    const github = { createOrUpdate: vi.fn() };
    await expect(
      publishValidatedAttempt(input({ gitRunner: runner, leaseIsCurrent }), testStore(), github)
    ).rejects.toThrow(/lease became stale/);
    expect(github.createOrUpdate).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalledWith(expect.arrayContaining(["push"]));
  });

  it("re-checks the lease after the push has already landed and refuses to open the PR if it went stale", async () => {
    const runner = defaultGitRunner();
    let leaseCalls = 0;
    const leaseIsCurrent = vi.fn(async () => {
      leaseCalls += 1;
      // current for entry and the pre-push check, stale by the post-push recheck.
      return leaseCalls <= 2;
    });
    const github = { createOrUpdate: vi.fn(async () => ({ url: "https://github.com/acme/repo/pull/9" })) };
    await expect(
      publishValidatedAttempt(input({ gitRunner: runner, leaseIsCurrent }), testStore(), github)
    ).rejects.toThrow(/lease became stale after publication push/);
    // The push itself is irreversible and did happen; what must not happen is the PR.
    expect(runner).toHaveBeenCalledWith(expect.arrayContaining(["push"]));
    expect(github.createOrUpdate).not.toHaveBeenCalled();
  });

  it("re-checks the lease after PR creation and refuses to persist the publication record if it went stale", async () => {
    const runner = defaultGitRunner();
    let leaseCalls = 0;
    const leaseIsCurrent = vi.fn(async () => {
      leaseCalls += 1;
      // current through PR creation, stale only by the final recheck.
      return leaseCalls <= 3;
    });
    const github = { createOrUpdate: vi.fn(async () => ({ url: "https://github.com/acme/repo/pull/9" })) };
    const record = vi.fn((r: PublicationRecord) => r);
    await expect(
      publishValidatedAttempt(input({ gitRunner: runner, leaseIsCurrent }), testStore({ record }), github)
    ).rejects.toThrow(/lease became stale after PR creation/);
    expect(github.createOrUpdate).toHaveBeenCalledTimes(1);
    expect(record).not.toHaveBeenCalled();
  });

  it("serializes concurrent callers so only one PR request occurs", async () => {
    const store = memoryStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const github = { createOrUpdate: vi.fn(async () => { release(); return { url: "https://github.com/acme/repo/pull/3" }; }) };
    const first = publishValidatedAttempt(input({ gitRunner: async (args) => { if (args[0] === "status") await gate; if (args[0] === "symbolic-ref") return { stdout: "acs/attempt/attempt-1\n", stderr: "", exitCode: 0 }; return args[0] === "rev-parse" ? { stdout: "abc123\n", stderr: "", exitCode: 0 } : { stdout: "src/index.ts\n", stderr: "", exitCode: 0 }; } }), store, github);
    const second = publishValidatedAttempt(input(), store, github);
    release();
    const records = await Promise.all([first, second]);
    expect(records[0]).toEqual(records[1]);
    expect(github.createOrUpdate).toHaveBeenCalledTimes(1);
  });
});
