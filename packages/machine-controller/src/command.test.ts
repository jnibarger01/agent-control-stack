import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runReadonlyCommand } from "./command.js";
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
});

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
    commands: { allowReadonly: ["git"], deny: [] },
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
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
  // kill(pid, 0) succeeds for a zombie: the kernel keeps the PID allocated until
  // its parent reaps it. This sandbox's PID 1 is not a reaping init, so a killed
  // descendant can sit as a zombie indefinitely. Treat "zombie" as "not alive" -
  // the process has already terminated, it just hasn't been waited on yet.
  return processState(pid) !== "Z";
}

function processState(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterComm = stat.slice(stat.lastIndexOf(")") + 1).trim();
    return afterComm.split(" ")[0];
  } catch {
    return undefined;
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
