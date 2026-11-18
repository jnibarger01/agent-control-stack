function pr(number, overrides = {}) {
  return {
    number,
    title: `Synthetic pull request ${number}`,
    author: "fixture",
    state: "OPEN",
    isDraft: false,
    isCrossRepository: false,
    headRef: `branch-${number}`,
    headSha: number.toString(16).padStart(40, "0"),
    baseRef: "main",
    mergeable: "MERGEABLE",
    reviewDecision: "APPROVED",
    unresolvedThreads: 0,
    checks: [{ name: "CI", status: "COMPLETED", conclusion: "SUCCESS" }],
    changedFiles: [],
    truncated: { threads: false, checks: false, files: false },
    ...overrides
  };
}

export function workload(count, dense = false) {
  return Array.from({ length: count }, (_, row) => {
    const number = count - row;
    const baseRef = number % 5 === 0 ? "main" : `branch-${number - (number % 5)}`;
    const changedFiles = Array.from(
      { length: 8 },
      (_, slot) => `packages/group-${number % (dense ? 8 : Math.max(4, count / 5))}/src/file-${(number + slot) % 53}.ts`
    );
    changedFiles.push(`packages/shared/src/touch-${number % 10}.ts`);
    return pr(number, { baseRef, changedFiles, isCrossRepository: number % 47 === 0 });
  });
}

export function cases() {
  const files = ["10", "2", "😀", "\uE000", "\uD800", "e\u0301", "é", "\u0000"];
  const mixed = [
    pr(19, { baseRef: "branch-20" }),
    pr(4, { baseRef: "branch-3", changedFiles: files }),
    pr(8, { baseRef: "branch-4" }),
    pr(3, { baseRef: "branch-4", changedFiles: [...files, "😀"] }),
    pr(13, { baseRef: "branch-3" }),
    pr(20, { baseRef: "branch-21" }),
    pr(21, { baseRef: "missing" }),
    pr(26, { headRef: "fork-only", isCrossRepository: true }),
    pr(25, { baseRef: "fork-only" })
  ];
  const multipleParents = [
    pr(99, { baseRef: "\uD800" }),
    pr(4, { headRef: "\uD800" }),
    pr(2_147_483_649, { headRef: "\uD800" }),
    pr(8, { headRef: "\uD800", isCrossRepository: true }),
    pr(Number.MAX_SAFE_INTEGER, { headRef: "main" }),
    pr(6, { headRef: "self", baseRef: "self" })
  ];
  return [
    [[], "main"],
    [[pr(1)], "main"],
    [mixed, "main"],
    [[...mixed].reverse(), "main"],
    [multipleParents, "main"],
    [[pr(1, { baseRef: "\uD800" })], "\uD800"],
    [workload(24), "main"],
    [workload(32, true), "main"]
  ];
}
