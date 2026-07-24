import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStackError } from "@agent-control-stack/shared";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeVerifier, buildClaudeVerifierArgs } from "./claude-verifier.js";
import type { VerificationCriterion, VerificationEvidence } from "./types.js";

describe("buildClaudeVerifierArgs", () => {
  it("always disables tool use and pins permission-mode to plan", () => {
    const args = buildClaudeVerifierArgs("claude-sonnet-5", 0.5);
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
    expect(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2)).toEqual([
      "--permission-mode",
      "plan"
    ]);
    expect(args).toContain("--json-schema");
    expect(args).toContain("--no-session-persistence");
  });
});

function criteria(): VerificationCriterion[] {
  return [{ id: "c1", description: "tests pass", expected: "exit code 0" }];
}

function evidence(): VerificationEvidence {
  return {
    workItemId: "wrk_test",
    implementerClaim: "tests passed",
    diffSummary: "added a function",
    commandResults: [{ commandProfile: "npm-test", exitCode: 0, observedSuccess: true, stdout: "ok", stderr: "" }]
  };
}

function claudeEnvelope(resultObject: unknown): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify(resultObject)
  });
}

describe("ClaudeVerifier", () => {
  let scriptDir: string | undefined;

  afterEach(() => {
    if (scriptDir) rmSync(scriptDir, { recursive: true, force: true });
    scriptDir = undefined;
  });

  function writeFixture(script: string): string {
    scriptDir = mkdtempSync(join(tmpdir(), "claude-verifier-test-"));
    const scriptPath = join(scriptDir, "fake-claude.mjs");
    writeFileSync(scriptPath, script, "utf8");
    chmodSync(scriptPath, 0o755);
    return scriptPath;
  }

  it("parses a genuine pass verdict from the CLI envelope", async () => {
    const binary = writeFixture(
      [
        "#!/usr/bin/env node",
        `const envelope = ${JSON.stringify(
          claudeEnvelope({
            verdict: "pass",
            summary: "all criteria satisfied",
            criteriaResults: [{ criterionId: "c1", satisfied: true, observed: "exit code 0" }]
          })
        )};`,
        "process.stdout.write(envelope);"
      ].join("\n")
    );
    const verifier = new ClaudeVerifier({ binary });

    const result = await verifier.verify(criteria(), evidence());

    expect(result.verdict).toBe("pass");
    expect(result.verifierEngineId).toBe("claude-cli-verifier");
    expect(result.criteriaResults).toEqual([{ criterionId: "c1", satisfied: true, observed: "exit code 0" }]);
  });

  it("parses an inconclusive verdict without coercing it to pass or fail", async () => {
    const binary = writeFixture(
      [
        "#!/usr/bin/env node",
        `const envelope = ${JSON.stringify(
          claudeEnvelope({
            verdict: "inconclusive",
            summary: "evidence does not show whether the test suite actually ran",
            criteriaResults: [{ criterionId: "c1", satisfied: false, observed: "no test runner output present" }]
          })
        )};`,
        "process.stdout.write(envelope);"
      ].join("\n")
    );
    const verifier = new ClaudeVerifier({ binary });

    const result = await verifier.verify(criteria(), evidence());

    expect(result.verdict).toBe("inconclusive");
  });

  it("rejects a claimed pass verdict whose own criteria list contradicts it", async () => {
    const binary = writeFixture(
      [
        "#!/usr/bin/env node",
        `const envelope = ${JSON.stringify(
          claudeEnvelope({
            verdict: "pass",
            summary: "claims pass despite an unsatisfied criterion",
            criteriaResults: [{ criterionId: "c1", satisfied: false, observed: "tests actually failed" }]
          })
        )};`,
        "process.stdout.write(envelope);"
      ].join("\n")
    );
    const verifier = new ClaudeVerifier({ binary });

    await expect(verifier.verify(criteria(), evidence())).rejects.toThrow();
  });

  it("throws a typed error on a malformed (non-JSON) CLI response", async () => {
    const binary = writeFixture(["#!/usr/bin/env node", 'process.stdout.write("not json at all");'].join("\n"));
    const verifier = new ClaudeVerifier({ binary });

    await expect(verifier.verify(criteria(), evidence())).rejects.toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "verifier_invalid_response" })
    );
  });

  it("throws a typed error when the CLI reports an error subtype", async () => {
    const binary = writeFixture(
      [
        "#!/usr/bin/env node",
        `process.stdout.write(${JSON.stringify(
          JSON.stringify({ type: "result", subtype: "error_max_budget_usd", is_error: true, result: "" })
        )});`
      ].join("\n")
    );
    const verifier = new ClaudeVerifier({ binary });

    await expect(verifier.verify(criteria(), evidence())).rejects.toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "verifier_invalid_response" })
    );
  });

  it("never exposes a planted secret env var to the spawned verifier process", async () => {
    const binary = writeFixture(
      [
        "#!/usr/bin/env node",
        "const secretLeaked = 'TOTALLY_FAKE_SECRET' in process.env;",
        `const envelope = ${JSON.stringify(claudeEnvelope({ verdict: "pass", summary: "s", criteriaResults: [] }))};`,
        "const parsed = JSON.parse(envelope);",
        "parsed.result = JSON.stringify({ verdict: 'pass', summary: String(secretLeaked), criteriaResults: [{criterionId:'c1',satisfied:true,observed:'x'}] });",
        "process.stdout.write(JSON.stringify(parsed));"
      ].join("\n")
    );
    const originalEnv = process.env;
    process.env = { ...originalEnv, TOTALLY_FAKE_SECRET: "should-never-reach-child" } as NodeJS.ProcessEnv;
    try {
      const verifier = new ClaudeVerifier({ binary });
      const result = await verifier.verify(criteria(), evidence());
      expect(result.summary).toBe("false");
    } finally {
      process.env = originalEnv;
    }
  });

  it("times out and throws rather than hanging when the CLI never responds", async () => {
    const binary = writeFixture(["#!/usr/bin/env node", "setTimeout(() => {}, 5000);"].join("\n"));
    const verifier = new ClaudeVerifier({ binary, timeoutMs: 200 });

    await expect(verifier.verify(criteria(), evidence())).rejects.toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "verifier_timeout" })
    );
  });
});
