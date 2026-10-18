import { describe, expect, it, vi } from "vitest";
import { runAcsCli, type AcsAdapters } from "./dispatch.js";
import { OUTCOME_EXIT, exitForVerdict, type OutcomeCliPort } from "./outcome.js";
import { AcsUsageError, parseAcsArgs } from "./parse.js";

const ID = `out_${"a".repeat(24)}`;

function io() {
  let stdout = "";
  let stderr = "";
  return {
    io: { stdout: { write: (c: string) => (stdout += c) }, stderr: { write: (c: string) => (stderr += c) } },
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    }
  };
}

const evaluation = (verdict: "PASS" | "PARTIAL" | "BLOCK" | "FAIL", extra: Record<string, unknown> = {}) =>
  ({
    recorded: true,
    deduped: false,
    stale: false,
    record: {
      outcomeId: ID,
      evaluationId: "eval_x",
      verdict,
      blockKind: verdict === "BLOCK" ? "needs_human" : null,
      headSha: "a".repeat(40),
      baseRefOid: "b".repeat(40),
      readerProvenance: "live_github",
      reasonCodes: ["r1"],
      findings: ["gate: finding"],
      criteriaSummary: { requiredSatisfied: 1, requiredUnsatisfied: 0, requiredUndecided: 0, optionalUnsatisfied: [] },
      humanControl: { exposure: "possible", note: "n" },
      nextActions: [{ action: "decide_merge_hold", requiresHuman: true, detail: "d" }],
      ...extra
    }
  }) as never;

function adapters(port: Partial<OutcomeCliPort>): AcsAdapters {
  return { outcome: port as OutcomeCliPort } as AcsAdapters;
}

describe("parse", () => {
  it("parses accept with every flag and strict integers", () => {
    expect(
      parseAcsArgs([
        "outcome",
        "accept",
        "--repo",
        "o/r",
        "--pr",
        "7",
        "--goal",
        "ship it",
        "--criteria-file",
        "c.json",
        "--expires-at",
        "2030-01-01T00:00:00.000Z",
        "--max-evaluations",
        "5",
        "--json"
      ])
    ).toEqual({
      kind: "outcome-accept",
      repository: "o/r",
      pullRequest: 7,
      goal: "ship it",
      criteriaFile: "c.json",
      expiresAt: "2030-01-01T00:00:00.000Z",
      maxEvaluations: 5,
      json: true
    });
  });
  it("rejects unknown flags, missing values, bad numbers and bad ids", () => {
    for (const args of [
      ["outcome"],
      ["outcome", "accept", "--repo", "o/r", "--pr", "7"],
      ["outcome", "accept", "--repo", "o/r", "--pr", "0", "--goal", "g"],
      ["outcome", "accept", "--repo", "o/r", "--pr", "7", "--goal", "g", "--verdict", "PASS"],
      ["outcome", "accept", "--repo", "o/r", "--pr", "7", "--goal"],
      ["outcome", "evaluate", "nope"],
      ["outcome", "show"],
      ["outcome", "list", "--x"],
      ["outcome", "merge", ID]
    ]) {
      expect(() => parseAcsArgs(args), args.join(" ")).toThrow(AcsUsageError);
    }
  });
  it("parses evaluate, show and list", () => {
    expect(parseAcsArgs(["outcome", "evaluate", ID, "--json"])).toEqual({
      kind: "outcome-evaluate",
      outcomeId: ID,
      json: true
    });
    expect(parseAcsArgs(["outcome", "show", ID])).toEqual({ kind: "outcome-show", outcomeId: ID, json: false });
    expect(parseAcsArgs(["outcome", "list"])).toEqual({ kind: "outcome-list", json: false });
  });
});

describe("exit codes", () => {
  it("never maps any verdict to exit 0", () => {
    expect((Object.values(OUTCOME_EXIT) as number[]).every((code) => code !== 0)).toBe(true);
    expect(exitForVerdict("PASS")).toBe(10);
    expect(new Set(Object.values(OUTCOME_EXIT)).size).toBe(5);
  });
});

describe("outcome commands", () => {
  it("evaluate prints the evidence, a not-approval statement for PASS, and exits 10", async () => {
    const out = io();
    const code = await runAcsCli(
      ["outcome", "evaluate", ID],
      out.io,
      adapters({ evaluate: vi.fn(async () => evaluation("PASS")) })
    );
    expect(code).toBe(10);
    expect(out.stdout).toContain("PASS");
    expect(out.stdout).toContain("not merge approval");
    expect(out.stdout).toContain("[human]");
  });
  it.each([
    ["PARTIAL", 11],
    ["BLOCK", 12],
    ["FAIL", 13]
  ] as const)("evaluate exits %s as %i and prints no approval statement", async (verdict, expected) => {
    const out = io();
    const code = await runAcsCli(
      ["outcome", "evaluate", ID, "--json"],
      out.io,
      adapters({ evaluate: vi.fn(async () => evaluation(verdict)) })
    );
    expect(code).toBe(expected);
    expect(JSON.parse(out.stdout).record.verdict).toBe(verdict);
    expect(out.stdout).not.toContain("not merge approval");
  });
  it("accept reports the local, unauthenticated authority and exits 0", async () => {
    const out = io();
    const accept = vi.fn(
      () =>
        ({
          record: {
            outcomeId: ID,
            repository: "o/r",
            pullRequest: 7,
            authority: { kind: "unauthenticated_local_operator", osUser: "u" }
          },
          created: true
        }) as never
    );
    const code = await runAcsCli(
      ["outcome", "accept", "--repo", "o/r", "--pr", "7", "--goal", "g"],
      out.io,
      adapters({ accept })
    );
    expect(code).toBe(0);
    expect(out.stdout).toContain("unauthenticated");
    expect(accept).toHaveBeenCalledOnce();
  });
  it("show maps a stale PASS to exit 14, integrity problems to 1, and a missing outcome to 1", async () => {
    const base = {
      accepted: { outcomeId: ID, repository: "o/r", pullRequest: 7 },
      evaluations: [{ verdict: "PASS" }],
      problems: [] as string[],
      latestStale: false
    };
    const show = vi.fn();
    show.mockReturnValueOnce({ ...base, latestStale: true });
    expect(await runAcsCli(["outcome", "show", ID], io().io, adapters({ show }))).toBe(14);
    show.mockReturnValueOnce({ ...base, problems: ["evaluation#1:chain_hash_mismatch"] });
    const out = io();
    expect(await runAcsCli(["outcome", "show", ID], out.io, adapters({ show }))).toBe(1);
    expect(out.stdout).toContain("integrity: evaluation#1:chain_hash_mismatch");
    show.mockReturnValueOnce(undefined);
    expect(await runAcsCli(["outcome", "show", ID], io().io, adapters({ show }))).toBe(1);
    show.mockReturnValueOnce({ ...base, evaluations: [] });
    expect(await runAcsCli(["outcome", "show", ID], io().io, adapters({ show }))).toBe(0);
  });
  it("list prints rows or an empty notice", async () => {
    const out = io();
    expect(await runAcsCli(["outcome", "list"], out.io, adapters({ list: vi.fn(() => []) }))).toBe(0);
    expect(out.stdout).toBe("No outcomes.\n");
    const rows = io();
    await runAcsCli(
      ["outcome", "list"],
      rows.io,
      adapters({
        list: vi.fn(
          () =>
            [
              { outcomeId: ID, repository: "o/r", pullRequest: 7, evaluations: 2, latestVerdict: "PASS", problems: 0 }
            ] as never
        )
      })
    );
    expect(rows.stdout).toContain("latest=PASS");
  });
  it("the default port fails closed without a dedicated read-only token", async () => {
    const saved = { ...process.env };
    delete process.env.ACS_OUTCOME_GITHUB_TOKEN;
    try {
      const out = io();
      expect(await runAcsCli(["outcome", "list"], out.io, {} as AcsAdapters)).toBe(1);
      expect(out.stderr).toContain("ACS_OUTCOME_GITHUB_TOKEN is required");
      process.env.ACS_OUTCOME_GITHUB_TOKEN = "ghx_same_token_value_1234";
      process.env.GH_TOKEN = "ghx_same_token_value_1234";
      const out2 = io();
      expect(await runAcsCli(["outcome", "list"], out2.io, {} as AcsAdapters)).toBe(1);
      expect(out2.stderr).toContain("must not equal");
    } finally {
      process.env = saved;
    }
  });
});
