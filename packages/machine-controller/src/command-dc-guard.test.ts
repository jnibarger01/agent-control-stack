import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { previewCommand } from "./command.js";
import type { MachineControllerConfig } from "./config.js";

function config(directory: string, allowReadonly: string[] = ["git", "node", "npx"]): MachineControllerConfig {
  return {
    server: { name: "test", transport: "stdio", version: "0.1.0" },
    security: {
      defaultPolicy: "deny",
      requireApprovalForMutations: true,
      redactSecrets: true,
      maxOutputBytes: 20_000,
      commandTimeoutMs: 100,
      commandTerminationGraceMs: 100
    },
    paths: { allow: [directory], deny: [] },
    commands: { allowReadonly, deny: [] },
    audit: { logPath: join(directory, "audit.jsonl") }
  };
}

describe("ADR-0016 Slice 5: previewCommand refuses Desktop Commander bypass via cmd.run", () => {
  it("forbids invoking the desktop-commander executable directly, even with node/npx allowlisted", () => {
    const dir = mktemp();
    try {
      const preview = previewCommand(config(dir), { cwd: dir, command: "desktop-commander", args: [] });
      expect(preview.risk).toBe("forbidden");
      expect(preview.reason).toMatch(/Desktop Commander/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("forbids npx pulling the scoped Desktop Commander package", () => {
    const dir = mktemp();
    try {
      const preview = previewCommand(config(dir), {
        cwd: dir,
        command: "npx",
        args: ["-y", "@wonderwhy-er/desktop-commander@latest"]
      });
      expect(preview.risk).toBe("forbidden");
      expect(preview.reason).toMatch(/Desktop Commander/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("forbids node pointed directly at a Desktop Commander build, even though node is allowlisted", () => {
    const dir = mktemp();
    try {
      const preview = previewCommand(config(dir), {
        cwd: dir,
        command: "node",
        args: ["/home/jacen/projects/desktop-commander/dist/index.js"]
      });
      expect(preview.risk).toBe("forbidden");
      expect(preview.reason).toMatch(/Desktop Commander/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not forbid an unrelated, genuinely allowed read-only command", () => {
    const dir = mktemp();
    try {
      const preview = previewCommand(config(dir), { cwd: dir, command: "git", args: ["status"] });
      expect(preview.risk).toBe("read_only");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not forbid plain node --version even with node allowlisted", () => {
    const dir = mktemp();
    try {
      const preview = previewCommand(config(dir), { cwd: dir, command: "node", args: ["--version"] });
      expect(preview.risk).toBe("read_only");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function mktemp(): string {
  return mkdtempSync(join(tmpdir(), "acs-dc-guard-preview-"));
}
