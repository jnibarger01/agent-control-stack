import { PULL_REQUEST_BY_NUMBER_QUERY, type GhRunner } from "@agent-control-stack/integration-manager";
import { describe, expect, it } from "vitest";
import { OutcomeReadError, assertReadOnlyArgv, createReadOnlyGhRunner } from "./readonly-gh-runner.js";

const good = (): string[] => [
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
];

describe("createReadOnlyGhRunner", () => {
  it("forwards exactly the by-number query", async () => {
    const seen: string[][] = [];
    const inner: GhRunner = async (args) => (seen.push([...args]), { exitCode: 0, stdout: "{}", stderr: "" });
    await createReadOnlyGhRunner(inner)(good());
    expect(seen).toEqual([good()]);
  });
  it.each([
    ["a method override", [...good(), "-X", "POST"]],
    ["--method", [...good().slice(0, 2), "--method", "POST", ...good().slice(2)]],
    ["--input", [...good(), "--input", "x"]],
    ["a @file value", good().map((a) => (a.startsWith("number=") ? "number=@/etc/passwd" : a))],
    ["--hostname", ["api", "graphql", "--hostname", "evil", ...good().slice(2)]],
    ["an extra header", [...good(), "-H", "X: y"]],
    ["a mutation query", good().map((a) => (a.startsWith("query=") ? "query=mutation{x}" : a))],
    ["a different subcommand", ["pr", "merge", "7"]],
    [
      "reordered arguments",
      [
        "api",
        "graphql",
        "-F",
        "owner=o",
        "-f",
        `query=${PULL_REQUEST_BY_NUMBER_QUERY}`,
        "-F",
        "name=r",
        "-F",
        "number=7"
      ]
    ],
    ["an invalid owner", good().map((a) => (a === "owner=o" ? "owner=../x" : a))],
    ["a non-integer number", good().map((a) => (a === "number=7" ? "number=7.5" : a))],
    ["a zero number", good().map((a) => (a === "number=7" ? "number=0" : a))],
    ["no arguments", []]
  ])("refuses %s", async (_name, args) => {
    let called = false;
    const inner: GhRunner = async () => ((called = true), { exitCode: 0, stdout: "{}", stderr: "" });
    await expect(createReadOnlyGhRunner(inner)(args)).rejects.toThrow(
      expect.objectContaining({ code: "gh_argv_not_allowed" })
    );
    expect(called).toBe(false);
    expect(() => assertReadOnlyArgv(args)).toThrow(OutcomeReadError);
  });
  it("names a response the command runner redacted wholesale", async () => {
    const inner: GhRunner = async () => ({ exitCode: 0, stdout: "[redacted]\n", stderr: "" });
    await expect(createReadOnlyGhRunner(inner)(good())).rejects.toThrow(
      expect.objectContaining({ code: "github_response_redacted_by_runner" })
    );
  });
});
