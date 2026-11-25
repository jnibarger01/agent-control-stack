import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ControlStackError } from "@agent-control-stack/shared";
import type { CapturedOutput } from "./linux.js";

/**
 * Client for protocol v2 of `rust/scope-supervisor`: one helper process per
 * admitted attempt. ACS keeps authority verification, invocation rendering,
 * redaction and result acceptance. The helper owns launch, timers, signal
 * delivery, raw bounded capture, reaping and the scope cleanup observation.
 *
 * Any doubt about the helper (no frame, a rejected or malformed frame, a
 * binding mismatch, a protocol violation or parent loss) yields cleanup
 * `unknown`, which makes the attempt outcome `unknown` and requires governed
 * reconciliation before retry or publication.
 */

export const RUST_SUPERVISOR_PROTOCOL_VERSION = 2;
export const RUST_SUPERVISOR_BACKEND_TAG = "scope-supervisor-rust-v2";

export type ScopeSupervisorBackend = "typescript" | "rust";

export interface ScopeSupervisorSelection {
  backend: ScopeSupervisorBackend;
  binaryPath?: string;
}

export interface SupervisorSessionBinding {
  workItemId: string;
  attemptId: string;
  leaseId: string;
  workerId: string;
  fencingToken: number;
}

export interface SupervisedInvocation {
  command: string;
  args: string[];
  unitName: string;
}

export interface SupervisedRunLimits {
  wallClockMs: number;
  terminationGraceMs: number;
  outputBytes: number;
}

export interface SupervisedRunResult {
  trigger?: "timeout" | "cancelled";
  terminationError?: string;
  launchError?: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  cleanup: "verified" | "failed" | "unknown";
  output: CapturedOutput;
}

export const defaultRustSupervisorPath = fileURLToPath(
  new URL("../../../rust/scope-supervisor/target/release/acs-scope-supervisor", import.meta.url)
);

/** Reads the per-process selection. Selection is fixed for a backend instance. */
export function scopeSupervisorFromEnvironment(env: NodeJS.ProcessEnv = process.env): ScopeSupervisorSelection {
  const backend = env.ACS_SANDBOX_SUPERVISOR_BACKEND?.trim() || "typescript";
  if (backend !== "typescript" && backend !== "rust") {
    throw new ControlStackError(
      "sandbox_supervisor_invalid",
      "ACS_SANDBOX_SUPERVISOR_BACKEND must be typescript or rust"
    );
  }
  const binaryPath = env.ACS_SCOPE_SUPERVISOR_PATH?.trim();
  return { backend, ...(binaryPath ? { binaryPath } : {}) };
}

/** Fails closed when the Rust supervisor is selected but cannot run. */
export function requireRustSupervisor(selection: ScopeSupervisorSelection): string {
  const path = selection.binaryPath ?? defaultRustSupervisorPath;
  if (!isAbsolute(path)) {
    throw new ControlStackError("sandbox_supervisor_missing", "scope supervisor path must be absolute");
  }
  try {
    accessSync(path, constants.X_OK);
  } catch {
    throw new ControlStackError("sandbox_supervisor_missing", "selected Rust scope supervisor is not executable");
  }
  return path;
}

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const base64 = z
  .string()
  .max(2 * 1_024 * 1_024)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/u);
const errorText = z.string().min(1).max(4_096);

const observationFrameSchema = z
  .object({
    version: z.literal(RUST_SUPERVISOR_PROTOCOL_VERSION),
    type: z.literal("observation"),
    sessionId: identifier,
    workItemId: identifier,
    attemptId: identifier,
    leaseId: identifier,
    workerId: identifier,
    fencingToken: z.number().int().positive(),
    unitName: z.string().min(1).max(128),
    trigger: z.enum(["timeout", "cancelled"]).nullable(),
    signalFailed: z.boolean(),
    terminationError: errorText.nullable(),
    launchError: errorText.nullable(),
    exitCode: z.number().int().min(-255).max(255).nullable(),
    signal: z
      .string()
      .regex(/^SIG[A-Z0-9]+$/u)
      .max(32)
      .nullable(),
    cleanup: z.enum(["verified", "failed", "unknown"]),
    stdout: base64,
    stderr: base64,
    stdoutBytes: z.number().int().nonnegative(),
    stderrBytes: z.number().int().nonnegative(),
    stdoutTruncated: z.boolean(),
    stderrTruncated: z.boolean(),
    protocolViolation: z
      .string()
      .regex(/^[a-z_]+$/u)
      .max(64)
      .nullable(),
    parentLost: z.boolean(),
    abandoned: z.boolean(),
    durationMs: z.number().int().nonnegative()
  })
  .strict();

const rejectedFrameSchema = z
  .object({
    version: z.literal(RUST_SUPERVISOR_PROTOCOL_VERSION),
    type: z.literal("rejected"),
    code: z
      .string()
      .regex(/^[a-z_]+$/u)
      .max(64)
  })
  .strict();

export type RustObservationFrame = z.infer<typeof observationFrameSchema>;

const WATCHDOG_SLACK_MS = 30_000;
const MAX_HELPER_STDERR_BYTES = 4_096;

export interface SuperviseOptions {
  binaryPath: string;
  binding: SupervisorSessionBinding;
  invocation: SupervisedInvocation;
  systemctlPath: string;
  limits: SupervisedRunLimits;
  launcherEnvironment: NodeJS.ProcessEnv;
  signal?: AbortSignal | undefined;
  /** Invoked when the helper is lost, to make a best-effort forced stop of the scope. */
  forceStopScope: () => Promise<void>;
  sessionId?: string;
  /** UTF-8 text written to the workload's stdin, then closed. */
  stdin?: string | undefined;
}

function emptyCapturedOutput(): CapturedOutput {
  return { stdout: [], stderr: [], stdoutBytes: 0, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false };
}

export function newSupervisorSessionId(): string {
  return `ss-${randomBytes(16).toString("hex")}`;
}

function stringEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

/** Max bytes the observation line may occupy for a given output budget. */
export function maxObservationFrameBytes(outputBytes: number): number {
  return Math.ceil(outputBytes / 3) * 4 * 2 + 64 * 1_024;
}

export async function superviseWithRust(options: SuperviseOptions): Promise<SupervisedRunResult> {
  const sessionId = options.sessionId ?? newSupervisorSessionId();
  const startFrame = {
    version: RUST_SUPERVISOR_PROTOCOL_VERSION,
    type: "start",
    session: {
      sessionId,
      workItemId: options.binding.workItemId,
      attemptId: options.binding.attemptId,
      leaseId: options.binding.leaseId,
      workerId: options.binding.workerId,
      fencingToken: options.binding.fencingToken,
      unitName: options.invocation.unitName
    },
    command: options.invocation.command,
    args: options.invocation.args,
    environment: stringEnvironment(options.launcherEnvironment),
    systemctlPath: options.systemctlPath,
    limits: {
      wallClockMs: options.limits.wallClockMs,
      terminationGraceMs: options.limits.terminationGraceMs,
      outputBytes: options.limits.outputBytes
    },
    ...(options.stdin !== undefined ? { stdin: Buffer.from(options.stdin, "utf8").toString("base64") } : {})
  };

  const frame = await runHelper(options, sessionId, `${JSON.stringify(startFrame)}\n`);
  if (!frame.ok) return await helperLost(options, frame.reason);
  const observation = frame.observation;

  const mismatch = bindingMismatch(observation, options, sessionId);
  if (mismatch) return await helperLost(options, mismatch);

  const output = decodeOutput(observation, options.limits.outputBytes);
  if (!output) return await helperLost(options, "supervisor output accounting mismatch");

  const distrusted = observation.protocolViolation
    ? `supervisor control channel violation: ${observation.protocolViolation}`
    : observation.parentLost
      ? "supervisor lost its control channel"
      : observation.abandoned
        ? "supervised launcher did not close"
        : undefined;

  return {
    ...(observation.trigger ? { trigger: observation.trigger } : {}),
    ...(observation.terminationError || distrusted
      ? { terminationError: observation.terminationError ?? distrusted }
      : {}),
    ...(observation.launchError ? { launchError: observation.launchError } : {}),
    exitCode: observation.exitCode,
    signal: observation.signal as NodeJS.Signals | null,
    cleanup: distrusted ? "unknown" : observation.cleanup,
    output
  };
}

function bindingMismatch(
  observation: RustObservationFrame,
  options: SuperviseOptions,
  sessionId: string
): string | undefined {
  const expected: Array<[unknown, unknown, string]> = [
    [observation.sessionId, sessionId, "session"],
    [observation.workItemId, options.binding.workItemId, "work item"],
    [observation.attemptId, options.binding.attemptId, "attempt"],
    [observation.leaseId, options.binding.leaseId, "lease"],
    [observation.workerId, options.binding.workerId, "worker"],
    [observation.fencingToken, options.binding.fencingToken, "fence"],
    [observation.unitName, options.invocation.unitName, "scope"]
  ];
  const failed = expected.find(([actual, wanted]) => actual !== wanted);
  return failed ? `supervisor observation ${failed[2]} binding mismatch` : undefined;
}

function decodeOutput(observation: RustObservationFrame, outputBytes: number): CapturedOutput | undefined {
  const stdout = Buffer.from(observation.stdout, "base64");
  const stderr = Buffer.from(observation.stderr, "base64");
  if (
    stdout.length !== observation.stdoutBytes ||
    stderr.length !== observation.stderrBytes ||
    stdout.length + stderr.length > outputBytes ||
    stdout.toString("base64") !== observation.stdout ||
    stderr.toString("base64") !== observation.stderr
  ) {
    return undefined;
  }
  const output = emptyCapturedOutput();
  if (stdout.length) output.stdout.push(stdout);
  if (stderr.length) output.stderr.push(stderr);
  output.stdoutBytes = stdout.length;
  output.stderrBytes = stderr.length;
  output.stdoutTruncated = observation.stdoutTruncated;
  output.stderrTruncated = observation.stderrTruncated;
  return output;
}

async function helperLost(options: SuperviseOptions, reason: string): Promise<SupervisedRunResult> {
  try {
    await options.forceStopScope();
  } catch {
    // Cleanup stays unknown either way.
  }
  return {
    terminationError: reason.slice(0, 4_096),
    exitCode: null,
    signal: null,
    cleanup: "unknown",
    output: emptyCapturedOutput()
  };
}

type HelperFrame = { ok: true; observation: RustObservationFrame } | { ok: false; reason: string };

async function runHelper(options: SuperviseOptions, sessionId: string, startLine: string): Promise<HelperFrame> {
  const maxFrame = maxObservationFrameBytes(options.limits.outputBytes);
  return await new Promise<HelperFrame>((resolvePromise) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let received = 0;
    let overflow = false;
    let stderrBytes = 0;
    let seq = 0;
    let cancelled = false;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(options.binaryPath, ["supervise"], {
        env: options.launcherEnvironment,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      resolvePromise({ ok: false, reason: `supervisor spawn failed: ${String(error)}`.slice(0, 4_096) });
      return;
    }
    const stdin = child.stdin!;
    stdin.on("error", () => {});

    const cancel = () => {
      if (cancelled || stdin.destroyed) return;
      cancelled = true;
      seq += 1;
      stdin.write(
        `${JSON.stringify({
          version: RUST_SUPERVISOR_PROTOCOL_VERSION,
          sessionId,
          fencingToken: options.binding.fencingToken,
          seq,
          event: { type: "cancel" }
        })}\n`
      );
    };

    const watchdog = setTimeout(
      () => {
        child.kill("SIGKILL");
      },
      options.limits.wallClockMs + options.limits.terminationGraceMs + WATCHDOG_SLACK_MS
    );

    const finish = (frame: HelperFrame) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      options.signal?.removeEventListener("abort", cancel);
      stdin.end();
      resolvePromise(frame);
    };

    child.stdout!.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxFrame) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderrBytes = Math.min(MAX_HELPER_STDERR_BYTES, stderrBytes + chunk.length);
    });
    child.once("error", (error) => {
      finish({ ok: false, reason: `supervisor failed: ${error.message}`.slice(0, 4_096) });
    });
    child.once("close", (code, signal) => {
      if (overflow) return finish({ ok: false, reason: "supervisor observation exceeded its frame limit" });
      finish(parseFrame(Buffer.concat(chunks), code, signal));
    });

    stdin.write(startLine);
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
  });
}

export function parseFrame(bytes: Buffer, code: number | null, signal: NodeJS.Signals | null): HelperFrame {
  const text = bytes.toString("utf8");
  const newline = text.indexOf("\n");
  if (newline < 0 || newline !== text.length - 1) {
    return { ok: false, reason: `supervisor exited without one observation (code ${code}, signal ${signal})` };
  }
  let value: unknown;
  try {
    value = JSON.parse(text.slice(0, newline));
  } catch {
    return { ok: false, reason: "supervisor observation is malformed" };
  }
  const rejected = rejectedFrameSchema.safeParse(value);
  if (rejected.success) return { ok: false, reason: `supervisor rejected the session: ${rejected.data.code}` };
  const parsed = observationFrameSchema.safeParse(value);
  if (!parsed.success) return { ok: false, reason: "supervisor observation failed validation" };
  if (code !== 0) return { ok: false, reason: `supervisor exited with code ${code}` };
  return { ok: true, observation: parsed.data };
}
