import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, statfsSync, type StatsFs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStackError } from "@agent-control-stack/shared";
import {
  engineIsolationAuthorityReceiptSchema,
  engineIsolationObservationSchema,
  engineIsolationRequestSchema,
  type EngineIsolationAuthorityReceipt,
  type EngineIsolationAuthorityVerifier,
  type EngineIsolationObservation,
  type EngineIsolationRequest
} from "./engine-contracts.js";
import { startEgressProxy, type EgressDecision, type EgressProxyHandle } from "./egress-proxy.js";
import {
  boundedMessage,
  captureChunk,
  emptyCapturedOutput,
  errorMessage,
  launcherEnvironment,
  observationError,
  observedOutcome,
  redactOutput,
  requireExecutable,
  runHostCommand,
  signalProcessGroup,
  signalScope,
  verifyCgroupV2,
  verifyScopeCleanup,
  verifyWorkspace,
  type CapturedOutput,
  type HostCommandRunner
} from "./linux.js";

const MAX_EGRESS_DENIED_SAMPLE = 10;

export interface EngineRuntimeMount {
  /** A host path trusted by the ACS operator, never caller-supplied. */
  hostPath: string;
  /** Where it is bind-mounted read-only inside the sandbox. */
  sandboxPath: string;
}

export interface EngineIsolationOptions {
  authorityVerifier: EngineIsolationAuthorityVerifier;
  /**
   * Read-only mounts required for the engine binary itself to run (its
   * install directory, its own node_modules, and nothing else). This is
   * ACS-operator configuration set once when wiring an adapter - never
   * derived from a per-invocation request - because mounting anything
   * caller-controlled would defeat the workspace/HOME boundary below.
   */
  runtimeMounts?: EngineRuntimeMount[];
  bwrapPath?: string;
  socatPath?: string;
  systemdRunPath?: string;
  systemctlPath?: string;
  runtimeDir?: string;
  hostCommandRunner?: HostCommandRunner;
  unitNameFactory?: (attemptId: string) => string;
  now?: () => Date;
}

interface ResolvedEngineOptions {
  authorityVerifier: EngineIsolationAuthorityVerifier;
  runtimeMounts: EngineRuntimeMount[];
  bwrapPath: string;
  socatPath: string;
  systemdRunPath: string;
  systemctlPath: string;
  runtimeDir: string;
  hostCommandRunner: HostCommandRunner;
  unitNameFactory: (attemptId: string) => string;
  now: () => Date;
}

const EGRESS_BRIDGE_PORT = 39_217;

/**
 * ADR 0014: an isolation boundary for model-backed engine processes
 * (Codex, Claude verifier, and future engines), independent of
 * packages/sandbox/src/linux.ts's network-incapable CommandBroker sandbox.
 * Reuses that module's proven cgroup-scope and process-tree-kill
 * primitives; adds an authority-resolved workspace mount, a private HOME,
 * single-credential injection, and a scoped-egress bridge so the only
 * network destination reachable from inside the sandbox is one this
 * invocation was explicitly allowlisted to reach.
 */
export interface EngineIsolation {
  preflight(input: unknown): Promise<void>;
  execute(input: unknown, options?: { signal?: AbortSignal }): Promise<EngineIsolationObservation>;
}

export class EngineIsolationBackend implements EngineIsolation {
  readonly name = "engine-isolation-v1" as const;
  private readonly options: ResolvedEngineOptions;
  private hostProbe: Promise<string> | undefined;

  constructor(options: EngineIsolationOptions) {
    this.options = resolveOptions(options);
  }

  async preflight(input: unknown): Promise<void> {
    const request = engineIsolationRequestSchema.parse(input);
    verifyWorkspace(request);
    await this.probeHost();
  }

  async execute(input: unknown, executionOptions: { signal?: AbortSignal } = {}): Promise<EngineIsolationObservation> {
    const request = engineIsolationRequestSchema.parse(input);
    if (executionOptions.signal?.aborted) {
      throw new ControlStackError("engine_isolation_cancelled", "engine request was cancelled before authorization");
    }

    const backendVersion = await this.probeHost();
    const receipt = await this.options.authorityVerifier.verify(request);
    const authority = verifyEngineAuthorityReceipt(request, receipt);
    const canonicalWorkspacePath = verifyWorkspace(request, authority);
    if (executionOptions.signal?.aborted) {
      throw new ControlStackError("engine_isolation_cancelled", "engine request was cancelled before process creation");
    }

    const unitName = validatedEngineUnitName(this.options.unitNameFactory(request.attemptId));
    const runtimeDir = mkdtempSync(join(this.options.runtimeDir, "acs-engine-"));
    const egressDecisions: EgressDecision[] = [];
    let proxy: EgressProxyHandle | undefined;
    try {
      proxy = await startEgressProxy({
        socketPath: join(runtimeDir, "egress.sock"),
        allowlist: request.egressAllowlist,
        onDecision: (decision) => {
          if (egressDecisions.length < 10_000) egressDecisions.push(decision);
        }
      });

      const bubblewrap = buildEngineBubblewrapInvocation(
        request,
        canonicalWorkspacePath,
        proxy.socketPath,
        this.options
      );
      const systemd = buildEngineSystemdScopeInvocation(request, bubblewrap, unitName, this.options);

      return await this.launch(request, systemd, backendVersion, executionOptions, egressDecisions);
    } finally {
      await proxy?.close();
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  }

  private async probeHost(): Promise<string> {
    this.hostProbe ??= probeEngineHost(this.options);
    return await this.hostProbe;
  }

  private async launch(
    request: EngineIsolationRequest,
    invocation: { command: string; args: string[]; unitName: string },
    backendVersion: string,
    executionOptions: { signal?: AbortSignal },
    egressDecisions: EgressDecision[]
  ): Promise<EngineIsolationObservation> {
    const started = this.options.now();
    const output: CapturedOutput = emptyCapturedOutput();
    let trigger: "timeout" | "cancelled" | undefined;
    let terminationError: string | undefined;
    let launchError: string | undefined;
    let settled = false;
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;

    return await new Promise<EngineIsolationObservation>((resolvePromise, rejectPromise) => {
      const child = spawn(invocation.command, invocation.args, {
        detached: true,
        env: launcherEnvironment(),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"]
      });

      if (request.stdin !== undefined) {
        child.stdin.end(request.stdin, "utf8");
      } else {
        child.stdin.end();
      }

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
          signal,
          egressDecisions
        }).then(resolvePromise, rejectPromise);
      });
    });
  }

  private async finishObservation(input: {
    request: EngineIsolationRequest;
    invocation: { unitName: string };
    backendVersion: string;
    started: Date;
    output: CapturedOutput;
    trigger?: "timeout" | "cancelled";
    terminationError?: string;
    launchError?: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    egressDecisions: EgressDecision[];
  }): Promise<EngineIsolationObservation> {
    const cleanup = await verifyScopeCleanup(this.options, input.invocation.unitName);
    const finished = this.options.now();
    const outcome = observedOutcome(input, cleanup);
    const error = observationError(input, cleanup);
    const denied = input.egressDecisions.filter((decision) => !decision.allowed);
    const allowed = input.egressDecisions.filter((decision) => decision.allowed);
    return engineIsolationObservationSchema.parse({
      schemaVersion: "acs.engine-isolation-observation.v1",
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
      ...(input.request.credential ? { credentialInjected: input.request.credential.envName } : {}),
      egressAllowedCount: allowed.length,
      egressDeniedCount: denied.length,
      egressDeniedSample: denied
        .slice(0, MAX_EGRESS_DENIED_SAMPLE)
        .map((decision) => `${decision.host}:${decision.port}`),
      ...(error ? { error } : {})
    });
  }
}

export function createEngineIsolation(options: EngineIsolationOptions): EngineIsolationBackend {
  return new EngineIsolationBackend(options);
}

export function verifyEngineAuthorityReceipt(
  request: EngineIsolationRequest,
  input: unknown
): EngineIsolationAuthorityReceipt {
  const receipt = engineIsolationAuthorityReceiptSchema.parse(input);
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
      "engine_isolation_authority_mismatch",
      `engine isolation authority receipt mismatch: ${String(mismatches[0]?.[0])}`
    );
  }
  return receipt;
}

export function buildEngineBubblewrapInvocation(
  request: EngineIsolationRequest,
  canonicalWorkspacePath: string,
  egressSocketPath: string,
  options: Pick<ResolvedEngineOptions, "bwrapPath" | "socatPath" | "runtimeMounts">
): { command: string; args: string[] } {
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
    "acs-engine",
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
    "/etc/resolv.conf",
    "/etc/resolv.conf",
    "--size",
    String(request.limits.tmpfsBytes),
    "--tmpfs",
    "/tmp",
    "--dir",
    "/tmp/home",
    "--chmod",
    "0700",
    "/tmp/home",
    "--dir",
    "/run/acs",
    "--ro-bind",
    egressSocketPath,
    "/run/acs/egress.sock",
    "--bind",
    canonicalWorkspacePath,
    "/workspace"
  ];

  for (const mount of options.runtimeMounts) {
    args.push("--ro-bind", mount.hostPath, mount.sandboxPath);
  }

  const pathDirs = ["/usr/bin", "/bin", ...options.runtimeMounts.map((mount) => mount.sandboxPath)];

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
    pathDirs.join(":"),
    "--setenv",
    "HTTPS_PROXY",
    `http://127.0.0.1:${EGRESS_BRIDGE_PORT}`,
    "--setenv",
    "HTTP_PROXY",
    `http://127.0.0.1:${EGRESS_BRIDGE_PORT}`,
    "--setenv",
    "NO_COLOR",
    "1"
  );

  if (request.credential) {
    args.push("--setenv", request.credential.envName, request.credential.envValue);
  }

  args.push("--chdir", request.cwd === "." ? "/workspace" : `/workspace/${request.cwd}`, "--");

  // POSIX sh (this runs under /bin/sh, typically dash - not bash), so no
  // "disown": plain "&" backgrounding is enough. The shell process image is
  // replaced by exec below, and the backgrounded socat bridge is reaped
  // along with everything else in the cgroup/pid namespace on cleanup.
  const bridgeCommand = `${shellQuote(options.socatPath)} TCP-LISTEN:${EGRESS_BRIDGE_PORT},bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/run/acs/egress.sock >/dev/null 2>&1 & exec "$@"`;
  args.push("/bin/sh", "-c", bridgeCommand, "sh", request.executable, ...request.args);

  return { command: options.bwrapPath, args };
}

export function buildEngineSystemdScopeInvocation(
  request: EngineIsolationRequest,
  bubblewrap: { command: string; args: string[] },
  unitName: string,
  options: Pick<ResolvedEngineOptions, "systemdRunPath">
): { command: string; args: string[]; unitName: string } {
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

function resolveOptions(options: EngineIsolationOptions): ResolvedEngineOptions {
  return {
    authorityVerifier: options.authorityVerifier,
    runtimeMounts: (options.runtimeMounts ?? []).map((mount) => ({
      hostPath: realpathSync(mount.hostPath),
      sandboxPath: mount.sandboxPath
    })),
    bwrapPath: options.bwrapPath ?? "/usr/bin/bwrap",
    socatPath: options.socatPath ?? "/usr/bin/socat",
    systemdRunPath: options.systemdRunPath ?? "/usr/bin/systemd-run",
    systemctlPath: options.systemctlPath ?? "/usr/bin/systemctl",
    runtimeDir: options.runtimeDir ?? tmpdir(),
    hostCommandRunner: options.hostCommandRunner ?? runHostCommand,
    unitNameFactory: options.unitNameFactory ?? defaultEngineUnitName,
    now: options.now ?? (() => new Date())
  };
}

async function probeEngineHost(options: ResolvedEngineOptions): Promise<string> {
  if (process.platform !== "linux") {
    throw new ControlStackError("engine_isolation_host_unsupported", "live engine isolation requires Linux");
  }
  requireExecutable(options.bwrapPath, "engine_isolation_backend_missing");
  requireExecutable(options.socatPath, "engine_isolation_egress_bridge_missing");
  requireExecutable(options.systemdRunPath, "engine_isolation_cgroup_launcher_missing");
  requireExecutable(options.systemctlPath, "engine_isolation_cgroup_launcher_missing");
  // Runtime mounts are resolved with realpathSync at construction time
  // (resolveOptions); a missing path fails closed there, before any
  // request is accepted, rather than being silently skipped here.
  verifyCgroupV2(statfsSync("/sys/fs/cgroup") as StatsFs);

  const bwrapVersion = await options.hostCommandRunner(options.bwrapPath, ["--version"], { timeoutMs: 5_000 });
  if (bwrapVersion.code !== 0 || !/^bubblewrap\s+\d+\.\d+/u.test(bwrapVersion.stdout.trim())) {
    throw new ControlStackError(
      "engine_isolation_backend_unavailable",
      boundedMessage("bubblewrap version probe failed", bwrapVersion.stderr)
    );
  }

  const probeUnit = defaultEngineUnitName("preflight");
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
      "engine_isolation_cgroup_unavailable",
      boundedMessage("systemd cgroup scope probe failed", scopeProbe.stderr)
    );
  }

  return bwrapVersion.stdout.trim();
}

function defaultEngineUnitName(attemptId: string): string {
  const safeAttempt =
    attemptId
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/gu, "-")
      .slice(0, 40) || "attempt";
  return `acs-engine-${safeAttempt}-${randomBytes(4).toString("hex")}.scope`;
}

function validatedEngineUnitName(unitName: string): string {
  if (unitName.length > 128 || !/^acs-engine-[a-z0-9][a-z0-9_.-]*\.scope$/u.test(unitName)) {
    throw new ControlStackError("engine_isolation_unit_name_invalid", "engine cgroup unit name is invalid");
  }
  return unitName;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}
