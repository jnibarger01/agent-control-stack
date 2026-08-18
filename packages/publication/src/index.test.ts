import { describe, expect, it, vi } from "vitest";
import { publishValidatedAttempt, type PublicationRecord } from "./index.js";

type GitResult = { stdout: string; stderr: string; exitCode: number };
type GitRunner = (args: string[]) => Promise<GitResult>;

function defaultGitRunner(): GitRunner {
  return vi.fn(async (args: string[]): Promise<GitResult> => {
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
    validationPassed: true,
    leaseIsCurrent: vi.fn(async () => true),
    gitRunner: defaultGitRunner(),
    ...overrides
  };
}

function memoryStore() {
  const records = new Map<string, PublicationRecord>();
  return { getByIdempotency: (key: string) => records.get(key), record: (record: PublicationRecord) => { records.set(record.idempotencyKey, record); return record; } };
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
    await expect(publishValidatedAttempt(input({ leaseIsCurrent: vi.fn(async () => false) }), { getByIdempotency: () => undefined, record: (record) => record }, github)).rejects.toThrow("current lease");
    expect(github.createOrUpdate).not.toHaveBeenCalled();
  });

  it("refuses invalid validation", async () => {
    await expect(publishValidatedAttempt(input({ validationPassed: false }), { getByIdempotency: () => undefined, record: (record) => record }, { createOrUpdate: vi.fn() })).rejects.toThrow("validation");
  });

  it("refuses a branch not owned by the attempt, before touching git", async () => {
    const runner = defaultGitRunner();
    const github = { createOrUpdate: vi.fn() };
    await expect(
      publishValidatedAttempt(input({ branch: "acs/attempt/someone-else", gitRunner: runner }), { getByIdempotency: () => undefined, record: (record) => record }, github)
    ).rejects.toThrow(/not owned by attempt/);
    expect(runner).not.toHaveBeenCalled();
    expect(github.createOrUpdate).not.toHaveBeenCalled();
  });

  it("refuses publication when the workspace has no staged changes after git add", async () => {
    const runner: GitRunner = vi.fn(async (args: string[]): Promise<GitResult> => {
      if (args[0] === "diff" && args.includes("--name-only")) return { stdout: "", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const github = { createOrUpdate: vi.fn() };
    await expect(
      publishValidatedAttempt(input({ gitRunner: runner }), { getByIdempotency: () => undefined, record: (record) => record }, github)
    ).rejects.toThrow(/no staged changes/);
    expect(github.createOrUpdate).not.toHaveBeenCalled();
  });

  it("commits and pushes the real workspace diff before opening the PR (commit/push is not optional)", async () => {
    const calls: string[][] = [];
    const runner: GitRunner = vi.fn(async (args: string[]): Promise<GitResult> => {
      calls.push(args);
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
      if (args[0] === "diff" && args.includes("--name-only")) return { stdout: "src/index.ts\n", stderr: "", exitCode: 0 };
      if (args.includes("commit")) return { stdout: "", stderr: "nothing to commit", exitCode: 1 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const github = { createOrUpdate: vi.fn() };
    await expect(
      publishValidatedAttempt(input({ gitRunner: runner }), { getByIdempotency: () => undefined, record: (record) => record }, github)
    ).rejects.toThrow(/git commit failed/);
    expect(github.createOrUpdate).not.toHaveBeenCalled();
  });

  it("refuses publication when git push fails, without opening a PR", async () => {
    const runner: GitRunner = vi.fn(async (args: string[]): Promise<GitResult> => {
      if (args[0] === "rev-parse") return { stdout: "abc123\n", stderr: "", exitCode: 0 };
      if (args[0] === "diff" && args.includes("--name-only")) return { stdout: "src/index.ts\n", stderr: "", exitCode: 0 };
      if (args[0] === "push") return { stdout: "", stderr: "! [rejected] non-fast-forward", exitCode: 1 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const github = { createOrUpdate: vi.fn() };
    await expect(
      publishValidatedAttempt(input({ gitRunner: runner }), { getByIdempotency: () => undefined, record: (record) => record }, github)
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
      publishValidatedAttempt(input({ gitRunner: runner, leaseIsCurrent }), { getByIdempotency: () => undefined, record: (record) => record }, github)
    ).rejects.toThrow(/lease became stale/);
    expect(github.createOrUpdate).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalledWith(expect.arrayContaining(["push"]));
  });

  it("serializes concurrent callers so only one PR request occurs", async () => {
    const store = memoryStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const github = { createOrUpdate: vi.fn(async () => { release(); return { url: "https://github.com/acme/repo/pull/3" }; }) };
    const first = publishValidatedAttempt(input({ gitRunner: async (args) => { if (args[0] === "status") await gate; return args[0] === "rev-parse" ? { stdout: "abc123\n", stderr: "", exitCode: 0 } : { stdout: "src/index.ts\n", stderr: "", exitCode: 0 }; } }), store, github);
    const second = publishValidatedAttempt(input(), store, github);
    release();
    const records = await Promise.all([first, second]);
    expect(records[0]).toEqual(records[1]);
    expect(github.createOrUpdate).toHaveBeenCalledTimes(1);
  });
});
