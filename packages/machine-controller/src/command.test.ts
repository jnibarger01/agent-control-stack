import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { previewCommand, runReadonlyCommand } from "./command.js";
import type { MachineControllerConfig } from "./config.js";

describe("read-only command process cleanup", () => {
  let descendantPid: number | undefined;
  let originalPath: string | undefined;

  afterEach(() => {
    if (descendantPid !== undefined && processExists(descendantPid)) {
      process.kill(descendantPid, "SIGKILL");
    }
    descendantPid = undefined;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });

  it.skipIf(process.platform === "win32")(
    "kills a SIGTERM-resistant descendant after the timeout grace period",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "acs-command-tree-"));
      const bin = join(directory, "bin");
      const pidFile = join(directory, "descendant.pid");
      const fakeGit = join(bin, "git");
      try {
        mkdirSync(bin);
        writeFileSync(fakeGit, fixtureCommand(pidFile));
        chmodSync(fakeGit, 0o700);
        originalPath = process.env.PATH;
        process.env.PATH = `${bin}:${originalPath ?? ""}`;

        const run = runReadonlyCommand(config(directory), {
          cwd: directory,
          command: "git",
          args: ["status"]
        });
        await waitForFile(pidFile);
        descendantPid = Number(readFileSync(pidFile, "utf8"));
        const result = await run;
        expect(result.timedOut).toBe(true);
        expect(existsSync(pidFile)).toBe(true);

        await waitForProcessExit(descendantPid);
        expect(processExists(descendantPid)).toBe(false);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    5_000
  );

  it("rejects unreviewed Git arguments that can write or inject configuration", () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-command-args-"));
    try {
      const machineConfig = config(directory);
      const rejected = [
        ["log", "--output=/tmp/acs-readonly-output"],
        ["show", "--output=/tmp/acs-readonly-output"],
        ["-c", "core.pager=cat", "log"],
        ["-c", "diff.external=helper", "diff"],
        ["diff", "--external-diff"],
        ["diff", "--textconv"],
        ["log", "--format=%(exec:touch /tmp/acs-readonly-helper)"],
        ["log", "$(touch", "/tmp/acs-readonly-helper)"]
      ];

      for (const args of rejected) {
        expect(runPreview(machineConfig, args).risk, args.join(" ")).toBe("forbidden");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps accepted Git inspection observational despite repository config, pager, and diff helpers", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-command-manifest-"));
    const repo = join(directory, "repo");
    const marker = join(directory, "helper-ran");
    mkdirSync(repo);
    writeFileSync(join(repo, "README.md"), "initial\n");
    execFileSync("git", ["init", "--quiet", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "ACS test"]);
    execFileSync("git", ["-C", repo, "add", "README.md"]);
    execFileSync("git", ["-C", repo, "commit", "--quiet", "-m", "initial"]);
    writeFileSync(
      join(repo, "helper.mjs"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed");\n`
    );
    execFileSync("git", ["-C", repo, "config", "core.pager", `${process.execPath} ${join(repo, "helper.mjs")}`]);
    execFileSync("git", ["-C", repo, "config", "diff.external", `${process.execPath} ${join(repo, "helper.mjs")}`]);
    writeFileSync(join(repo, "README.md"), "changed\n");

    try {
      const machineConfig = config(directory);
      machineConfig.paths.allow = [repo];
      const accepted = ["status", "diff", "log", "show"];
      for (const subcommand of accepted) {
        const before = manifest(repo);
        const result = await runReadonlyCommand(machineConfig, { cwd: repo, command: "git", args: [subcommand] });
        const after = manifest(repo);
        expect(result.exitCode, subcommand).toBe(0);
        expect(after, subcommand).toBe(before);
        expect(existsSync(marker), subcommand).toBe(false);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);
});

function runPreview(machineConfig: MachineControllerConfig, args: string[]) {
  return previewCommand(machineConfig, { cwd: machineConfig.paths.allow[0], command: "git", args });
}

function manifest(root: string): string {
  const entries: string[] = [];
  visit(root);
  return entries.join("\n");

  function visit(path: string): void {
    const stat = lstatSync(path);
    const name = relative(root, path) || ".";
    if (stat.isSymbolicLink()) {
      entries.push(`${name}|symlink|${readlinkSync(path)}`);
      return;
    }
    if (stat.isDirectory()) {
      entries.push(`${name}|directory|${stat.mode}`);
      for (const child of readdirSync(path).sort()) visit(join(path, child));
      return;
    }
    entries.push(`${name}|file|${stat.mode}|${stat.size}|${readFileSync(path).toString("base64")}`);
  }
}

function config(directory: string): MachineControllerConfig {
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
    commands: { allowReadonly: ["git"], deny: [], executablePaths: [join(directory, "bin"), "/usr/local/bin", "/usr/bin", "/bin"] },
    audit: { logPath: join(directory, "audit.jsonl") }
  };
}

function fixtureCommand(pidFile: string): string {
  return `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
  stdio: "ignore"
});
writeFileSync(${JSON.stringify(pidFile)}, String(descendant.pid));
setInterval(() => {}, 1000);
`;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForFile(path: string, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for fixture PID file: ${path}`);
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
