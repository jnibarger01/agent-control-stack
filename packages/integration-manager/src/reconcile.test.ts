import { afterEach, describe, expect, it } from "vitest";
import { createGitRunner } from "./git-simulator.js";
import { reconcile } from "./reconcile.js";
import { Scratch, git, pr } from "./fixtures.test-support.js";
import type { PullRequestSnapshot } from "./types.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
function scratch() {
  const s = new Scratch();
  cleanups.push(() => s.dispose());
  return s;
}
const source = (prs: PullRequestSnapshot[]) => ({ listOpenPullRequests: async () => prs });
const run = (s: Scratch, prs: PullRequestSnapshot[], extra: Record<string, unknown> = {}) =>
  reconcile({
    repository: "example/repo",
    baseRef: "main",
    source: source(prs),
    git: createGitRunner(s.dir),
    mergeMethod: "merge" as const,
    now: () => new Date("2026-10-11T00:00:00.000Z"),
    ...extra
  });
const find = (report: Awaited<ReturnType<typeof run>>, n: number) => report.pullRequests.find((p) => p.number === n)!;

describe("reconcile", () => {
  it("queues independent clean pull requests in number order", async () => {
    const s = scratch();
    const base = s.commit("base", { "a.txt": "a\n", "b.txt": "b\n" });
    const h1 = s.branch("branch-1", base, { "a.txt": "one\n" });
    const h2 = s.branch("branch-2", base, { "b.txt": "two\n" });
    const report = await run(s, [pr({ number: 2, headSha: h2 }), pr({ number: 1, headSha: h1 })]);
    expect(report).toMatchObject({ queue: [1, 2], merged: false, baseSha: base, repository: "example/repo" });
    expect(find(report, 1)).toMatchObject({ wouldMerge: true, queuePosition: 1 });
    expect(find(report, 2)).toMatchObject({ wouldMerge: true, queuePosition: 2 });
  });

  it("revalidates after upstream merges: clean alone, conflicting once the first merges", async () => {
    const s = scratch();
    const base = s.commit("base", { "a.txt": "a\n" });
    const h1 = s.branch("branch-1", base, { "a.txt": "one\n" });
    const h2 = s.branch("branch-2", base, { "a.txt": "two\n" });
    const report = await run(s, [pr({ number: 1, headSha: h1 }), pr({ number: 2, headSha: h2 })]);
    const second = find(report, 2);
    expect(second.standalone).toMatchObject({ evaluated: true, clean: true });
    expect(second.afterUpstream).toMatchObject({ evaluated: true, clean: false, conflicts: ["a.txt"] });
    expect(second.wouldMerge).toBe(false);
    expect(second.reasons.join("\n")).toMatch(/conflicts once #1 merges: a\.txt/);
    expect(report.queue).toEqual([1]);
  });

  it("reports a pull request that conflicts with the base itself", async () => {
    const s = scratch();
    const base = s.commit("base", { "a.txt": "a\n" });
    const h1 = s.branch("branch-1", base, { "a.txt": "feature\n" });
    s.advanceMain({ "a.txt": "main moved\n" });
    const report = await run(s, [pr({ number: 1, headSha: h1 })]);
    expect(find(report, 1)).toMatchObject({ wouldMerge: false });
    expect(find(report, 1).reasons.join("\n")).toMatch(/conflicts with main: a\.txt/);
    expect(find(report, 1).reasons.join("\n")).toMatch(/stale_base: behind main by 1 commit/);
  });

  it("reports a stale but cleanly mergeable base as a note, not a blocker", async () => {
    const s = scratch();
    const base = s.commit("base", { "a.txt": "a\n" });
    const h1 = s.branch("branch-1", base, { "z.txt": "z\n" });
    s.advanceMain({ "x.txt": "x\n" });
    const report = await run(s, [pr({ number: 1, headSha: h1 })]);
    expect(find(report, 1)).toMatchObject({ wouldMerge: true });
    expect(find(report, 1).reasons.join("\n")).toMatch(/stale_base: behind main by 1 commit/);
  });

  it("merges a stacked pull request after the one it is stacked on", async () => {
    const s = scratch();
    const base = s.commit("base", { "a.txt": "a\n" });
    const h7 = s.branch("branch-7", base, { "a.txt": "parent\n" });
    const h3 = s.branch("branch-3", h7, { "b.txt": "child\n" });
    const report = await run(s, [pr({ number: 3, headSha: h3, baseRef: "branch-7" }), pr({ number: 7, headSha: h7 })]);
    expect(report.queue).toEqual([7, 3]);
    expect(find(report, 3)).toMatchObject({ dependsOn: [7], wouldMerge: true, queuePosition: 2 });
  });

  it("does not queue a pull request whose parent cannot merge", async () => {
    const s = scratch();
    const base = s.commit("base", { "a.txt": "a\n" });
    const h7 = s.branch("branch-7", base, { "a.txt": "parent\n" });
    const h3 = s.branch("branch-3", h7, { "b.txt": "child\n" });
    const report = await run(s, [
      pr({ number: 3, headSha: h3, baseRef: "branch-7" }),
      pr({ number: 7, headSha: h7, isDraft: true })
    ]);
    expect(report.queue).toEqual([]);
    expect(find(report, 3)).toMatchObject({ wouldMerge: false });
    expect(find(report, 3).reasons.join("\n")).toMatch(/depends on #7, which cannot merge first/);
    expect(find(report, 7).reasons.join("\n")).toMatch(/draft/);
  });

  it("never reports wouldMerge for anything the gate does not mark eligible", async () => {
    const s = scratch();
    const base = s.commit("base", { "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n", "d.txt": "d\n", "e.txt": "e\n" });
    const heads = ["a", "b", "c", "d", "e"].map((f, i) =>
      s.branch(`branch-${i + 1}`, base, { [`${f}.txt`]: `${f} changed\n` })
    );
    const report = await run(s, [
      pr({ number: 1, headSha: heads[0]!, isDraft: true }),
      pr({ number: 2, headSha: heads[1]!, unresolvedThreads: 1 }),
      pr({ number: 3, headSha: heads[2]!, checks: [{ name: "t", status: "COMPLETED", conclusion: "FAILURE" }] }),
      pr({ number: 4, headSha: heads[3]!, mergeable: "UNKNOWN" }),
      pr({ number: 5, headSha: heads[4]! })
    ]);
    expect(report.queue).toEqual([5]);
    for (const p of report.pullRequests) {
      if (p.wouldMerge) expect(p.gate.status).toBe("eligible");
    }
    expect(report.pullRequests.filter((p) => p.wouldMerge).map((p) => p.number)).toEqual([5]);
  });

  it("fails closed when a head is not in the clone", async () => {
    const s = scratch();
    s.commit("base", { "a.txt": "a\n" });
    const report = await run(s, [pr({ number: 1, headSha: "e".repeat(40) })]);
    expect(find(report, 1)).toMatchObject({ wouldMerge: false, standalone: { evaluated: false } });
    expect(find(report, 1).reasons.join("\n")).toMatch(/not evaluated: commit is not present/);
    expect(report.queue).toEqual([]);
  });

  it("flags cycles, detached bases and the protected gate policy", async () => {
    const s = scratch();
    const base = s.commit("base", { "a.txt": "a\n" });
    const h = [1, 2, 3, 4].map((n) => s.branch(`branch-${n}`, base, { [`f${n}.txt`]: "x\n" }));
    const report = await run(s, [
      pr({ number: 1, headSha: h[0]!, baseRef: "branch-2" }),
      pr({ number: 2, headSha: h[1]!, baseRef: "branch-1" }),
      pr({ number: 3, headSha: h[2]!, baseRef: "gone-branch" }),
      pr({ number: 4, headSha: h[3]!, changedFiles: [".github/workflows/jnibarger01-pr-review-merge.yml"] })
    ]);
    expect(report.queue).toEqual([]);
    expect(find(report, 1).reasons.join("\n")).toMatch(/dependency_cycle/);
    expect(find(report, 3).reasons.join("\n")).toMatch(/detached_base/);
    expect(find(report, 4).reasons.join("\n")).toMatch(/gate_policy_modified/);
  });

  it("reports overlapping files as advice", async () => {
    const s = scratch();
    const base = s.commit("base", { "a.txt": "a\n", "b.txt": "b\n" });
    const h1 = s.branch("branch-1", base, { "a.txt": "1\n" });
    const h2 = s.branch("branch-2", base, { "b.txt": "2\n" });
    const report = await run(s, [
      pr({ number: 1, headSha: h1, changedFiles: ["a.txt", "shared.ts"] }),
      pr({ number: 2, headSha: h2, changedFiles: ["shared.ts"] })
    ]);
    expect(find(report, 1).overlaps).toEqual([{ number: 2, files: ["shared.ts"] }]);
    expect(report.queue).toEqual([1, 2]);
  });

  it("changes nothing: no refs moved, no working tree or index change, same report twice", async () => {
    const s = scratch();
    const base = s.commit("base", { "a.txt": "a\n" });
    const h1 = s.branch("branch-1", base, { "a.txt": "one\n" });
    const h2 = s.branch("branch-2", base, { "a.txt": "two\n" });
    const refs = s.refs();
    const prs = [pr({ number: 1, headSha: h1 }), pr({ number: 2, headSha: h2 })];
    const first = await run(s, prs);
    const second = await run(s, prs);
    expect(s.refs()).toBe(refs);
    expect(s.status()).toBe("");
    expect(git(s.dir, "rev-parse", "main")).toBe(base);
    expect(second).toEqual(first);
  });

  it("refuses to run when the integration target is missing", async () => {
    const s = scratch();
    s.commit("base", { "a.txt": "a\n" });
    await expect(run(s, [], { baseRef: "release" })).rejects.toThrow(/integration target release is not present/);
  });

  it("propagates a source failure instead of reporting an empty queue", async () => {
    const s = scratch();
    s.commit("base", { "a.txt": "a\n" });
    await expect(
      reconcile({
        repository: "example/repo",
        baseRef: "main",
        source: { listOpenPullRequests: async () => Promise.reject(new Error("gh graphql failed: HTTP 401")) },
        git: createGitRunner(s.dir),
        mergeMethod: "merge"
      })
    ).rejects.toThrow(/gh graphql failed/);
  });

  describe("merge method", () => {
    /** 7 changes a.txt; 3 is stacked on 7 and changes the same line again. */
    function stacked() {
      const s = scratch();
      const base = s.commit("base", { "a.txt": "a\n" });
      const h7 = s.branch("branch-7", base, { "a.txt": "parent\n" });
      const h3 = s.branch("branch-3", h7, { "a.txt": "child\n" });
      return { s, prs: [pr({ number: 7, headSha: h7 }), pr({ number: 3, headSha: h3, baseRef: "branch-7" })] };
    }

    it("records the method it modeled", async () => {
      const { s, prs } = stacked();
      expect((await run(s, prs)).mergeMethod).toBe("merge");
      expect((await run(s, prs, { mergeMethod: "squash" })).mergeMethod).toBe("squash");
    });

    it("a merge commit keeps the parent's history, so a stacked child that edits the parent's lines merges", async () => {
      const { s, prs } = stacked();
      expect((await run(s, prs)).queue).toEqual([7, 3]);
    });

    it("a squash does not, so the same stacked child conflicts once its parent has landed", async () => {
      const { s, prs } = stacked();
      const report = await run(s, prs, { mergeMethod: "squash" });
      expect(report.queue).toEqual([7]);
      expect(find(report, 3)).toMatchObject({
        wouldMerge: false,
        afterUpstream: { clean: false, conflicts: ["a.txt"] }
      });
      expect(find(report, 3).reasons.join("\n")).toMatch(/conflicts once #7 merges: a\.txt/);
    });

    it("fails closed on rebase: nothing is reported mergeable", async () => {
      const { s, prs } = stacked();
      const report = await run(s, prs, { mergeMethod: "rebase" });
      expect(report.queue).toEqual([]);
      expect(report.pullRequests.every((p) => !p.wouldMerge)).toBe(true);
      expect(find(report, 7).reasons.join("\n")).toMatch(/merge_method_not_modeled/);
    });
  });

  it("distinguishes a dependency cycle from a pull request that is only blocked by one", async () => {
    const s = scratch();
    const base = s.commit("base", { "a.txt": "a\n" });
    const h = [1, 2, 3].map((n) => s.branch(`branch-${n}`, base, { [`f${n}.txt`]: "x\n" }));
    const report = await run(s, [
      pr({ number: 1, headSha: h[0]!, baseRef: "branch-2" }),
      pr({ number: 2, headSha: h[1]!, baseRef: "branch-1" }),
      pr({ number: 3, headSha: h[2]!, baseRef: "branch-1" })
    ]);
    expect(find(report, 1).reasons.join("\n")).toMatch(/dependency_cycle/);
    expect(find(report, 2).reasons.join("\n")).toMatch(/dependency_cycle/);
    const third = find(report, 3).reasons.join("\n");
    expect(third).toMatch(/blocked_by_cycle: depends on #1/);
    expect(third).not.toMatch(/dependency_cycle:/);
    expect(find(report, 3).standalone.evaluated).toBe(true);
    expect(report.queue).toEqual([]);
  });
});
