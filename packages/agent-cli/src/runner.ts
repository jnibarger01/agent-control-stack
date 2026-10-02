import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { redactValue, ControlStackError } from "@agent-control-stack/shared";
import { agentCliSpec, type AgentCliSpec, type AgentRunMode } from "./catalog.js";
import { resolveBinary } from "./probe.js";

export const MAX_PROMPT_CHARS = 32_000;
export const DEFAULT_RUN_TIMEOUT_SEC = 900;
export const MAX_RUN_TIMEOUT_SEC = 3_600;
export const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

/** Variables every CLI needs. Everything else is dropped unless the CLI's spec allows its prefix. */
const BASE_ENV = ["HOME", "PATH", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR", "TZ"] as const;
const BASE_ENV_PREFIXES = ["XDG_"] as const;

/**
 * Build the child's environment: a small base plus the provider variables for this one CLI.
 * ACS secrets (ACS_*), other tools' tokens and unrelated API keys never reach the agent.
 */
export function agentEnv(spec: AgentCliSpec, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || name.startsWith("ACS_")) continue;
    const allowed =
      (BASE_ENV as readonly string[]).includes(name) ||
      BASE_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
      spec.envPassthrough.some((prefix) => name.startsWith(prefix));
    if (allowed) env[name] = value;
  }
  return env;
}

export interface AgentCommand {
  agentId: string;
  binaryPath: string;
  args: string[];
  mode: AgentRunMode;
  timeoutSec: number;
  /** Hash of agent, mode, cwd, timeout and prompt. What the operator confirmed is what runs. */
  commandHash: string;
}

export function planAgentCommand(input: {
  agentId: string;
  prompt: string;
  mode: AgentRunMode;
  cwd: string;
  timeoutSec?: number;
  pathValue?: string;
  /** Connection tests may run a blocked CLI to see whether the block has cleared. */
  allowBlocked?: boolean;
}): AgentCommand {
  const spec = agentCliSpec(input.agentId);
  if (!spec) throw new ControlStackError("agent_not_supported", `unknown agent CLI: ${input.agentId}`);
  if (spec.dispatchBlockedReason && !input.allowBlocked) {
    throw new ControlStackError(
      "agent_dispatch_blocked",
      `${spec.id} is not dispatchable: ${spec.dispatchBlockedReason}`
    );
  }
  const prompt = input.prompt.trim();
  if (!prompt) throw new ControlStackError("agent_prompt_required", "a prompt is required");
  if (prompt.length > MAX_PROMPT_CHARS) throw new ControlStackError("agent_prompt_too_long", "prompt is too long");
  if (input.mode === "read-only" && !spec.readOnlySupported) {
    throw new ControlStackError("agent_mode_unsupported", `${spec.id} has no verified read-only mode`);
  }
  const timeoutSec = Math.min(
    Math.max(Math.trunc(input.timeoutSec ?? DEFAULT_RUN_TIMEOUT_SEC), 10),
    MAX_RUN_TIMEOUT_SEC
  );
  const binaryPath = resolveBinary(spec.binary, input.pathValue);
  if (!binaryPath) throw new ControlStackError("agent_not_installed", `${spec.binary} was not found on PATH`);
  const args = spec.buildArgs({ prompt, mode: input.mode, timeoutSec, cwd: input.cwd });
  const commandHash = createHash("sha256")
    .update(JSON.stringify({ agent: spec.id, mode: input.mode, cwd: input.cwd, timeoutSec, prompt }))
    .digest("hex");
  return { agentId: spec.id, binaryPath, args, mode: input.mode, timeoutSec, commandHash };
}

/**
 * Redact line by line. The shared redactor blanks a whole string when any part looks secret, which
 * would erase an entire agent transcript for one stray `token=` line; per line keeps the rest readable.
 */
export function redactLines(text: string): string {
  return stripAnsi(text)
    .split("\n")
    .map((line) => {
      const redacted = redactValue(line);
      return typeof redacted === "string" ? redacted : String(redacted);
    })
    .join("\n");
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu;
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

export interface AgentRunOutcome {
  outcome: "succeeded" | "failed" | "timed_out" | "cancelled";
  exitCode: number | null;
  durationMs: number;
  output: string;
  truncated: boolean;
  outputSha256: string;
  pid?: number;
}

export interface RunAgentOptions {
  command: AgentCommand;
  cwd: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
  onStart?: (pid: number | undefined) => void;
}

/** Spawn the CLI (no shell) in its own process group, bounded by timeout and output size. */
export function runAgent(options: RunAgentOptions): Promise<AgentRunOutcome> {
  const spec = agentCliSpec(options.command.agentId)!;
  const cap = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const started = Date.now();
  return new Promise((resolvePromise) => {
    let output = "";
    let truncated = false;
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    const child = spawn(options.command.binaryPath, options.command.args, {
      cwd: options.cwd,
      env: options.env ?? agentEnv(spec),
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    options.onStart?.(child.pid);
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        /* already gone */
      }
    };
    const stop = (why: "timeout" | "cancel") => {
      if (why === "timeout") timedOut = true;
      else cancelled = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 2_000).unref();
    };
    const timer = setTimeout(() => stop("timeout"), options.command.timeoutSec * 1_000);
    const onAbort = () => stop("cancel");
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    const append = (chunk: Buffer) => {
      if (output.length >= cap) {
        truncated = true;
        return;
      }
      output += chunk.toString("utf8");
      if (output.length > cap) {
        output = output.slice(0, cap);
        truncated = true;
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const settle = (exitCode: number | null, extra = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      killGroup("SIGKILL");
      const text = redactLines(output + extra);
      resolvePromise({
        outcome: cancelled ? "cancelled" : timedOut ? "timed_out" : exitCode === 0 ? "succeeded" : "failed",
        exitCode,
        durationMs: Date.now() - started,
        output: text,
        truncated,
        outputSha256: createHash("sha256").update(text).digest("hex"),
        ...(child.pid ? { pid: child.pid } : {})
      });
    };
    child.on("error", (error) => settle(null, `\n[spawn error] ${error.message}`));
    child.on("close", (code) => settle(code));
  });
}
