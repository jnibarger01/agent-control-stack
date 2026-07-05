import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStackError } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";
import { previewCommand } from "./command.js";
import { loadMachineControllerConfig } from "./config.js";
import { MachineController } from "./controller.js";
import { resolveSafePath } from "./path.js";

describe("machine controller", () => {
  it("fails closed when config is missing", () => {
    expect(() => loadMachineControllerConfig(undefined)).toThrow(ControlStackError);
  });

  it("enforces allowed roots and blocks symlink escapes", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-machine-"));
    const allowed = join(dir, "allowed");
    const outside = join(dir, "outside");
    mkdirSync(allowed);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(join(outside, "secret.txt"), join(allowed, "link.txt"));
    const config = writeConfig(dir, allowed);

    try {
      expect(resolveSafePath(config, join(allowed, "."))).toMatchObject({ realPath: allowed });
      expect(() => resolveSafePath(config, join(allowed, "link.txt"))).toThrow(ControlStackError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads files with line numbers and redacts secrets before returning or logging", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-machine-"));
    const allowed = join(dir, "allowed");
    mkdirSync(allowed);
    writeFileSync(join(allowed, "notes.txt"), "hello\nOPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456\nbye\n");
    const config = writeConfig(dir, allowed);
    const controller = new MachineController(config);

    try {
      const result = (await controller.callTool("fs.read", { path: join(allowed, "notes.txt"), start_line: 1 })) as {
        text: string;
      };

      expect(result.text).toContain("1: hello");
      expect(result.text).toContain("[redacted]");
      expect(result.text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
      expect(readFileSync(config.audit.logPath, "utf8")).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("classifies commands without executing them", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-machine-"));
    const allowed = join(dir, "allowed");
    mkdirSync(allowed);
    const config = writeConfig(dir, allowed);

    try {
      expect(previewCommand(config, { cwd: allowed, command: "git", args: ["status"] }).risk).toBe("read_only");
      expect(previewCommand(config, { cwd: allowed, command: "npm", args: ["install"] }).risk).toBe("requires_approval");
      expect(previewCommand(config, { cwd: allowed, command: "rm", args: ["-rf", "/"] }).risk).toBe("forbidden");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs only read-only commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-machine-"));
    const allowed = join(dir, "allowed");
    mkdirSync(allowed);
    const config = writeConfig(dir, allowed);
    const controller = new MachineController(config);

    try {
      const ran = (await controller.callTool("cmd.run", { cwd: allowed, command: "node", args: ["--version"] })) as {
        exitCode: number | null;
        stdout: string;
      };
      expect(ran.exitCode).toBe(0);
      expect(ran.stdout).toMatch(/^v/);
      await expect(controller.callTool("cmd.run", { cwd: allowed, command: "npm", args: ["install"] })).rejects.toThrow(
        ControlStackError
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function writeConfig(dir: string, allowed: string) {
  const configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      paths: { allow: [allowed], deny: [join(dir, "outside")] },
      commands: { allow_readonly: ["git", "npm", "node"], deny: ["rm", "sudo"] },
      audit: { log_path: join(dir, "audit.jsonl") }
    })
  );
  return loadMachineControllerConfig(configPath);
}
