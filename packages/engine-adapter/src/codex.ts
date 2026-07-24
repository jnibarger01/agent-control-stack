import { spawn } from "node:child_process";
import { ControlStackError } from "@agent-control-stack/shared";
import { engineSubprocessEnv } from "./env.js";
import { type EngineAdapter, type EngineOutcome, type EngineTask, engineTaskSchema } from "./types.js";

export interface CodexEngineAdapterOptions {
  binary?: string;
  /** Codex CLI's own sandbox mode for the shell commands it decides to run internally. */
  codexSandboxMode?: "read-only" | "workspace-write";
  spawnFn?: typeof spawn;
}

const DEFAULT_CODEX_SANDBOX_MODE = "workspace-write";

export function buildCodexArgs(prompt: string, sandboxMode: "read-only" | "workspace-write"): string[] {
  return ["exec", "--sandbox", sandboxMode, "--skip-git-repo-check", prompt];
}

/**
 * Codex CLI as an EngineAdapter. Runs `codex exec` as a workspace-scoped,
 * env-allowlisted subprocess - not through packages/sandbox's Bubblewrap
 * backend, because that backend unconditionally unshares the network
 * namespace and Codex needs network access to reach its own model API (see
 * the tracked "sandbox needs scoped network egress" gap). Containment here
 * is: cwd fixed to the provisioned workspace, env allowlisted, output and
 * wall-clock bounded, and Codex's own --sandbox workspace-write mode
 * constraining the shell commands it runs internally to that same
 * workspace. This is real but partial isolation, not equivalent to the
 * Bubblewrap sandbox's process/mount/network namespace containment - do not
 * describe it as such.
 */
export class CodexEngineAdapter implements EngineAdapter {
  readonly id = "codex" as const;
  private readonly binary: string;
  private readonly sandboxMode: "read-only" | "workspace-write";
  private readonly spawnFn: typeof spawn;

  constructor(options: CodexEngineAdapterOptions = {}) {
    this.binary = options.binary ?? "codex";
    this.sandboxMode = options.codexSandboxMode ?? DEFAULT_CODEX_SANDBOX_MODE;
    this.spawnFn = options.spawnFn ?? spawn;
  }

  async invoke(task: EngineTask, signal?: AbortSignal): Promise<EngineOutcome> {
    const parsed = engineTaskSchema.parse(task);
    if (signal?.aborted) {
      throw new ControlStackError("engine_invoke_cancelled", "engine invocation was cancelled before it started");
    }

    const started = Date.now();
    return await new Promise<EngineOutcome>((resolvePromise) => {
      const child = this.spawnFn(this.binary, buildCodexArgs(parsed.prompt, this.sandboxMode), {
        cwd: parsed.workspaceHostPath,
        env: engineSubprocessEnv({ extra: ["OPENAI_API_KEY"] }),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let settled = false;
      let timedOut = false;
      let aborted = false;
      let escalationTimer: NodeJS.Timeout | undefined;

      const settle = (outcome: EngineOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (escalationTimer) clearTimeout(escalationTimer);
        signal?.removeEventListener("abort", onAbort);
        resolvePromise(outcome);
      };

      const escalate = () => {
        child.kill("SIGTERM");
        escalationTimer = setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 1_000);
        escalationTimer.unref();
      };

      const timer = setTimeout(() => {
        timedOut = true;
        escalate();
      }, parsed.timeoutMs);

      const onAbort = () => {
        aborted = true;
        escalate();
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdoutTruncated) return;
        const combined = stdout + chunk.toString("utf8");
        if (Buffer.byteLength(combined, "utf8") > parsed.maxOutputBytes) {
          stdout = truncateToByteLength(combined, parsed.maxOutputBytes);
          stdoutTruncated = true;
          return;
        }
        stdout = combined;
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderrTruncated) return;
        const combined = stderr + chunk.toString("utf8");
        if (Buffer.byteLength(combined, "utf8") > parsed.maxOutputBytes) {
          stderr = truncateToByteLength(combined, parsed.maxOutputBytes);
          stderrTruncated = true;
          return;
        }
        stderr = combined;
      });

      child.on("error", (error) => {
        settle({ status: "process_error", message: error.message });
      });

      child.on("close", (code) => {
        const durationMs = Date.now() - started;
        if (timedOut) {
          settle({ status: "timeout", durationMs });
          return;
        }
        if (aborted) {
          settle({ status: "cancelled", durationMs });
          return;
        }
        settle({
          status: "completed",
          exitCode: code ?? -1,
          stdout,
          stderr,
          durationMs,
          stdoutTruncated,
          stderrTruncated
        });
      });
    });
  }
}

function truncateToByteLength(value: string, maxBytes: number): string {
  // Buffer.byteLength/slice operate on bytes, not code points - decoding a
  // slice cut mid-multi-byte-character would corrupt the last character
  // rather than just dropping it, so fall back to Buffer's own utf8 decode,
  // which drops a trailing partial sequence cleanly.
  return Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8");
}
