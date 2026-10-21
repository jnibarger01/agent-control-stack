import { describe, expect, it } from "vitest";
import { PULL_REQUEST_BY_NUMBER_QUERY, createGhPullRequestReader, type GhRunner } from "./github-source.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

const node = (overrides: Record<string, unknown> = {}) => ({
  number: 7,
  title: "feat: thing",
  state: "OPEN",
  isDraft: false,
  isCrossRepository: false,
  headRefName: "feat/thing",
  headRefOid: HEAD,
  baseRefName: "main",
  baseRefOid: BASE,
  mergeable: "MERGEABLE",
  reviewDecision: null,
  author: { login: "someone" },
  reviewThreads: { totalCount: 0, nodes: [] },
  files: { totalCount: 1, nodes: [{ path: "a.ts" }] },
  commits: {
    nodes: [
      {
        commit: {
          oid: HEAD,
          statusCheckRollup: {
            contexts: {
              totalCount: 2,
              nodes: [
                {
                  __typename: "CheckRun",
                  name: "check",
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                  checkSuite: { app: { slug: "github-actions" } }
                },
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

const respond =
  (pullRequest: unknown, calls: string[][] = []): GhRunner =>
  async (args) => {
    calls.push(args);
    return { exitCode: 0, stdout: JSON.stringify({ data: { repository: { pullRequest } } }), stderr: "" };
  };

describe("createGhPullRequestReader", () => {
  it("issues a query-only request with the number as an integer variable", async () => {
    const calls: string[][] = [];
    const snapshot = await createGhPullRequestReader("o/r", respond(node(), calls)).getPullRequest(7);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      "api",
      "graphql",
      "-f",
      `query=${PULL_REQUEST_BY_NUMBER_QUERY}`,
      "-F",
      "owner=o",
      "-F",
      "name=r",
      "-F",
      "number=7"
    ]);
    expect(PULL_REQUEST_BY_NUMBER_QUERY).not.toMatch(/mutation/iu);
    expect(snapshot.baseRefOid).toBe(BASE);
    expect(snapshot.checksCommitSha).toBe(HEAD);
  });

  it("carries the app behind each check run and the source of every check", async () => {
    const snapshot = await createGhPullRequestReader("o/r", respond(node())).getPullRequest(7);
    expect(snapshot.checks).toEqual([
      { name: "check", status: "COMPLETED", conclusion: "SUCCESS", appSlug: "github-actions", source: "check_run" },
      { name: "Vercel", status: "COMPLETED", conclusion: "SUCCESS", appSlug: null, source: "status_context" }
    ]);
  });

  it("reads closed and merged pull requests without error", async () => {
    const snapshot = await createGhPullRequestReader("o/r", respond(node({ state: "MERGED" }))).getPullRequest(7);
    expect(snapshot.state).toBe("MERGED");
  });

  it("refuses a missing pull request, a mismatched number, and a missing base or rollup commit", async () => {
    await expect(createGhPullRequestReader("o/r", respond(null)).getPullRequest(7)).rejects.toThrow(/not found/u);
    await expect(createGhPullRequestReader("o/r", respond(node({ number: 8 }))).getPullRequest(7)).rejects.toThrow(
      /expected #7/u
    );
    await expect(
      createGhPullRequestReader("o/r", respond(node({ baseRefOid: undefined }))).getPullRequest(7)
    ).rejects.toThrow(/lacks the base or rollup commit/u);
    const noOid = node();
    (noOid.commits.nodes[0] as { commit: { oid?: string } }).commit.oid = undefined;
    await expect(createGhPullRequestReader("o/r", respond(noOid)).getPullRequest(7)).rejects.toThrow(
      /lacks the base or rollup commit/u
    );
  });

  it("fails the whole read on an unknown enum value or unparseable output", async () => {
    await expect(
      createGhPullRequestReader("o/r", respond(node({ mergeable: "SURPRISE" }))).getPullRequest(7)
    ).rejects.toThrow(/refusing a partial view/u);
    const garbage: GhRunner = async () => ({ exitCode: 0, stdout: "not json", stderr: "" });
    await expect(createGhPullRequestReader("o/r", garbage).getPullRequest(7)).rejects.toThrow(/unparseable/u);
  });

  it("surfaces a gh failure and rejects invalid numbers or repositories before any call", async () => {
    const failing: GhRunner = async () => ({ exitCode: 1, stdout: "", stderr: "boom" });
    await expect(createGhPullRequestReader("o/r", failing).getPullRequest(7)).rejects.toThrow(
      /gh graphql failed: boom/u
    );
    await expect(createGhPullRequestReader("o/r", respond(node())).getPullRequest(0)).rejects.toThrow(
      /positive integer/u
    );
    await expect(createGhPullRequestReader("o/r", respond(node())).getPullRequest(1.5)).rejects.toThrow(
      /positive integer/u
    );
    expect(() => createGhPullRequestReader("../x", respond(node()))).toThrow(/owner\/name/u);
  });
});
