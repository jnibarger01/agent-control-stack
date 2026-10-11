import { describe, expect, it } from "vitest";
import {
  createGhPullRequestSource,
  createGhRunner,
  parsePullRequestNode,
  readRepositoryMergeMethod,
  selectMergeMethod,
  snapshotFromGraphQl,
  type GhRunner
} from "./github-source.js";

const node = (overrides: Record<string, unknown> = {}) => ({
  number: 12,
  title: "feat: thing",
  state: "OPEN",
  isDraft: false,
  isCrossRepository: false,
  headRefName: "feat/thing",
  headRefOid: "a".repeat(40),
  baseRefName: "main",
  mergeable: "MERGEABLE",
  reviewDecision: null,
  author: { login: "jnibarger01" },
  reviewThreads: { totalCount: 3, nodes: [{ isResolved: true }, { isResolved: false }, { isResolved: false }] },
  files: { totalCount: 2, nodes: [{ path: "a.ts" }, { path: "b.ts" }] },
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            contexts: {
              totalCount: 3,
              nodes: [
                { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
                { __typename: "CheckRun", name: "check", status: "IN_PROGRESS", conclusion: null },
                { __typename: "StatusContext", context: "Vercel", state: "SUCCESS" }
              ]
            }
          }
        }
      }
    ]
  },
  ...overrides
});

describe("snapshotFromGraphQl", () => {
  it("maps fields, counts unresolved threads, and maps check runs and commit statuses", () => {
    const snapshot = snapshotFromGraphQl(node() as never);
    expect(snapshot).toMatchObject({
      number: 12,
      author: "jnibarger01",
      headRef: "feat/thing",
      headSha: "a".repeat(40),
      baseRef: "main",
      unresolvedThreads: 2,
      changedFiles: ["a.ts", "b.ts"],
      truncated: { threads: false, checks: false, files: false }
    });
    expect(snapshot.checks).toEqual([
      { name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "check", status: "IN_PROGRESS", conclusion: null },
      { name: "Vercel", status: "COMPLETED", conclusion: "SUCCESS" }
    ]);
  });

  it("maps pending and failed commit statuses honestly", () => {
    const snapshot = snapshotFromGraphQl(
      node({
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: {
                    totalCount: 3,
                    nodes: [
                      { __typename: "StatusContext", context: "a", state: "PENDING" },
                      { __typename: "StatusContext", context: "b", state: "FAILURE" },
                      { __typename: "StatusContext", context: "c", state: "SOMETHING_NEW" }
                    ]
                  }
                }
              }
            }
          ]
        }
      }) as never
    );
    expect(snapshot.checks).toEqual([
      { name: "a", status: "PENDING", conclusion: null },
      { name: "b", status: "COMPLETED", conclusion: "FAILURE" },
      { name: "c", status: "UNKNOWN", conclusion: null }
    ]);
  });

  it("flags truncation instead of hiding it, and tolerates no rollup or no author", () => {
    const snapshot = snapshotFromGraphQl(
      node({
        author: null,
        reviewThreads: { totalCount: 150, nodes: [{ isResolved: true }] },
        files: { totalCount: 500, nodes: [{ path: "a.ts" }] },
        commits: { nodes: [{ commit: { statusCheckRollup: null } }] }
      }) as never
    );
    expect(snapshot).toMatchObject({
      author: "unknown",
      checks: [],
      truncated: { threads: true, checks: false, files: true }
    });
    const cut = snapshotFromGraphQl(
      node({
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: {
                    totalCount: 250,
                    nodes: [{ __typename: "CheckRun", name: "t", status: "COMPLETED", conclusion: "SUCCESS" }]
                  }
                }
              }
            }
          ]
        }
      }) as never
    );
    expect(cut.truncated.checks).toBe(true);
  });
});

describe("createGhPullRequestSource", () => {
  const ok =
    (payload: unknown): GhRunner =>
    async () => ({ exitCode: 0, stdout: JSON.stringify(payload), stderr: "" });

  it("rejects malformed repository names before running anything", () => {
    for (const bad of [
      "",
      "owner",
      "a/b/c",
      "a/../b",
      "../x",
      "x/..",
      "./x",
      "x/.",
      "a/b c",
      "-x/y;rm",
      "-a/b",
      "a-/b",
      "a--b/c",
      "a/b?x=1",
      "a/b#c"
    ]) {
      expect(() => createGhPullRequestSource(bad, async () => ({ exitCode: 0, stdout: "", stderr: "" })), bad).toThrow(
        /owner\/name/
      );
    }
  });

  it("lists pull requests and issues only a read query", async () => {
    const calls: string[][] = [];
    const run: GhRunner = async (args) => {
      calls.push(args);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          data: { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: [node()] } } }
        }),
        stderr: ""
      };
    };
    const source = createGhPullRequestSource("jnibarger01/agent-control-stack", run);
    expect((await source.listOpenPullRequests()).map((p) => p.number)).toEqual([12]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 2)).toEqual(["api", "graphql"]);
    expect(calls[0]!.join(" ")).not.toMatch(/mutation|--method|-X /);
  });

  it("refuses a partial view: a second page, a failed call, or no data", async () => {
    const paged = createGhPullRequestSource(
      "o/r",
      ok({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: true }, nodes: [] } } } })
    );
    await expect(paged.listOpenPullRequests()).rejects.toThrow(/refusing a partial view/);
    const failed = createGhPullRequestSource("o/r", async () => ({ exitCode: 1, stdout: "", stderr: "HTTP 401" }));
    await expect(failed.listOpenPullRequests()).rejects.toThrow(/gh graphql failed/);
    const empty = createGhPullRequestSource("o/r", ok({ data: {} }));
    await expect(empty.listOpenPullRequests()).rejects.toThrow(/no pull request data/);
  });
});

describe("runtime validation of the GraphQL response", () => {
  it("accepts a well-formed node", () => {
    expect(parsePullRequestNode(node())).toMatchObject({ number: 12, mergeable: "MERGEABLE" });
  });

  it.each([
    ["an unknown mergeable value", { mergeable: "MAYBE" }],
    ["an unknown review decision", { reviewDecision: "LOOKS_FINE" }],
    ["an unknown pull request state", { state: "ARCHIVED" }],
    ["a missing mergeable field", { mergeable: undefined }],
    ["a non-boolean draft flag", { isDraft: "false" }],
    ["a short commit id", { headRefOid: "abc" }],
    ["a missing number", { number: undefined }],
    ["negative thread counts", { reviewThreads: { totalCount: -1, nodes: [] } }],
    ["a thread without a resolved flag", { reviewThreads: { totalCount: 1, nodes: [{}] } }],
    [
      "a check run without a name",
      {
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: { totalCount: 1, nodes: [{ __typename: "CheckRun", status: "COMPLETED" }] }
                }
              }
            }
          ]
        }
      }
    ],
    [
      "an unknown context type",
      {
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: { contexts: { totalCount: 1, nodes: [{ __typename: "Mystery", name: "x" }] } }
              }
            }
          ]
        }
      }
    ]
  ])("refuses %s rather than reading it as eligible", (_name, overrides) => {
    expect(() => parsePullRequestNode(node(overrides))).toThrow(
      /unexpected GitHub response for pull request #|unexpected GitHub response/
    );
  });

  it("names the pull request and the fields, but never echoes response content", () => {
    try {
      parsePullRequestNode(node({ mergeable: "SECRET-VALUE-XYZ" }));
      throw new Error("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/pull request #12/);
      expect(message).toMatch(/mergeable/);
      expect(message).not.toContain("SECRET-VALUE-XYZ");
    }
  });

  it("fails the whole read when any one node is malformed", async () => {
    const run: GhRunner = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        data: {
          repository: {
            pullRequests: { pageInfo: { hasNextPage: false }, nodes: [node(), node({ number: 13, mergeable: "???" })] }
          }
        }
      }),
      stderr: ""
    });
    await expect(createGhPullRequestSource("o/r", run).listOpenPullRequests()).rejects.toThrow(/pull request #13/);
  });

  it("maps an unrecognized check status to UNKNOWN, which the gate treats as not finished", () => {
    const snapshot = parsePullRequestNode(
      node({
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: {
                    totalCount: 1,
                    nodes: [{ __typename: "CheckRun", name: "x", status: "BRAND_NEW", conclusion: "SUCCESS" }]
                  }
                }
              }
            }
          ]
        }
      })
    );
    expect(snapshot.checks).toEqual([{ name: "x", status: "UNKNOWN", conclusion: "SUCCESS" }]);
  });
});

describe("createGhRunner credential handling", () => {
  const capture = () => {
    const seen: Array<Record<string, string | undefined>> = [];
    const command = async (options: { env?: NodeJS.ProcessEnv }) => {
      seen.push({ GH_TOKEN: options.env?.GH_TOKEN, GITHUB_TOKEN: options.env?.GITHUB_TOKEN, PATH: options.env?.PATH });
      return { exitCode: 0, stdout: "{}", stderr: "", timedOut: false, durationMs: 1 };
    };
    return { seen, command: command as never };
  };

  it("does not inherit an ambient token", async () => {
    const saved = { gh: process.env.GH_TOKEN, github: process.env.GITHUB_TOKEN };
    process.env.GH_TOKEN = "ambient-gh-token-value";
    process.env.GITHUB_TOKEN = "ambient-github-token-value";
    try {
      const { seen, command } = capture();
      await createGhRunner({}, command)(["api", "x"]);
      expect(seen[0]!.GH_TOKEN).toBeUndefined();
      expect(seen[0]!.GITHUB_TOKEN).toBeUndefined();
    } finally {
      if (saved.gh === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = saved.gh;
      if (saved.github === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = saved.github;
    }
  });

  it("passes an explicitly supplied token as GH_TOKEN and nothing else", async () => {
    const { seen, command } = capture();
    await createGhRunner({ token: "explicit-read-only-token" }, command)(["api", "x"]);
    expect(seen[0]).toMatchObject({ GH_TOKEN: "explicit-read-only-token", GITHUB_TOKEN: undefined });
  });

  it("refuses a token with an unexpected shape", () => {
    for (const bad of ["", "short", "has space in it 12345", "line\nbreak-token-12345", "x".repeat(300)]) {
      expect(() => createGhRunner({ token: bad })).toThrow(/token/);
    }
  });
});

describe("merge method selection", () => {
  it("picks the first allowed of merge, squash, rebase", () => {
    expect(selectMergeMethod({ allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: true })).toBe(
      "merge"
    );
    expect(selectMergeMethod({ allow_merge_commit: false, allow_squash_merge: true, allow_rebase_merge: true })).toBe(
      "squash"
    );
    expect(selectMergeMethod({ allow_merge_commit: false, allow_squash_merge: false, allow_rebase_merge: true })).toBe(
      "rebase"
    );
  });

  it("returns undefined, so the caller fails closed, when none is allowed or a setting is not a boolean", () => {
    expect(
      selectMergeMethod({ allow_merge_commit: false, allow_squash_merge: false, allow_rebase_merge: false })
    ).toBeUndefined();
    expect(
      selectMergeMethod({ allow_merge_commit: "true", allow_squash_merge: true, allow_rebase_merge: true })
    ).toBeUndefined();
    expect(selectMergeMethod({ allow_squash_merge: true, allow_rebase_merge: true })).toBeUndefined();
    expect(selectMergeMethod({})).toBeUndefined();
  });

  it("reads the settings read-only and refuses when they cannot be determined", async () => {
    const calls: string[][] = [];
    const ok: GhRunner = async (args) => {
      calls.push(args);
      return {
        exitCode: 0,
        stdout: JSON.stringify({ allow_merge_commit: false, allow_squash_merge: true, allow_rebase_merge: false }),
        stderr: ""
      };
    };
    expect(await readRepositoryMergeMethod("o/r", ok)).toBe("squash");
    expect(calls).toEqual([["api", "repos/o/r"]]);
    await expect(
      readRepositoryMergeMethod("o/r", async () => ({ exitCode: 1, stdout: "", stderr: "HTTP 404" }))
    ).rejects.toThrow(/gh api failed/);
    await expect(
      readRepositoryMergeMethod("o/r", async () => ({ exitCode: 0, stdout: "{}", stderr: "" }))
    ).rejects.toThrow(/no usable/);
    await expect(readRepositoryMergeMethod("../x", ok)).rejects.toThrow(/owner\/name/);
  });
});
