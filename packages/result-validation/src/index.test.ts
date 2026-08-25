import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineOutcome } from "@agent-control-stack/engine-adapter";
import { ResultValidator } from "./index.js";

const success: EngineOutcome = { status: "completed", exitCode: 0, stdout: "", stderr: "", durationMs: 1, stdoutTruncated: false, stderrTruncated: false };
const runner = (files: string[], commandExit = 0) => async (command: string[]) => {
  if (command[1] === "diff") return { stdout: files.join("\n"), stderr: "", exitCode: 0 };
  return { stdout: "check output", stderr: commandExit ? "failed" : "", exitCode: commandExit };
};

describe("ResultValidator", () => {
  it("rejects agent-reported success when a forbidden path changed", async () => {
    const result = await new ResultValidator().validate({
      workspacePath: "/workspace",
      outcome: success,
      forbiddenPaths: [".env"],
      commandRunner: runner(["src/index.ts", ".env"])
    });

    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.name === "forbidden_paths")?.passed).toBe(false);
  });

  it("rejects a failed independent test command", async () => {
    const result = await new ResultValidator().validate({
      workspacePath: "/workspace",
      outcome: success,
      allowedPaths: ["src"],
      commands: [["npm", "test"]],
      commandRunner: runner(["src/index.ts"], 1)
    });

    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.name === "command:npm")?.stderr).toBe("failed");
  });

  it("passes when outcome, change boundary, and independent checks pass", async () => {
    const result = await new ResultValidator().validate({
      workspacePath: "/workspace",
      outcome: success,
      allowedPaths: ["src"],
      commands: [["npm", "test"]],
      commandRunner: runner(["src/index.ts"])
    });

    expect(result.passed).toBe(true);
  });

  it("fails closed when git diff inspection fails", async () => {
    const result = await new ResultValidator().validate({
      workspacePath: "/workspace",
      outcome: success,
      commandRunner: async () => ({ stdout: "", stderr: "git unavailable", exitCode: 127 })
    });

    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.name === "git_diff")?.passed).toBe(false);
  });

  describe("expectedArtifacts path containment", () => {
    let workspace: string;

    afterEach(() => {
      if (workspace) rmSync(workspace, { recursive: true, force: true });
    });

    it("rejects an absolute artifact path instead of probing the real filesystem", async () => {
      workspace = mkdtempSync(join(tmpdir(), "acs-validation-"));
      const result = await new ResultValidator().validate({
        workspacePath: workspace,
        outcome: success,
        expectedArtifacts: ["/etc/hostname"],
        commandRunner: runner([])
      });

      const check = result.checks.find((entry) => entry.name === "artifact:/etc/hostname");
      expect(check?.passed).toBe(false);
      expect(check?.detail).toBe("artifact path escapes workspace");
      expect(result.passed).toBe(false);
    });

    it("rejects a relative artifact path that traverses out of the workspace", async () => {
      workspace = mkdtempSync(join(tmpdir(), "acs-validation-"));
      const result = await new ResultValidator().validate({
        workspacePath: workspace,
        outcome: success,
        expectedArtifacts: ["../outside.txt"],
        commandRunner: runner([])
      });

      const check = result.checks.find((entry) => entry.name === "artifact:../outside.txt");
      expect(check?.passed).toBe(false);
      expect(check?.detail).toBe("artifact path escapes workspace");
    });

    it("accepts an artifact that exists inside the workspace", async () => {
      workspace = mkdtempSync(join(tmpdir(), "acs-validation-"));
      writeFileSync(join(workspace, "report.txt"), "ok");
      const result = await new ResultValidator().validate({
        workspacePath: workspace,
        outcome: success,
        expectedArtifacts: ["report.txt"],
        commandRunner: runner([])
      });

      const check = result.checks.find((entry) => entry.name === "artifact:report.txt");
      expect(check?.passed).toBe(true);
      expect(check?.detail).toBe("artifact exists");
    });
  });
});
