import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { ControlStackError, redactValue } from "@agent-control-stack/shared";
import { z } from "zod";
import type { MachineControllerConfig } from "./config.js";
import { resolveSafePath } from "./path.js";
import { resolveRegisteredCommand } from "./registry.js";

export const riskLevelSchema = z.enum(["read_only", "safe_mutation", "requires_approval", "destructive", "forbidden"]);
export type RiskLevel = z.infer<typeof riskLevelSchema>;

export const commandInputSchema = z.object({
  cwd: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([])
});

export interface CommandPreview {
  cwd: string;
  command: string;
  args: string[];
  risk: RiskLevel;
  reason: string;
}

export interface CommandRunResult {
  preview: CommandPreview;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface RegisteredCommandPreview extends CommandPreview {
  commandId: string;
  version: string;
}

export interface RegisteredCommandRunResult {
  commandId: string;
  version: string;
  invocation: { cwd: string; command: string; args: string[] };
  result: CommandRunResult;
}

const defaultDeniedCommands = new Set(["rm", "shred", "mkfs", "dd", "chmod", "chown", "sudo"]);
const shellMetaPattern = /[;&|`$<>]/;
export const subprocessEnvAllowlist = ["HOME", "PATH", "SHELL", "TMPDIR", "USER"] as const;

export function previewCommand(config: MachineControllerConfig, input: unknown): CommandPreview {
  const parsed = commandInputSchema.parse(input);
  const cwd = resolveSafePath(config, parsed.cwd).realPath;
  const command = parsed.command;
  const args = parsed.args;
  const deny = new Set([...defaultDeniedCommands, ...config.commands.deny]);

  if (command.includes("/") || shellMetaPattern.test(command) || args.some((arg) => shellMetaPattern.test(arg))) {
    return { cwd, command, args, risk: "forbidden", reason: "shell paths and metacharacters are forbidden" };
  }
  if (deny.has(command) || args.includes("sudo")) {
    return { cwd, command, args, risk: "forbidden", reason: "command is denied by policy" };
  }
  if (isDestructive(command, args)) {
    return { cwd, command, args, risk: "destructive", reason: "command is destructive" };
  }
  if (isMutation(command, args)) {
    return { cwd, command, args, risk: "requires_approval", reason: "command can mutate local state" };
  }
  if (config.commands.allowReadonly.includes(command) && isKnownReadonly(command, args)) {
    return { cwd, command, args, risk: "read_only", reason: "command is an allowed read-only diagnostic" };
  }

  return { cwd, command, args, risk: "forbidden", reason: "no read-only allow rule matched" };
}

export function previewRegisteredCommand(config: MachineControllerConfig, input: unknown): RegisteredCommandPreview {
  const resolved = resolveRegisteredCommand(config, input);
  const preview = previewCommand(config, {
    cwd: resolved.cwd,
    command: resolved.command,
    args: resolved.args
  });
  return { commandId: resolved.commandId, version: resolved.version, ...preview };
}

export async function runRegisteredCommand(config: MachineControllerConfig, input: unknown): Promise<RegisteredCommandRunResult> {
  const resolved = resolveRegisteredCommand(config, input);
  const result = await runReadonlyCommand(config, {
    cwd: resolved.cwd,
    command: resolved.command,
    args: resolved.args
  });
  return {
    commandId: resolved.commandId,
    version: resolved.version,
    invocation: { cwd: resolved.cwd, command: resolved.command, args: resolved.args },
    result
  };
}

export async function runReadonlyCommand(config: MachineControllerConfig, input: unknown): Promise<CommandRunResult> {
  const preview = previewCommand(config, input);
  if (preview.risk !== "read_only") {
    throw new ControlStackError("command_refused", `command refused: ${preview.reason}`);
  }

  const started = Date.now();
  return await new Promise((resolvePromise) => {
    const useProcessGroup = process.platform !== "win32";
    const isolatedHome = mkdtempSync(join(tmpdir(), "acs-command-home-"));
    const child = spawn(preview.command, readonlyInvocationArgs(preview), {
      cwd: preview.cwd,
      env: readonlySubprocessEnv(config, isolatedHome),
      detached: useProcessGroup,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let childClosed = false;
    let closeExitCode: number | null = null;
    let escalationSent = false;
    let spawnError: Error | undefined;
    let terminationError: Error | undefined;
    let escalationTimer: NodeJS.Timeout | undefined;
    let completionTimer: NodeJS.Timeout | undefined;

    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (escalationTimer) clearTimeout(escalationTimer);
      if (completionTimer) clearTimeout(completionTimer);
      rmSync(isolatedHome, { recursive: true, force: true });
      const error = spawnError ?? terminationError;
      resolvePromise({
        preview,
        exitCode: closeExitCode,
        stdout: redactText(stdout),
        stderr: redactText(`${stderr}${error ? `${stderr ? "\n" : ""}${error.message}` : ""}`),
        timedOut,
        durationMs: Date.now() - started
      });
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminationError = signalCommandTree(child.pid, useProcessGroup, "SIGTERM");
      escalationTimer = setTimeout(() => {
        escalationSent = true;
        const escalationError = signalCommandTree(child.pid, useProcessGroup, "SIGKILL");
        terminationError = escalationError ?? terminationError;
        if (childClosed || escalationError) {
          settle();
          return;
        }
        completionTimer = setTimeout(
          () => {
            terminationError ??= new Error("command process tree did not exit after SIGKILL");
            settle();
          },
          Math.min(config.security.commandTerminationGraceMs, 1_000)
        );
      }, config.security.commandTerminationGraceMs);
    }, config.security.commandTimeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk.toString("utf8"), config.security.maxOutputBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk.toString("utf8"), config.security.maxOutputBytes);
    });
    child.on("error", (error) => {
      spawnError = error;
      if (child.pid === undefined) settle();
    });
    child.on("close", (exitCode) => {
      childClosed = true;
      closeExitCode = exitCode;
      if (
        !timedOut ||
        !useProcessGroup ||
        escalationSent ||
        child.pid === undefined ||
        !processGroupExists(child.pid)
      ) {
        settle();
      }
    });
  });
}

function signalCommandTree(
  pid: number | undefined,
  useProcessGroup: boolean,
  signal: NodeJS.Signals
): Error | undefined {
  if (pid === undefined) return undefined;
  try {
    process.kill(useProcessGroup ? -pid : pid, signal);
    return undefined;
  } catch (error) {
    return hasErrorCode(error, "ESRCH") ? undefined : asError(error);
  }
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !hasErrorCode(error, "ESRCH");
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isKnownReadonly(command: string, args: string[]): boolean {
  if (command === "uname") return args.length === 1 && args[0] === "-a";
  if (command === "git") {
    const subcommand = args[0];
    const flags = args.slice(1);
    const reviewedFlags: Record<string, readonly string[]> = {
      status: ["--short", "--porcelain", "--branch", "--untracked-files=no", "--no-renames"],
      diff: ["--stat", "--name-only", "--name-status", "--check", "--cached", "--staged"],
      log: ["--oneline", "--decorate", "--no-decorate", "--stat", "--no-patch"],
      show: ["--stat", "--no-patch", "--oneline", "--no-decorate"],
      "rev-parse": ["HEAD"]
    };
    return (
      typeof subcommand === "string" &&
      Object.hasOwn(reviewedFlags, subcommand) &&
      flags.every((flag) => reviewedFlags[subcommand]?.includes(flag))
    );
  }
  if (command === "bun") return args.length === 1 && args[0] === "--version";
  if (command === "node") return args.length === 1 && ["--version", "-v"].includes(args[0] ?? "");
  if (command === "python3") return args.length === 1 && ["--version", "-V"].includes(args[0] ?? "");
  if (command === "docker") {
    return (
      (args.length === 1 && args[0] === "ps") ||
      args.join(" ") === "ps --no-trunc" ||
      args.join(" ") === "system df"
    );
  }
  if (command === "df") return args.length <= 1 && [undefined, "-h"].includes(args[0]);
  if (command === "free") return args.length <= 1 && [undefined, "-h"].includes(args[0]);
  if (command === "systemctl") {
    return args.join(" ") === "--user --failed --no-legend --no-pager";
  }
  if (command === "tailscale") return args.length === 1 && args[0] === "status";
  if (command === "apt") return args.length === 2 && args[0] === "list" && args[1] === "--upgradable";
  if (command === "journalctl") {
    return args.join(" ") === "--user -n 100 --no-pager -o short-iso";
  }
  if (command === "lsblk") return args.length === 2 && args[0] === "-o" && args[1] === "NAME,SIZE,TYPE,MOUNTPOINT";
  return false;
}

function isMutation(command: string, args: string[]): boolean {
  return (
    (command === "npm" && (args[0] === "test" || args[0] === "run")) ||
    (command === "pnpm" && (args[0] === "test" || args[0] === "run")) ||
    (command === "bun" && args[0] === "test") ||
    (command === "npm" && ["install", "i", "update"].includes(args[0] ?? "")) ||
    (command === "pnpm" && ["add", "install", "update"].includes(args[0] ?? "")) ||
    (command === "git" && ["commit", "push", "merge", "rebase", "checkout", "switch"].includes(args[0] ?? "")) ||
    (command === "docker" && ["restart", "stop", "rm", "run", "compose"].includes(args[0] ?? "")) ||
    (command === "systemctl" && ["restart", "stop", "start"].includes(args[0] ?? ""))
  );
}

function isDestructive(command: string, args: string[]): boolean {
  return command === "rm" || command === "dd" || command === "mkfs" || args.includes("--force");
}

function appendCapped(current: string, next: string, maxBytes: number): string {
  const combined = current + next;
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined;
  return `${Buffer.from(combined, "utf8").subarray(0, maxBytes).toString("utf8")}\n[truncated]`;
}

export function subprocessEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(subprocessEnvAllowlist.map((name) => [name, source[name]]));
}

function readonlySubprocessEnv(config: MachineControllerConfig, isolatedHome: string): NodeJS.ProcessEnv {
  return {
    HOME: isolatedHome,
    PATH: (config.commands.executablePaths ?? ["/usr/local/bin", "/usr/bin", "/bin"]).join(delimiter),
    SHELL: "/bin/sh",
    TMPDIR: isolatedHome,
    USER: "acs-readonly",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_LOCAL: "/dev/null",
    GIT_CONFIG_WORKTREE: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    PAGER: "cat",
    LESS: "-FRX",
    NO_COLOR: "1"
  };
}

function readonlyInvocationArgs(preview: CommandPreview): string[] {
  if (preview.command === "git" && ["diff", "show"].includes(preview.args[0] ?? "")) {
    return [preview.args[0]!, "--no-ext-diff", "--no-textconv", ...preview.args.slice(1)];
  }
  return preview.args;
}

function redactText(value: string): string {
  const redacted = redactValue(value);
  return typeof redacted === "string" ? redacted : String(redacted);
}
