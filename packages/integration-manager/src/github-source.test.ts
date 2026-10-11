import { describe, expect, it } from "vitest";
import { createGhPullRequestSource, snapshotFromGraphQl, type GhRunner } from "./github-source.js";

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
    expect(snapshot).toMatchObject({ author: "unknown", checks: [], truncated: { threads: true, checks: false, files: true } });
    const cut = snapshotFromGraphQl(
      node({
        commits: {
          nodes: [{ commit: { statusCheckRollup: { contexts: { totalCount: 250, nodes: [{ __typename: "CheckRun", name: "t", status: "COMPLETED", conclusion: "SUCCESS" }] } } } }]
        }
      }) as never
    );
    expect(cut.truncated.checks).toBe(true);
  });
});

describe("createGhPullRequestSource", () => {
  const ok = (payload: unknown): GhRunner => async () => ({ exitCode: 0, stdout: JSON.stringify(payload), stderr: "" });

  it("rejects malformed repository names before running anything", () => {
    for (const bad of ["", "owner", "a/b/c", "a/../b", "a/b c", "-x/y;rm"]) {
      expect(() => createGhPullRequestSource(bad, async () => ({ exitCode: 0, stdout: "", stderr: "" })), bad).toThrow(/owner\/name/);
    }
  });

  it("lists pull requests and issues only a read query", async () => {
    const calls: string[][] = [];
    const run: GhRunner = async (args) => {
      calls.push(args);
      return { exitCode: 0, stdout: JSON.stringify({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: [node()] } } } }), stderr: "" };
    };
    const source = createGhPullRequestSource("jnibarger01/agent-control-stack", run);
    expect((await source.listOpenPullRequests()).map((p) => p.number)).toEqual([12]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 2)).toEqual(["api", "graphql"]);
    expect(calls[0]!.join(" ")).not.toMatch(/mutation|--method|-X /);
  });

  it("refuses a partial view: a second page, a failed call, or no data", async () => {
    const paged = createGhPullRequestSource("o/r", ok({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: true }, nodes: [] } } } }));
    await expect(paged.listOpenPullRequests()).rejects.toThrow(/refusing a partial view/);
    const failed = createGhPullRequestSource("o/r", async () => ({ exitCode: 1, stdout: "", stderr: "HTTP 401" }));
    await expect(failed.listOpenPullRequests()).rejects.toThrow(/gh graphql failed/);
    const empty = createGhPullRequestSource("o/r", ok({ data: {} }));
    await expect(empty.listOpenPullRequests()).rejects.toThrow(/no pull request data/);
  });
});
