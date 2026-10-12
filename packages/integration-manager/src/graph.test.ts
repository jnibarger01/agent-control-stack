import { describe, expect, it } from "vitest";
import { analyzeDependencies, findOverlaps } from "./graph.js";
import { pr } from "./fixtures.test-support.js";

describe("analyzeDependencies", () => {
  it("orders independent pull requests by number", () => {
    const a = analyzeDependencies([pr({ number: 9 }), pr({ number: 2 }), pr({ number: 5 })], "main");
    expect(a.order).toEqual([2, 5, 9]);
    expect(a.cyclic.size + a.detached.size).toBe(0);
  });

  it("puts a stacked pull request after the one it is stacked on, whatever the numbers", () => {
    const a = analyzeDependencies([pr({ number: 3, baseRef: "branch-7" }), pr({ number: 7 })], "main");
    expect(a.dependsOn.get(3)).toEqual([7]);
    expect(a.order).toEqual([7, 3]);
  });

  it("orders a chain of three", () => {
    const a = analyzeDependencies(
      [pr({ number: 1, baseRef: "branch-2" }), pr({ number: 2, baseRef: "branch-3" }), pr({ number: 3 })],
      "main"
    );
    expect(a.order).toEqual([3, 2, 1]);
  });

  it("does not match a fork's branch that merely shares a name with an upstream base", () => {
    const a = analyzeDependencies(
      [
        pr({ number: 1, headRef: "feature", isCrossRepository: true }),
        pr({ number: 2, baseRef: "feature" }),
        pr({ number: 3, headRef: "feature" }),
        pr({ number: 4, baseRef: "feature" })
      ],
      "main"
    );
    // #2 and #4 are based on `feature` in the upstream repository, which only #3's head (same repository) can be.
    expect(a.dependsOn.get(2)).toEqual([3]);
    expect(a.dependsOn.get(4)).toEqual([3]);
    expect(a.order).toEqual([1, 3, 2, 4]);
  });

  it("treats a base that only a fork provides as detached", () => {
    const a = analyzeDependencies(
      [pr({ number: 1, headRef: "feature", isCrossRepository: true }), pr({ number: 2, baseRef: "feature" })],
      "main"
    );
    expect(a.detached.has(2)).toBe(true);
  });

  it("detects a cycle and keeps the rest orderable", () => {
    const a = analyzeDependencies(
      [pr({ number: 1, baseRef: "branch-2" }), pr({ number: 2, baseRef: "branch-1" }), pr({ number: 3 })],
      "main"
    );
    expect([...a.cyclic].sort()).toEqual([1, 2]);
    expect(a.order).toEqual([3]);
  });

  it("separates cycle members from pull requests that only depend on a cycle, at any depth", () => {
    const a = analyzeDependencies(
      [
        pr({ number: 1, baseRef: "branch-2" }),
        pr({ number: 2, baseRef: "branch-1" }),
        pr({ number: 3, baseRef: "branch-1" }),
        pr({ number: 4, baseRef: "branch-3" }),
        pr({ number: 5 })
      ],
      "main"
    );
    expect([...a.cyclic].sort()).toEqual([1, 2]);
    expect([...a.blockedByCycle].sort()).toEqual([3, 4]);
    expect(a.order).toEqual([5]);
  });

  it("finds a longer cycle and a self-contained pair next to it", () => {
    const a = analyzeDependencies(
      [
        pr({ number: 1, baseRef: "branch-3" }),
        pr({ number: 2, baseRef: "branch-1" }),
        pr({ number: 3, baseRef: "branch-2" }),
        pr({ number: 4 }),
        pr({ number: 5, baseRef: "branch-4" })
      ],
      "main"
    );
    expect([...a.cyclic].sort()).toEqual([1, 2, 3]);
    expect(a.blockedByCycle.size).toBe(0);
    expect(a.order).toEqual([4, 5]);
  });

  it("marks a base that is neither the target nor an open head as detached, transitively", () => {
    const a = analyzeDependencies(
      [
        pr({ number: 1, baseRef: "some-old-branch" }),
        pr({ number: 2, baseRef: "branch-1" }),
        pr({ number: 3, baseRef: "branch-2" }),
        pr({ number: 4 })
      ],
      "main"
    );
    expect([...a.detached].sort()).toEqual([1, 2, 3]);
    expect(a.order).toEqual([4]);
  });

  it("does not treat a pull request as its own parent", () => {
    const a = analyzeDependencies([pr({ number: 1, headRef: "x", baseRef: "x" })], "main");
    expect(a.detached.has(1)).toBe(true);
  });
});

describe("findOverlaps", () => {
  it("lists shared files per pair, sorted, and nothing for disjoint changes", () => {
    const overlaps = findOverlaps([
      pr({ number: 1, changedFiles: ["a.ts", "b.ts"] }),
      pr({ number: 2, changedFiles: ["b.ts", "a.ts", "c.ts"] }),
      pr({ number: 3, changedFiles: ["z.ts"] })
    ]);
    expect(overlaps.get(1)).toEqual([{ number: 2, files: ["a.ts", "b.ts"] }]);
    expect(overlaps.get(2)).toEqual([{ number: 1, files: ["a.ts", "b.ts"] }]);
    expect(overlaps.get(3)).toEqual([]);
  });
});
