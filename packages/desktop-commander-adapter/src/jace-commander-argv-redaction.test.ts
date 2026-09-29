/**
 * PR #213 review round 1, item 1: secrets passed on a command line must never
 * reach an approver-facing surface (approval summary, summary text, work-item
 * title, intent). Covers privileged_exec (previously raw argv) and start_process.
 * Fake values only, assembled at runtime so the repository secret scanner never
 * sees a secret-shaped literal.
 */
import { describe, expect, it } from "vitest";
import {
  jaceCommanderApprovalSummary,
  jaceCommanderApprovalSummaryText,
  jaceCommanderWorkItemIntent,
  jaceCommanderWorkItemTitle,
  redactJaceCommanderArgv,
  redactJaceCommanderPreview,
  validateJaceCommanderInvocation
} from "./jace-commander.js";

const fake = (...parts: string[]) => parts.join("");
const SECRETS = {
  tokenEq: fake("fakeTok", "EqValue", "01"),
  passwordSpaced: fake("fakePw", "Spaced", "02"),
  bearerHeader: fake("fakeBearer", "Header", "03"),
  bearerSplit: fake("fakeBearer", "Split", "04"),
  keyShaped: fake("AbC9", "dEf8", "GhI7", "jKl6", "MnO5", "pQr4", "StU3", "vWx2"),
  ghToken: fake("gh", "p_", "Q".repeat(36)),
  envAssign: fake("fakeEnv", "Assign", "05"),
  passwordEq: fake("fakePw", "Eq", "06")
} as const;

/** One argv carrying every secret form. */
function secretArgv(executable: string): string[] {
  return [
    executable,
    `--token=${SECRETS.tokenEq}`,
    "--password",
    SECRETS.passwordSpaced,
    "-H",
    `Authorization: Bearer ${SECRETS.bearerHeader}`,
    "--header",
    "Authorization:",
    "Bearer",
    SECRETS.bearerSplit,
    "--key-file-contents",
    SECRETS.keyShaped,
    SECRETS.ghToken,
    `API_KEY=${SECRETS.envAssign}`,
    `--db-password=${SECRETS.passwordEq}`
  ];
}

const SECRET_VALUES = Object.values(SECRETS);

function surfaces(tool: "privileged_exec" | "start_process", argv: string[]) {
  const args = tool === "privileged_exec" ? { argv, cwd: "/srv/work" } : { argv, cwd: "/srv/work", timeoutMs: 5000 };
  const invocation = validateJaceCommanderInvocation(tool, args);
  return {
    invocation,
    summary: JSON.stringify(jaceCommanderApprovalSummary(invocation)),
    text: jaceCommanderApprovalSummaryText(invocation),
    title: jaceCommanderWorkItemTitle(invocation),
    intent: jaceCommanderWorkItemIntent(invocation, "chatgpt:jacen")
  };
}

describe("argv secrets never reach approver-facing surfaces (review round 1, item 1)", () => {
  for (const tool of ["privileged_exec", "start_process"] as const) {
    it(`${tool}: --token=X, --password X, Bearer headers, key-shaped values never appear in summary/title/intent`, () => {
      const { summary, text, title, intent } = surfaces(tool, secretArgv("/usr/bin/curl"));
      for (const [surface, value] of Object.entries({ summary, text, title, intent })) {
        for (const secret of SECRET_VALUES)
          expect(value, `${tool} ${surface} leaked a fake secret`).not.toContain(secret);
      }
      // The approver still sees the command shape and which options were passed.
      expect(summary).toContain("/usr/bin/curl");
      expect(summary).toContain("--password");
      expect(summary).toContain("[redacted]");
      if (tool === "privileged_exec") expect(title.startsWith("ROOT: /usr/bin/curl ")).toBe(true);
    });

    it(`${tool}: each secret form is redacted on its own`, () => {
      const cases: Array<[string[], string]> = [
        [["/usr/bin/tool", `--token=${SECRETS.tokenEq}`], SECRETS.tokenEq],
        [["/usr/bin/tool", "--password", SECRETS.passwordSpaced], SECRETS.passwordSpaced],
        [["/usr/bin/tool", "-H", `Authorization: Bearer ${SECRETS.bearerHeader}`], SECRETS.bearerHeader],
        [["/usr/bin/tool", "Bearer", SECRETS.bearerSplit], SECRETS.bearerSplit],
        [["/usr/bin/tool", SECRETS.keyShaped], SECRETS.keyShaped],
        [["/usr/bin/tool", SECRETS.ghToken], SECRETS.ghToken]
      ];
      for (const [argv, secret] of cases) {
        const { summary, text, title, intent } = surfaces(tool, argv);
        for (const value of [summary, text, title, intent]) expect(value, argv.join(" ")).not.toContain(secret);
      }
    });
  }

  it("privileged_exec argv is bounded like start_process (entries, entry length)", () => {
    const argv = ["/usr/bin/tool", ...Array.from({ length: 100 }, (_, index) => `arg-${index}-${"x".repeat(400)}`)];
    const { invocation, title } = surfaces("privileged_exec", argv);
    const summary = jaceCommanderApprovalSummary(invocation) as { argv: string[]; argvTotal?: number };
    expect(summary.argv.length).toBeLessThanOrEqual(20);
    expect(summary.argvTotal).toBe(101);
    expect(summary.argv.every((entry) => entry.length <= 257)).toBe(true);
    expect(title.length).toBeLessThanOrEqual(200);
  });

  it("ordinary argv stays readable: flags, paths, lower-case shas and UUIDs are not redacted", () => {
    const argv = [
      "/usr/bin/git",
      "-C",
      "/Users/JaceNibarger/Projects/AgentControlStack2026",
      "show",
      "0123456789abcdef0123456789abcdef01234567",
      "--format=%H",
      "123e4567-e89b-12d3-a456-426614174000",
      "--verbose"
    ];
    expect(redactJaceCommanderArgv(argv)).toEqual(argv);
    expect(redactJaceCommanderPreview(argv.join(" "))).toBe(argv.join(" "));
  });
});
