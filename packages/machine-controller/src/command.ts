import { spawn } from "node:child_process";
import { ControlStackError, redactValue } from "@agent-control-stack/shared";
import { z } from "zod";
import type { MachineControllerConfig } from "./config.js";
import { resolveSafePath } from "./path.js";

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

const defaultDeniedCommands = new Set(["rm", "shred", "mkfs", "dd", "chmod", "chown", "sudo"]);
const shellMetaPattern = /[;&|`$<>]/;

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
  if (isKnownReadonly(command, args) && config.commands.allowReadonly.includes(command)) {
    return { cwd, command, args, risk: "read_only", reason: "command is an allowed read-only diagnostic" };
  }

  return { cwd, command, args, risk: "forbidden", reason: "no read-only allow rule matched" };
}

export async function runReadonlyCommand(config: MachineControllerConfig, input: unknown): Promise<CommandRunResult> {
  const preview = previewCommand(config, input);
  if (preview.risk !== "read_only") {
    throw new ControlStackError("command_refused", `command refused: ${preview.reason}`);
  }

  const started = Date.now();
  return await new Promise((resolvePromise) => {
    const child = spawn(preview.command, preview.args, {
      cwd: preview.cwd,
      env: filteredEnv(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, config.security.commandTimeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk.toString("utf8"), config.security.maxOutputBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk.toString("utf8"), config.security.maxOutputBytes);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({
        preview,
        exitCode: null,
        stdout: redactText(stdout),
        stderr: redactText(`${stderr}${stderr ? "\n" : ""}${error.message}`),
        timedOut,
        durationMs: Date.now() - started
      });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolvePromise({
        preview,
        exitCode,
        stdout: redactText(stdout),
        stderr: redactText(stderr),
        timedOut,
        durationMs: Date.now() - started
      });
    });
  });
}

function isKnownReadonly(command: string, args: string[]): boolean {
  return (
    (command === "git" && ["status", "diff", "log", "show"].includes(args[0] ?? "")) ||
    (command === "npm" && args[0] === "test") ||
    (command === "npm" && args[0] === "run" && ["test", "check", "typecheck"].includes(args[1] ?? "")) ||
    (command === "pnpm" && ["test", "run"].includes(args[0] ?? "")) ||
    (command === "bun" && ["test", "--version"].includes(args[0] ?? "")) ||
    (command === "node" && ["--version", "-v"].includes(args[0] ?? "")) ||
    (command === "python3" && ["--version", "-V"].includes(args[0] ?? "")) ||
    (command === "docker" && args[0] === "ps") ||
    (command === "df" && ["", "-h"].includes(args[0] ?? "")) ||
    (command === "free" && ["", "-h"].includes(args[0] ?? ""))
  );
}

function isMutation(command: string, args: string[]): boolean {
  return (
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
  return Buffer.byteLength(combined, "utf8") <= maxBytes ? combined : combined.slice(0, maxBytes) + "\n[truncated]";
}

function filteredEnv(): NodeJS.ProcessEnv {
  return {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    SHELL: process.env.SHELL,
    TMPDIR: process.env.TMPDIR,
    USER: process.env.USER
  };
}

function redactText(value: string): string {
  const redacted = redactValue(value);
  return typeof redacted === "string" ? redacted : String(redacted);
}
