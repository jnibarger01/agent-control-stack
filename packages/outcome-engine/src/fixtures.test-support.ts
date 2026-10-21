import type { PullRequestSnapshot, PullRequestReader } from "@agent-control-stack/integration-manager";

export const HEAD = "a".repeat(40);
export const BASE = "b".repeat(40);

export function makeSnapshot(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return {
    number: 7,
    title: "feat: thing",
    author: "someone",
    state: "OPEN",
    isDraft: false,
    isCrossRepository: false,
    headRef: "feat/thing",
    headSha: HEAD,
    baseRef: "main",
    baseRefOid: BASE,
    checksCommitSha: HEAD,
    mergeable: "MERGEABLE",
    reviewDecision: null,
    unresolvedThreads: 0,
    checks: [
      { name: "check", status: "COMPLETED", conclusion: "SUCCESS", appSlug: "github-actions", source: "check_run" }
    ],
    changedFiles: ["packages/x/src/a.ts"],
    truncated: { threads: false, checks: false, files: false },
    ...overrides
  };
}

/** A reader that serves the given snapshots in order, repeating the last one. */
export function sequenceReader(
  ...snapshots: Array<PullRequestSnapshot | Error>
): PullRequestReader & { calls: number } {
  const reader = {
    calls: 0,
    async getPullRequest() {
      const next = snapshots[Math.min(reader.calls, snapshots.length - 1)] as PullRequestSnapshot | Error;
      reader.calls += 1;
      if (next instanceof Error) throw next;
      return next;
    }
  };
  return reader;
}
