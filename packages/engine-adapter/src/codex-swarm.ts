import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_SWARM_ENGINE_ID,
  buildExecutionEnvelope,
  evidenceMatchesEnvelope,
  swarmExecutionEvidenceSchema,
  type BuildExecutionEnvelopeInput,
  type ExecutionEnvelope,
  type SwarmExecutionEvidence
} from "./codex-swarm-envelope.js";

/**
 * F4 / ADR 0017: ACS-controlled Codex Swarm transport.
 *
 * One Swarm process per ACS attempt, started in SWARM_CONTROL_PLANE=acs mode and spoken to over a
 * private per-attempt Unix socket using the `acs/v1` line protocol:
 *
 *   -> {"method":"ready","attemptId":"<id>"}           <- {"ok":true,"protocol":"acs/v1","attemptId":"<id>"}
 *   -> {"method":"execute","envelope":{...signed...}}  <- {"ok":true,"evidence":{...}} | {"ok":false,"error":"<code>"}
 *
 * The per-attempt MAC secret is written once to the child's fd 3 and never travels on the socket,
 * in argv, or in the environment. Evidence is untrusted: it must parse strictly and echo the exact
 * attempt, envelope hash, lease and fencing epoch, or it is refused. Any timeout, crash, malformed
 * or oversized reply is `unknown` — never success. The child's whole process group is terminated
 * and reaped before `runAttempt` returns.
 *
 * This is the ACS half of the boundary. It is not a scheduler and grants nothing: the caller must
 * already hold an ACS lease and fencing epoch for the attempt (see the envelope fields).
 */
export const CODEX_SWARM_PROTOCOL = "acs/v1" as const;
export const CODEX_SWARM_SECRET_FD = 3;
const MAX_REPLY_BYTES = 8 * 1024 * 1024;

export interface CodexSwarmLaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Where ACS connects on the host. */
  hostSocketPath: string;
  /** Containment unit to tear down, if any. */
  unitName?: string;
}

/**
 * Wraps the Swarm command in host isolation (e.g. packages/sandbox `createCodexSwarmSandboxLauncher`,
 * the codex-swarm-v1 profile). Without one, Swarm runs unisolated; `requireIsolation` refuses that.
 */
export interface CodexSwarmLauncher {
  readonly profile: string;
  launch(context: {
    attemptId: string;
    workspaceHostPath: string;
    networkPolicy: string;
    socketDir: string;
    socketName: string;
    command: readonly string[];
    env: Readonly<Record<string, string>>;
  }): CodexSwarmLaunchSpec;
  teardown?(launch: CodexSwarmLaunchSpec): Promise<boolean>;
}

export interface CodexSwarmEngineConfig {
  /** Absolute argv that starts Swarm's ACS transport, e.g. ["/usr/bin/node", "/opt/swarm/dist/cli.js", "acs-serve"]. */
  command: readonly string[];
  /** Extra non-secret environment for the child. PATH-like values only; the secret never goes here. */
  env?: Readonly<Record<string, string>>;
  readyTimeoutMs?: number;
  /** Hard ceiling for one execute call; the envelope's own timeoutMs is also enforced. */
  executeTimeoutMs?: number;
  killGraceMs?: number;
  /** Parent for the private per-attempt directory holding the socket. */
  runtimeDir?: string;
  launcher?: CodexSwarmLauncher;
  /**
   * F6 fence reverse channel. When set, ACS serves `fence.sock` beside the attempt socket and Swarm
   * must ask it before every mutating lane action; ACS answers from its own claim state.
   */
  fenceCheck?: (attempt: { acsAttemptId: string; leaseId: string; fencingEpoch: number }) => boolean | Promise<boolean>;
  /** Production setting: refuse to start Swarm without a host isolation launcher. */
  requireIsolation?: boolean;
  now?: () => Date;
}

export type CodexSwarmAttemptOutcome =
  | { status: "evidence"; envelope: ExecutionEnvelope; evidence: SwarmExecutionEvidence; reaped: boolean }
  | { status: "refused"; reason: string; reaped: boolean }
  | { status: "unknown"; reason: string; reaped: boolean };

const ENV_KEY = /^[A-Z_][A-Z0-9_]{0,63}$/u;
const RESERVED_ENV = new Set([
  "SWARM_CONTROL_PLANE",
  "ACS_SWARM_SOCKET",
  "ACS_SWARM_ATTEMPT_ID",
  "ACS_SWARM_SECRET_FD",
  "ACS_SWARM_FENCE_SOCKET_NAME"
]);
export const CODEX_SWARM_FENCE_SOCKET = "fence.sock" as const;

export class CodexSwarmEngineAdapter {
  readonly id = CODEX_SWARM_ENGINE_ID;

  constructor(private readonly config: CodexSwarmEngineConfig) {
    if (config.requireIsolation && !config.launcher) {
      throw new TypeError("codex-swarm isolation is required but no launcher is configured");
    }
    if (config.command.length === 0 || !config.command[0]!.startsWith("/")) {
      throw new TypeError("codex-swarm command must be an absolute argv");
    }
    for (const key of Object.keys(config.env ?? {})) {
      if (!ENV_KEY.test(key) || RESERVED_ENV.has(key) || /SECRET|TOKEN|KEY|PASSWORD/u.test(key)) {
        throw new TypeError("codex-swarm env key " + key + " is not allowed");
      }
    }
  }

  /**
   * Sign the envelope with a fresh per-attempt secret, start Swarm, wait for readiness, execute once,
   * validate the evidence echo, then terminate and reap the process group.
   */
  async runAttempt(input: BuildExecutionEnvelopeInput, signal?: AbortSignal): Promise<CodexSwarmAttemptOutcome> {
    const secret = randomBytes(32).toString("hex");
    let envelope: ExecutionEnvelope;
    try {
      envelope = buildExecutionEnvelope(input, secret);
    } catch (error) {
      return { status: "refused", reason: "envelope_invalid: " + (error as Error).message, reaped: true };
    }
    const now = (this.config.now ?? (() => new Date()))().getTime();
    if (Date.parse(envelope.expiresAt) <= now) return { status: "refused", reason: "envelope_expired", reaped: true };

    const dir = mkdtempSync(join(this.config.runtimeDir ?? tmpdir(), "acs-swarm-"));
    const socketName = "acs.sock";
    let child: ChildProcess | undefined;
    let exited: Promise<void> = Promise.resolve();
    let launch: CodexSwarmLaunchSpec | undefined;
    let fenceServer: Server | undefined;
    try {
      const childEnv: Record<string, string> = {
        ...this.config.env,
        SWARM_CONTROL_PLANE: "acs",
        ACS_SWARM_ATTEMPT_ID: envelope.acsAttemptId,
        ACS_SWARM_SECRET_FD: String(CODEX_SWARM_SECRET_FD)
      };
      if (this.config.fenceCheck) {
        fenceServer = await serveFence(join(dir, CODEX_SWARM_FENCE_SOCKET), envelope, this.config.fenceCheck);
        childEnv.ACS_SWARM_FENCE_SOCKET_NAME = CODEX_SWARM_FENCE_SOCKET;
      }
      try {
        launch = this.config.launcher
          ? this.config.launcher.launch({
              attemptId: envelope.acsAttemptId,
              workspaceHostPath: envelope.workspace.hostPath,
              networkPolicy: envelope.networkPolicy,
              socketDir: dir,
              socketName,
              command: this.config.command,
              env: childEnv
            })
          : {
              command: this.config.command[0]!,
              args: this.config.command.slice(1),
              env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...childEnv, ACS_SWARM_SOCKET: join(dir, socketName) },
              hostSocketPath: join(dir, socketName)
            };
      } catch (error) {
        return { status: "refused", reason: "isolation_refused: " + (error as Error).message, reaped: true };
      }
      const socketPath = launch.hostSocketPath;
      child = spawn(launch.command, launch.args, {
        cwd: dir,
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "pipe"],
        env: launch.env
      });
      const started = child;
      exited = new Promise((resolve) => {
        if (started.exitCode !== null || started.signalCode !== null) resolve();
        else started.once("exit", () => resolve());
      });
      const spawnError = new Promise<string>((resolve) => started.once("error", (error) => resolve(error.message)));
      const secretPipe = started.stdio[CODEX_SWARM_SECRET_FD] as NodeJS.WritableStream | null;
      if (!secretPipe) return { status: "unknown", reason: "spawn_error: no secret pipe", reaped: await this.reap(child, exited, launch) };
      secretPipe.on("error", () => undefined);
      secretPipe.end(secret + "\n");

      const ready = await Promise.race([
        this.waitReady(socketPath, envelope.acsAttemptId, signal),
        spawnError.then((message) => ({ ok: false as const, reason: "spawn_error: " + message })),
        exited.then(() => ({ ok: false as const, reason: "exited_before_ready" }))
      ]);
      if (!ready.ok) return { status: "unknown", reason: ready.reason, reaped: await this.reap(child, exited, launch) };

      const budgetMs = Math.min(this.config.executeTimeoutMs ?? envelope.timeoutMs, envelope.timeoutMs);
      const reply = await Promise.race([
        request(socketPath, { method: "execute", envelope }, budgetMs, signal),
        exited.then(() => ({ ok: false as const, reason: "exited_during_execute" }))
      ]);
      if (!reply.ok) return { status: "unknown", reason: reply.reason, reaped: await this.reap(child, exited, launch) };
      const outcome = this.judge(reply.value, envelope);
      return { ...outcome, reaped: await this.reap(child, exited, launch) } as CodexSwarmAttemptOutcome;
    } catch (error) {
      return { status: "unknown", reason: "transport_error: " + (error as Error).message, reaped: await this.reap(child, exited, launch) };
    } finally {
      if (fenceServer) await new Promise<void>((resolve) => fenceServer!.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private judge(
    value: unknown,
    envelope: ExecutionEnvelope
  ): Omit<Extract<CodexSwarmAttemptOutcome, { status: "evidence" }>, "reaped"> | { status: "refused" | "unknown"; reason: string } {
    if (!value || typeof value !== "object") return { status: "unknown", reason: "reply_malformed" };
    const reply = value as { ok?: unknown; error?: unknown; evidence?: unknown };
    if (reply.ok === false) {
      const code = typeof reply.error === "string" ? reply.error.slice(0, 200) : "unspecified";
      return { status: "refused", reason: "swarm_refused: " + code };
    }
    if (reply.ok !== true) return { status: "unknown", reason: "reply_malformed" };
    const parsed = swarmExecutionEvidenceSchema.safeParse(reply.evidence);
    if (!parsed.success) return { status: "refused", reason: "evidence_schema_invalid" };
    const echo = evidenceMatchesEnvelope(parsed.data, envelope);
    if (!echo.ok) return { status: "refused", reason: echo.reason };
    return { status: "evidence", envelope, evidence: parsed.data };
  }

  private async waitReady(
    socketPath: string,
    attemptId: string,
    signal?: AbortSignal
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const deadline = Date.now() + (this.config.readyTimeoutMs ?? 10_000);
    while (Date.now() < deadline) {
      if (signal?.aborted) return { ok: false, reason: "cancelled" };
      const reply = await request(socketPath, { method: "ready", attemptId }, 1_000, signal);
      if (reply.ok) {
        const value = reply.value as { ok?: unknown; protocol?: unknown; attemptId?: unknown };
        if (value.ok === true && value.protocol === CODEX_SWARM_PROTOCOL && value.attemptId === attemptId) return { ok: true };
        return { ok: false, reason: "ready_mismatch" };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { ok: false, reason: "ready_timeout" };
  }

  /** Terminate the whole process group, escalate to SIGKILL, and wait for the exit to be observed. */
  private async reap(
    child: ChildProcess | undefined,
    exited: Promise<void>,
    launch?: CodexSwarmLaunchSpec
  ): Promise<boolean> {
    const processReaped = await this.reapProcess(child, exited);
    if (!launch || !this.config.launcher?.teardown) return processReaped;
    const unitGone = await this.config.launcher.teardown(launch).catch(() => false);
    return processReaped && unitGone;
  }

  private async reapProcess(child: ChildProcess | undefined, exited: Promise<void>): Promise<boolean> {
    if (!child || child.pid === undefined) return true;
    const pid = child.pid;
    const signalGroup = (sig: NodeJS.Signals) => {
      try {
        process.kill(-pid, sig);
      } catch {
        // Group already gone.
      }
    };
    if (child.exitCode === null && child.signalCode === null) signalGroup("SIGTERM");
    const grace = this.config.killGraceMs ?? 2_000;
    const graceful = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), grace))]);
    // Always sweep the group: lanes may outlive the leader.
    signalGroup("SIGKILL");
    if (!graceful) {
      return Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), grace))]);
    }
    return true;
  }
}

function request(
  socketPath: string,
  message: unknown,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    const socket = connect(socketPath);
    const finish = (result: { ok: true; value: unknown } | { ok: false; reason: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      resolve(result);
    };
    const onAbort = () => finish({ ok: false, reason: "cancelled" });
    const timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify(message) + "\n"));
    socket.on("error", (error: NodeJS.ErrnoException) => finish({ ok: false, reason: "socket_" + (error.code ?? "error") }));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_REPLY_BYTES) return finish({ ok: false, reason: "reply_too_large" });
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        finish({ ok: true, value: JSON.parse(buffer.slice(0, newline)) });
      } catch {
        finish({ ok: false, reason: "reply_not_json" });
      }
    });
    socket.on("end", () => finish({ ok: false, reason: "reply_incomplete" }));
  });
}

/**
 * ACS-served fence oracle for this attempt only. Swarm asks before each mutating lane action:
 *   -> {"method":"fence","acsAttemptId":"..","leaseId":"..","fencingEpoch":N}  <- {"ok":true,"current":bool}
 * Any mismatch with the issued envelope, malformed request, or failing check answers current:false.
 */
function serveFence(
  socketPath: string,
  envelope: ExecutionEnvelope,
  check: NonNullable<CodexSwarmEngineConfig["fenceCheck"]>
): Promise<Server> {
  const server = createServer((socket) => {
    let buffer = "";
    let handled = false;
    socket.setEncoding("utf8");
    socket.on("error", () => undefined);
    socket.on("data", async (chunk: string) => {
      if (handled) return;
      buffer += chunk;
      if (buffer.length > 4_096) {
        handled = true;
        return socket.end(JSON.stringify({ ok: false, error: "request_too_large" }) + "\n");
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      let current: boolean;
      try {
        const message = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
        current =
          message.method === "fence" &&
          message.acsAttemptId === envelope.acsAttemptId &&
          message.leaseId === envelope.leaseId &&
          message.fencingEpoch === envelope.fencingEpoch &&
          (await check({ acsAttemptId: envelope.acsAttemptId, leaseId: envelope.leaseId, fencingEpoch: envelope.fencingEpoch })) === true;
      } catch {
        current = false;
      }
      socket.end(JSON.stringify({ ok: true, current }) + "\n");
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve(server));
  });
}
