import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { accessSync, constants, lstatSync, realpathSync, statfsSync, type StatsFs } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { ControlStackError, redactValue } from "@agent-control-stack/shared";
import {
  sandboxAuthorityReceiptSchema,
  sandboxExecutionObservationSchema,
  sandboxExecutionRequestSchema,
  type SandboxAuthorityReceipt,
  type SandboxAuthorityVerifier,
  type SandboxBackend,
  type SandboxCommandProfile,
  type SandboxExecuteOptions,
  type SandboxExecutionObservation,
  type SandboxExecutionRequest
} from "./contracts.js";

const CGROUP2_SUPER_MAGIC = 0x63677270;
const MAX_PROBE_OUTPUT_BYTES = 16 * 1_024;
const launcherEnvironmentAllowlist = new Set([
  "DBUS_SESSION_BUS_ADDRESS",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PATH",
  "XDG_RUNTIME_DIR"
]);

export interface LinuxSandboxOptions {
  authorityVerifier: SandboxAuthorityVerifier;
  bwrapPath?: string;
  systemdRunPath?: string;
  systemctlPath?: string;
  nodePath?: string;
  gitPath?: string;
  hostCommandRunner?: HostCommandRunner;
  unitNameFactory?: (attemptId: string) => string;
  now?: () => Date;
}

export interface HostCommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export type HostCommandRunner = (
  command: string,
  args: readonly string[],
  options?: { timeoutMs?: number }
) => Promise<HostCommandResult>;

export interface BubblewrapInvocation {
  command: string;
  args: string[];
  runtimeRoot?: string;
}

export interface SystemdScopeInvocation {
  command: string;
  args: string[];
  unitName: string;
}

interface ResolvedLinuxSandboxOptions {
  authorityVerifier: SandboxAuthorityVerifier;
  bwrapPath: string;
  systemdRunPath: string;
  systemctlPath: string;
  nodePath: string;
  gitPath: string;
  hostCommandRunner: HostCommandRunner;
  unitNameFactory: (attemptId: string) => string;
  now: () => Date;
}

interface ProfileCommand {
  executable: string;
  args: string[];
  runtimeRoot?: string;
}

export interface CapturedOutput {
  stdout: Buffer[];
  stderr: Buffer[];
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export class BubblewrapSystemdSandbox implements SandboxBackend {
  readonly name = "bubblewrap-systemd-v1" as const;
  private readonly options: ResolvedLinuxSandboxOptions;
  private hostProbe: Promise<string> | undefined;

  constructor(options: LinuxSandboxOptions) {
    this.options = resolveOptions(options);
  }

  async preflight(input: unknown): Promise<void> {
    const request = sandboxExecutionRequestSchema.parse(input);
    verifyWorkspace(request);
    await this.probeHost();
  }

  async execute(input: unknown, executionOptions: SandboxExecuteOptions = {}): Promise<SandboxExecutionObservation> {
    const request = sandboxExecutionRequestSchema.parse(input);
    if (executionOptions.signal?.aborted) {
      throw new ControlStackError("sandbox_cancelled", "sandbox request was cancelled before authorization");
    }

    const backendVersion = await this.probeHost();
    const receipt = await this.options.authorityVerifier.verify(request);
    const authority = verifyAuthorityReceipt(request, receipt);
    verifyWorkspace(request, authority);
    if (executionOptions.signal?.aborted) {
      throw new ControlStackError("sandbox_cancelled", "sandbox request was cancelled before process creation");
    }
    const unitName = validatedUnitName(this.options.unitNameFactory(request.attemptId));
    const bubblewrap = buildBubblewrapInvocation(request, authority.canonicalWorkspacePath, this.options);
    const systemd = buildSystemdScopeInvocation(request, bubblewrap, unitName, this.options);

    return await this.launch(request, systemd, backendVersion, executionOptions);
  }

  private async probeHost(): Promise<string> {
    this.hostProbe ??= probeLinuxHost(this.options);
    return await this.hostProbe;
  }

  private async launch(
    request: SandboxExecutionRequest,
    invocation: SystemdScopeInvocation,
    backendVersion: string,
    executionOptions: SandboxExecuteOptions
  ): Promise<SandboxExecutionObservation> {
    const started = this.options.now();
    const output = emptyCapturedOutput();
    let trigger: "timeout" | "cancelled" | undefined;
    let terminationError: string | undefined;
    let launchError: string | undefined;
    let settled = false;
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;

    return await new Promise<SandboxExecutionObservation>((resolvePromise, rejectPromise) => {
      const child = spawn(invocation.command, invocation.args, {
        detached: true,
        env: launcherEnvironment(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      });

      const terminate = async (reason: "timeout" | "cancelled"): Promise<void> => {
        if (trigger) return;
        trigger = reason;
        try {
          await signalScope(this.options, invocation.unitName, "SIGTERM");
        } catch (error) {
          terminationError = errorMessage(error);
        }
        signalProcessGroup(child.pid, "SIGTERM");
        forceTimer = setTimeout(() => {
          void signalScope(this.options, invocation.unitName, "SIGKILL")
            .catch((error) => {
              terminationError ??= errorMessage(error);
            })
            .finally(() => {
              signalProcessGroup(child.pid, "SIGKILL");
            });
        }, request.limits.terminationGraceMs);
      };

      terminationTimer = setTimeout(() => {
        void terminate("timeout");
      }, request.limits.wallClockMs);

      const abort = (): void => {
        void terminate("cancelled");
      };
      executionOptions.signal?.addEventListener("abort", abort, { once: true });

      child.stdout.on("data", (chunk: Buffer) => {
        captureChunk(output, "stdout", chunk, request.limits.outputBytes);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        captureChunk(output, "stderr", chunk, request.limits.outputBytes);
      });
      child.on("error", (error) => {
        launchError = error.message;
      });
      child.on("close", (exitCode, signal) => {
        if (settled) return;
        settled = true;
        if (terminationTimer) clearTimeout(terminationTimer);
        if (forceTimer) clearTimeout(forceTimer);
        executionOptions.signal?.removeEventListener("abort", abort);

        void this.finishObservation({
          request,
          invocation,
          backendVersion,
          started,
          output,
          trigger,
          terminationError,
          launchError,
          exitCode,
          signal
        }).then(resolvePromise, rejectPromise);
      });
    });
  }

  private async finishObservation(input: {
    request: SandboxExecutionRequest;
    invocation: SystemdScopeInvocation;
    backendVersion: string;
    started: Date;
    output: CapturedOutput;
    trigger?: "timeout" | "cancelled";
    terminationError?: string;
    launchError?: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }): Promise<SandboxExecutionObservation> {
    const cleanup = await verifyScopeCleanup(this.options, input.invocation.unitName);
    const finished = this.options.now();
    const outcome = observedOutcome(input, cleanup);
    const error = observationError(input, cleanup);
    return sandboxExecutionObservationSchema.parse({
      schemaVersion: "acs.sandbox-observation.v1",
      executionMode: "live",
      backend: this.name,
      backendVersion: input.backendVersion,
      unitName: input.invocation.unitName,
      outcome,
      observedSuccess: outcome === "exited" && input.exitCode === 0 && cleanup === "verified",
      cleanup,
      exitCode: input.exitCode,
      ...(input.signal ? { signal: input.signal } : {}),
      stdout: redactOutput(Buffer.concat(input.output.stdout).toString("utf8")),
      stderr: redactOutput(Buffer.concat(input.output.stderr).toString("utf8")),
      stdoutTruncated: input.output.stdoutTruncated,
      stderrTruncated: input.output.stderrTruncated,
      outputBytes: input.output.stdoutBytes + input.output.stderrBytes,
      startedAt: input.started.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: Math.max(0, finished.getTime() - input.started.getTime()),
      enforcedLimits: input.request.limits,
      ...(error ? { error } : {})
    });
  }
}

export function createLinuxSandbox(options: LinuxSandboxOptions): BubblewrapSystemdSandbox {
  return new BubblewrapSystemdSandbox(options);
}

export function verifyAuthorityReceipt(request: SandboxExecutionRequest, input: unknown): SandboxAuthorityReceipt {
  const receipt = sandboxAuthorityReceiptSchema.parse(input);
  const mismatches = [
    ["workItemId", receipt.workItemId, request.workItemId],
    ["attemptId", receipt.attemptId, request.attemptId],
    ["leaseId", receipt.leaseId, request.leaseId],
    ["workerId", receipt.workerId, request.workerId],
    ["fencingToken", receipt.fencingToken, request.fencingToken],
    ["authorizationHash", receipt.authorizationHash, request.authorization.hash],
    ["policyVersion", receipt.policyVersion, request.policyVersion],
    ["workspaceAllocationId", receipt.workspaceAllocationId, request.workspace.allocationId],
    ["executionEvent.id", receipt.executionEvent.id, request.auditCorrelationId]
  ].filter(([, actual, expected]) => actual !== expected);

  if (mismatches.length) {
    throw new ControlStackError(
      "sandbox_authority_mismatch",
      `sandbox authority receipt mismatch: ${String(mismatches[0]?.[0])}`
    );
  }
  return receipt;
}

export function buildBubblewrapInvocation(
  request: SandboxExecutionRequest,
  canonicalWorkspacePath: string,
  options: Pick<ResolvedLinuxSandboxOptions, "bwrapPath" | "nodePath" | "gitPath">
): BubblewrapInvocation {
  const profile = resolveProfile(request.commandProfile, options);
  const args = [
    "--unshare-user",
    "--unshare-ipc",
    "--unshare-pid",
    "--unshare-net",
    "--unshare-uts",
    "--unshare-cgroup",
    "--disable-userns",
    "--assert-userns-disabled",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    "--hostname",
    "acs-sandbox",
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind",
    "/bin",
    "/bin",
    "--ro-bind",
    "/lib",
    "/lib",
    "--ro-bind-try",
    "/lib64",
    "/lib64",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--dir",
    "/etc",
    "--ro-bind-try",
    "/etc/ld.so.cache",
    "/etc/ld.so.cache",
    "--ro-bind-try",
    "/etc/ld.so.conf",
    "/etc/ld.so.conf",
    "--ro-bind-try",
    "/etc/ld.so.conf.d",
    "/etc/ld.so.conf.d",
    "--ro-bind-try",
    "/etc/localtime",
    "/etc/localtime",
    "--ro-bind-try",
    "/etc/nsswitch.conf",
    "/etc/nsswitch.conf",
    "--ro-bind-try",
    "/etc/passwd",
    "/etc/passwd",
    "--ro-bind-try",
    "/etc/group",
    "/etc/group",
    "--ro-bind-try",
    "/etc/gitconfig",
    "/etc/gitconfig",
    "--size",
    String(request.limits.tmpfsBytes),
    "--tmpfs",
    "/tmp",
    "--dir",
    "/tmp/home",
    "--chmod",
    "0700",
    "/tmp/home",
    "--bind",
    canonicalWorkspacePath,
    "/workspace"
  ];

  if (profile.runtimeRoot) {
    args.push("--dir", "/opt", "--ro-bind", profile.runtimeRoot, "/opt/acs-node");
  }

  args.push(
    "--clearenv",
    "--setenv",
    "HOME",
    "/tmp/home",
    "--setenv",
    "TMPDIR",
    "/tmp",
    "--setenv",
    "PATH",
    profile.runtimeRoot ? "/opt/acs-node/bin:/usr/bin:/bin" : "/usr/bin:/bin",
    "--setenv",
    "CI",
    request.environment.CI ?? "1",
    "--setenv",
    "NO_COLOR",
    request.environment.NO_COLOR ?? "1"
  );

  for (const [name, value] of Object.entries(request.environment).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    if (name === "CI" || name === "NO_COLOR") continue;
    args.push("--setenv", name, value);
  }

  args.push("--chdir", request.cwd === "." ? "/workspace" : `/workspace/${request.cwd}`, "--");
  args.push(profile.executable, ...profile.args);

  return { command: options.bwrapPath, args, ...(profile.runtimeRoot ? { runtimeRoot: profile.runtimeRoot } : {}) };
}

export function buildSystemdScopeInvocation(
  request: SandboxExecutionRequest,
  bubblewrap: BubblewrapInvocation,
  unitName: string,
  options: Pick<ResolvedLinuxSandboxOptions, "systemdRunPath">
): SystemdScopeInvocation {
  return {
    command: options.systemdRunPath,
    unitName,
    args: [
      "--user",
      "--scope",
      "--collect",
      "--quiet",
      `--unit=${unitName}`,
      "--property=CPUAccounting=yes",
      "--property=MemoryAccounting=yes",
      "--property=TasksAccounting=yes",
      `--property=CPUQuota=${request.limits.cpuQuotaPercent}%`,
      `--property=MemoryMax=${request.limits.memoryBytes}`,
      "--property=MemorySwapMax=0",
      `--property=TasksMax=${request.limits.pids}`,
      `--property=RuntimeMaxSec=${request.limits.wallClockMs + request.limits.terminationGraceMs}ms`,
      bubblewrap.command,
      ...bubblewrap.args
    ]
  };
}

export function launcherEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && launcherEnvironmentAllowlist.has(name)) {
      environment[name] = value;
    }
  }
  environment.PATH = "/usr/bin:/bin";
  return environment;
}

function resolveOptions(options: LinuxSandboxOptions): ResolvedLinuxSandboxOptions {
  return {
    authorityVerifier: options.authorityVerifier,
    bwrapPath: options.bwrapPath ?? "/usr/bin/bwrap",
    systemdRunPath: options.systemdRunPath ?? "/usr/bin/systemd-run",
    systemctlPath: options.systemctlPath ?? "/usr/bin/systemctl",
    nodePath: options.nodePath ?? process.execPath,
    gitPath: options.gitPath ?? "/usr/bin/git",
    hostCommandRunner: options.hostCommandRunner ?? runHostCommand,
    unitNameFactory: options.unitNameFactory ?? defaultUnitName,
    now: options.now ?? (() => new Date())
  };
}

async function probeLinuxHost(options: ResolvedLinuxSandboxOptions): Promise<string> {
  if (process.platform !== "linux") {
    throw new ControlStackError("sandbox_host_unsupported", "live sandbox execution requires Linux");
  }
  requireExecutable(options.bwrapPath, "sandbox_backend_missing");
  requireExecutable(options.systemdRunPath, "sandbox_cgroup_launcher_missing");
  requireExecutable(options.systemctlPath, "sandbox_cgroup_launcher_missing");
  requireExecutable(options.nodePath, "sandbox_runtime_missing");
  requireExecutable(options.gitPath, "sandbox_runtime_missing");
  verifyCgroupV2(statfsSync("/sys/fs/cgroup"));

  const bwrapVersion = await options.hostCommandRunner(options.bwrapPath, ["--version"], { timeoutMs: 5_000 });
  if (bwrapVersion.code !== 0 || !/^bubblewrap\s+\d+\.\d+/u.test(bwrapVersion.stdout.trim())) {
    throw new ControlStackError(
      "sandbox_backend_unavailable",
      boundedMessage("bubblewrap version probe failed", bwrapVersion.stderr)
    );
  }

  const probeUnit = defaultUnitName("preflight");
  const scopeProbe = await options.hostCommandRunner(
    options.systemdRunPath,
    [
      "--user",
      "--scope",
      "--collect",
      "--quiet",
      `--unit=${probeUnit}`,
      "--property=CPUAccounting=yes",
      "--property=MemoryAccounting=yes",
      "--property=TasksAccounting=yes",
      "--property=CPUQuota=100%",
      "--property=MemoryMax=67108864",
      "--property=MemorySwapMax=0",
      "--property=TasksMax=16",
      "/usr/bin/true"
    ],
    { timeoutMs: 5_000 }
  );
  if (scopeProbe.code !== 0) {
    throw new ControlStackError(
      "sandbox_cgroup_unavailable",
      boundedMessage("systemd cgroup scope probe failed", scopeProbe.stderr)
    );
  }

  return bwrapVersion.stdout.trim();
}

export interface WorkspaceBoundRequest {
  workspace: { hostPath: string };
  cwd: string;
}

export interface WorkspaceAuthorityHint {
  canonicalWorkspacePath: string;
}

/**
 * Shared by both sandbox backends (packages/sandbox/src/linux.ts for
 * CommandBroker, packages/sandbox/src/engine.ts for engines - ADR 0014):
 * the workspace path is never trusted from the caller. It must resolve to
 * a real, non-symlink directory whose canonical path matches the
 * authoritative allocation exactly, and the requested cwd must stay inside
 * it after realpath resolution.
 */
export function verifyWorkspace(request: WorkspaceBoundRequest, receipt?: WorkspaceAuthorityHint): string {
  let workspaceRealPath: string;
  try {
    const stat = lstatSync(request.workspace.hostPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("workspace root must be a non-symlink directory");
    }
    workspaceRealPath = realpathSync(request.workspace.hostPath);
  } catch (error) {
    throw new ControlStackError("sandbox_workspace_unavailable", errorMessage(error));
  }

  if (
    workspaceRealPath !== request.workspace.hostPath ||
    (receipt !== undefined && workspaceRealPath !== receipt.canonicalWorkspacePath)
  ) {
    throw new ControlStackError("sandbox_workspace_mismatch", "workspace canonical path does not match authority");
  }

  const requestedCwd = resolve(workspaceRealPath, request.cwd);
  if (!isContainedPath(workspaceRealPath, requestedCwd)) {
    throw new ControlStackError("sandbox_filesystem_escape", "working directory escapes the allocated workspace");
  }
  try {
    const cwdRealPath = realpathSync(requestedCwd);
    if (!isContainedPath(workspaceRealPath, cwdRealPath)) {
      throw new ControlStackError("sandbox_filesystem_escape", "working directory resolves outside the workspace");
    }
  } catch (error) {
    if (error instanceof ControlStackError) throw error;
    throw new ControlStackError(
      "sandbox_workspace_unavailable",
      `working directory is unavailable: ${errorMessage(error)}`
    );
  }
  return workspaceRealPath;
}

function resolveProfile(
  profile: SandboxCommandProfile,
  options: Pick<ResolvedLinuxSandboxOptions, "nodePath" | "gitPath">
): ProfileCommand {
  if (profile === "git-status") {
    return { executable: options.gitPath, args: ["status", "--short", "--branch"] };
  }
  if (profile === "git-diff-check") {
    return { executable: options.gitPath, args: ["diff", "--check"] };
  }

  const nodePath = realpathSync(options.nodePath);
  const runtimeRoot = dirname(dirname(nodePath));
  const npmPath = join(runtimeRoot, "bin", "npm");
  requireExecutable(npmPath, "sandbox_runtime_missing");
  const executable = `/opt/acs-node/${relative(runtimeRoot, npmPath).split(sep).join("/")}`;
  const script = {
    "npm-test": "test",
    "npm-lint": "lint",
    "npm-build": "build",
    "npm-typecheck": "typecheck"
  }[profile];
  if (!script) {
    throw new ControlStackError("sandbox_command_profile_denied", `unknown sandbox command profile: ${profile}`);
  }
  return { executable, args: ["run", script], runtimeRoot };
}

export function requireExecutable(path: string, code: string): void {
  try {
    const stat = lstatSync(path);
    if ((!stat.isFile() && !stat.isSymbolicLink()) || stat.isDirectory()) {
      throw new Error("not an executable file");
    }
    accessSync(path, constants.X_OK);
  } catch {
    throw new ControlStackError(code, `required executable is unavailable: ${path}`);
  }
}

export function verifyCgroupV2(stat: StatsFs): void {
  if (Number(stat.type) !== CGROUP2_SUPER_MAGIC) {
    throw new ControlStackError("sandbox_cgroup_unavailable", "cgroup v2 is required for live sandbox execution");
  }
}

export interface ScopeSignalOptions {
  systemctlPath: string;
  hostCommandRunner: HostCommandRunner;
}

export async function signalScope(
  options: ScopeSignalOptions,
  unitName: string,
  signal: "SIGTERM" | "SIGKILL"
): Promise<void> {
  const result = await options.hostCommandRunner(
    options.systemctlPath,
    ["--user", "kill", "--kill-whom=all", `--signal=${signal}`, unitName],
    { timeoutMs: 5_000 }
  );
  if (result.code !== 0 && !/not loaded|not found|could not be found/iu.test(`${result.stdout}\n${result.stderr}`)) {
    throw new ControlStackError(
      "sandbox_cleanup_failed",
      boundedMessage("failed to signal sandbox scope", result.stderr)
    );
  }
}

export async function verifyScopeCleanup(
  options: ScopeSignalOptions,
  unitName: string
): Promise<"verified" | "failed" | "unknown"> {
  try {
    const result = await options.hostCommandRunner(options.systemctlPath, ["--user", "is-active", unitName], {
      timeoutMs: 5_000
    });
    const state = result.stdout.trim();
    if (result.code !== 0 && (state === "inactive" || state === "failed" || state === "unknown" || state === "")) {
      return "verified";
    }
    if (state === "active" || state === "activating" || state === "deactivating") {
      await signalScope(options, unitName, "SIGKILL");
      return "failed";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

export function observedOutcome(
  input: {
    trigger?: "timeout" | "cancelled";
    launchError?: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  },
  cleanup: "verified" | "failed" | "unknown"
): SandboxExecutionObservation["outcome"] {
  if (cleanup !== "verified") return "unknown";
  if (input.trigger === "timeout") return "timed_out";
  if (input.trigger === "cancelled") return "cancelled";
  if (input.launchError) return "launch_failed";
  if (input.signal) return "signaled";
  if (input.exitCode !== null) return "exited";
  return "unknown";
}

export function observationError(
  input: { trigger?: string; terminationError?: string; launchError?: string },
  cleanup: "verified" | "failed" | "unknown"
): string | undefined {
  if (input.terminationError) return boundedMessage("sandbox termination failed", input.terminationError);
  if (input.launchError) return boundedMessage("sandbox launch failed", input.launchError);
  if (cleanup !== "verified") return `sandbox cleanup could not be verified: ${cleanup}`;
  if (input.trigger === "timeout") return "sandbox wall-clock limit exceeded";
  if (input.trigger === "cancelled") return "sandbox execution cancelled";
  return undefined;
}

export function emptyCapturedOutput(): CapturedOutput {
  return {
    stdout: [],
    stderr: [],
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false
  };
}

export function captureChunk(
  output: CapturedOutput,
  stream: "stdout" | "stderr",
  chunk: Buffer,
  maximumBytes: number
): void {
  const used = output.stdoutBytes + output.stderrBytes;
  const remaining = Math.max(0, maximumBytes - used);
  const captured = chunk.subarray(0, remaining);
  if (captured.length) {
    output[stream].push(captured);
    if (stream === "stdout") output.stdoutBytes += captured.length;
    else output.stderrBytes += captured.length;
  }
  if (captured.length < chunk.length) {
    if (stream === "stdout") output.stdoutTruncated = true;
    else output.stderrTruncated = true;
  }
}

export function isContainedPath(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep));
}

export function signalProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // The process may already be gone; scope verification remains authoritative.
  }
}

function defaultUnitName(attemptId: string): string {
  const safeAttempt =
    attemptId
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/gu, "-")
      .slice(0, 40) || "attempt";
  return `acs-sandbox-${safeAttempt}-${randomBytes(4).toString("hex")}.scope`;
}

function validatedUnitName(unitName: string): string {
  if (unitName.length > 128 || !/^acs-sandbox-[a-z0-9][a-z0-9_.-]*\.scope$/u.test(unitName)) {
    throw new ControlStackError("sandbox_unit_name_invalid", "sandbox cgroup unit name is invalid");
  }
  return unitName;
}

export function redactOutput(value: string): string {
  const redacted = redactValue(value);
  return typeof redacted === "string" ? redacted : "[redacted]";
}

export function boundedMessage(prefix: string, detail: string): string {
  const value = detail.trim();
  return value ? `${prefix}: ${value}`.slice(0, 4_096) : prefix;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runHostCommand(
  command: string,
  args: readonly string[],
  options: { timeoutMs?: number } = {}
): Promise<HostCommandResult> {
  return await new Promise<HostCommandResult>((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      env: launcherEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (options.timeoutMs) {
      timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    }
    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = Math.max(0, MAX_PROBE_OUTPUT_BYTES - stdoutBytes);
      const captured = chunk.subarray(0, remaining);
      stdout.push(captured);
      stdoutBytes += captured.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = Math.max(0, MAX_PROBE_OUTPUT_BYTES - stderrBytes);
      const captured = chunk.subarray(0, remaining);
      stderr.push(captured);
      stderrBytes += captured.length;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolvePromise({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}
