import { spawn } from "node:child_process";
import { ControlStackError, redactValue } from "@agent-control-stack/shared";
import { z } from "zod";
import type { MachineControllerConfig } from "./config.js";
import { subprocessEnv } from "./command.js";
import { resolveSafePath } from "./path.js";

export const directAgentNames = ["pi", "openclaw", "codex", "claude", "gemini", "opencode"] as const;
export type DirectAgentName = (typeof directAgentNames)[number];
export type DirectAgentPermissionMode = "read-only";

const directAgentInputSchema = z
  .object({
    agent: z.enum(directAgentNames),
    prompt: z.string().min(1),
    cwd: z.string().min(1).optional(),
    timeoutSeconds: z.number().int().positive().max(3_600).optional(),
    permissionMode: z.string().min(1).optional().default("read-only")
  })
  .passthrough();

export interface DirectAgentRunnerRequest {
  agent: DirectAgentName;
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  permissionMode: DirectAgentPermissionMode;
  maxOutputBytes: number;
}

export interface DirectAgentRunnerResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

export type DirectAgentRunner = (request: DirectAgentRunnerRequest) => Promise<DirectAgentRunnerResult>;

export interface DirectAgentResult {
  ok: boolean;
  agent: DirectAgentName;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  error: string | null;
}

export interface SanitizedDirectAgentAuditArgs {
  agent?: string;
  cwd?: string;
  timeoutSeconds?: number;
  permissionMode?: string;
  promptLength?: number;
  promptPreview?: string;
}

export async function runDirectAgent(
  config: MachineControllerConfig,
  input: unknown,
  runner: DirectAgentRunner = spawnDirectAgent
): Promise<DirectAgentResult> {
  const parsed = directAgentInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ControlStackError("agent_run_invalid_payload", "invalid test.agent.run payload");
  }

  const prompt = parsed.data.prompt;
  if (prompt.trim().length === 0) {
    throw new ControlStackError("agent_prompt_required", "test.agent.run requires a non-empty prompt");
  }

  const permissionMode = normalizePermissionMode(parsed.data.permissionMode);
  const cwd = resolveSafePath(config, parsed.data.cwd ?? config.paths.allow[0]).realPath;
  const timeoutMs = parsed.data.timeoutSeconds ? parsed.data.timeoutSeconds * 1_000 : config.security.commandTimeoutMs;
  const started = Date.now();

  try {
    const commandSpec = directAgentCommand(parsed.data.agent, prompt, permissionMode);
    const result = await runner({
      agent: parsed.data.agent,
      command: commandSpec.command,
      args: commandSpec.args,
      cwd,
      timeoutMs,
      permissionMode,
      maxOutputBytes: config.security.maxOutputBytes
    });
    const ok = result.exitCode === 0;
    const stdout = redactText(result.stdout);
    const stderr = redactText(result.stderr);
    return {
      ok,
      agent: parsed.data.agent,
      stdout,
      stderr,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      error: ok ? null : stderr || `agent exited with code ${result.exitCode}`
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown agent execution error";
    return {
      ok: false,
      agent: parsed.data.agent,
      stdout: "",
      stderr: redactText(message),
      exitCode: null,
      durationMs: Date.now() - started,
      error: redactText(message)
    };
  }
}

export function sanitizeDirectAgentAuditArgs(input: unknown): SanitizedDirectAgentAuditArgs {
  const value = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const prompt = typeof value.prompt === "string" ? value.prompt : undefined;
  return {
    agent: typeof value.agent === "string" ? value.agent : undefined,
    cwd: typeof value.cwd === "string" ? value.cwd : undefined,
    timeoutSeconds: typeof value.timeoutSeconds === "number" ? value.timeoutSeconds : undefined,
    permissionMode: typeof value.permissionMode === "string" ? value.permissionMode : undefined,
    promptLength: prompt?.length,
    promptPreview: prompt ? redactText(prompt.slice(0, 120)) : undefined
  };
}

function normalizePermissionMode(value: string): DirectAgentPermissionMode {
  const normalized = value.toLowerCase().replace(/_/g, "-");
  if (normalized === "read-only" || normalized === "readonly") {
    return "read-only";
  }
  throw new ControlStackError(
    "agent_permission_denied",
    "test.agent.run defaults to no writes; write-capable direct runs require a separate approval path"
  );
}

function directAgentCommand(
  agent: DirectAgentName,
  prompt: string,
  permissionMode: DirectAgentPermissionMode
): { command: string; args: string[] } {
  const commandOverride = process.env[`ACS_DIRECT_AGENT_${agent.toUpperCase()}_COMMAND`]?.trim();
  const argsOverride = process.env[`ACS_DIRECT_AGENT_${agent.toUpperCase()}_ARGS_JSON`];
  if (commandOverride) {
    return { command: commandOverride, args: [...parseArgsOverride(argsOverride), prompt] };
  }

  switch (agent) {
    case "codex":
      return { command: "codex", args: ["exec", "--sandbox", permissionMode, prompt] };
    case "claude":
      return { command: "claude", args: ["-p", prompt] };
    case "gemini":
      return { command: "gemini", args: ["-p", prompt] };
    case "opencode":
      return { command: "opencode", args: ["run", prompt] };
    case "openclaw":
      return { command: "openclaw", args: [prompt] };
    case "pi":
      return { command: "pi", args: [prompt] };
  }
}

function parseArgsOverride(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) {
      return parsed;
    }
  } catch {
    // Fall through to the explicit configuration error below.
  }
  throw new ControlStackError("agent_command_invalid", "direct agent args override must be a JSON string array");
}

async function spawnDirectAgent(request: DirectAgentRunnerRequest): Promise<DirectAgentRunnerResult> {
  const started = Date.now();
  return await new Promise((resolvePromise) => {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: subprocessEnv(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    }, request.timeoutMs);

    const settle = (result: Omit<DirectAgentRunnerResult, "durationMs">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolvePromise({ ...result, durationMs: Date.now() - started });
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk.toString("utf8"), request.maxOutputBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk.toString("utf8"), request.maxOutputBytes);
    });
    child.on("error", (error) => {
      settle({ stdout, stderr: `${stderr}${stderr ? "\n" : ""}${error.message}`, exitCode: null });
    });
    child.on("close", (exitCode) => {
      settle({
        stdout,
        stderr: timedOut ? `${stderr}${stderr ? "\n" : ""}agent execution timed out` : stderr,
        exitCode: timedOut ? null : exitCode
      });
    });
  });
}

function appendCapped(current: string, next: string, maxBytes: number): string {
  const combined = current + next;
  return Buffer.byteLength(combined, "utf8") <= maxBytes ? combined : `${combined.slice(0, maxBytes)}\n[truncated]`;
}

function redactText(value: string): string {
  const redacted = redactValue(value);
  return typeof redacted === "string" ? redacted : String(redacted);
}
