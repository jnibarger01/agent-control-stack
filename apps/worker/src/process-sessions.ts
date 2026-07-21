import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { delimiter } from "node:path";
import { ControlStackError } from "@agent-control-stack/shared";
import {
  previewRegisteredCommand,
  resolveRegisteredCommand,
  subprocessEnv,
  type MachineControllerConfig
} from "@agent-control-stack/machine-controller";

interface ManagedProcess {
  pid: number;
  commandId: string;
  command: string;
  args: string[];
  child: ChildProcessWithoutNullStreams;
  stdout: string;
  stderr: string;
  startedAt: string;
  exitedAt?: string;
  exitCode?: number | null;
}

const sessions = new Map<number, ManagedProcess>();
const MAX_SESSIONS = 100;
const MAX_OUTPUT_BYTES = 20_000;

export function startManagedProcess(config: MachineControllerConfig, input: { commandId: string }) {
  const preview = previewRegisteredCommand(config, { commandId: input.commandId });
  if (preview.risk !== "read_only") {
    throw new ControlStackError("process_command_refused", "process command is not read-only: " + preview.commandId);
  }
  const resolved = resolveRegisteredCommand(config, { commandId: input.commandId });
  const child = spawn(resolved.command, resolved.args, {
    cwd: resolved.cwd,
    env: {
      ...subprocessEnv(),
      PATH: config.commands.executablePaths.join(delimiter),
      PAGER: "cat",
      NO_COLOR: "1"
    },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"]
  });
  if (child.pid === undefined) {
    throw new ControlStackError("process_start_failed", "ACS could not obtain a process id");
  }
  const session: ManagedProcess = {
    pid: child.pid,
    commandId: resolved.commandId,
    command: resolved.command,
    args: resolved.args,
    child,
    stdout: "",
    stderr: "",
    startedAt: new Date().toISOString()
  };
  sessions.set(child.pid, session);
  child.stdout.on("data", (chunk: Buffer) => {
    session.stdout = appendBounded(session.stdout, chunk.toString("utf8"));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    session.stderr = appendBounded(session.stderr, chunk.toString("utf8"));
  });
  child.on("close", (exitCode) => {
    session.exitCode = exitCode;
    session.exitedAt = new Date().toISOString();
  });
  pruneSessions();
  return describeSession(session);
}

export async function interactWithManagedProcess(
  input: { pid: number; input: string; timeoutMs: number },
  config: MachineControllerConfig
) {
  const session = requireSession(input.pid);
  if (session.child.stdin.destroyed || session.exitedAt) {
    throw new ControlStackError("process_not_writable", "ACS process is no longer accepting input: " + input.pid);
  }
  session.child.stdin.write(input.input);
  return {
    ...describeSession(session),
    output: await readManagedProcessOutput({ ...input, offset: 0, length: 1_000 }, config)
  };
}

export async function readManagedProcessOutput(
  input: { pid: number; offset: number; length: number; timeoutMs: number },
  _config: MachineControllerConfig
) {
  const session = requireSession(input.pid);
  if (!session.exitedAt && input.timeoutMs > 0 && session.stdout.length === 0 && session.stderr.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(input.timeoutMs, 250)));
  }
  const lines = (session.stdout + session.stderr).split(/\r?\n/);
  return {
    ...describeSession(session),
    offset: input.offset,
    length: input.length,
    totalLines: lines.length,
    output: lines.slice(input.offset, input.offset + input.length).join("\n")
  };
}

export function terminateManagedProcess(input: { pid: number; force: boolean }) {
  const session = requireSession(input.pid);
  if (!session.exitedAt) {
    session.child.kill(input.force ? "SIGKILL" : "SIGTERM");
  }
  return { ...describeSession(session), signal: input.force ? "SIGKILL" : "SIGTERM" };
}

export function listManagedProcesses() {
  return { sessions: [...sessions.values()].sort((left, right) => left.pid - right.pid).map(describeSession) };
}

export function shutdownManagedDevice(): never {
  throw new ControlStackError(
    "shutdown_disabled",
    "ACS exposes no host shutdown primitive; use an approval-gated registered service action instead"
  );
}

function requireSession(pid: number): ManagedProcess {
  const session = sessions.get(pid);
  if (!session) {
    throw new ControlStackError("process_not_registered", "process was not started by ACS: " + pid);
  }
  return session;
}

function describeSession(session: ManagedProcess) {
  return {
    pid: session.pid,
    commandId: session.commandId,
    command: session.command,
    args: session.args,
    startedAt: session.startedAt,
    ...(session.exitedAt === undefined ? {} : { exitedAt: session.exitedAt }),
    ...(session.exitCode === undefined ? {} : { exitCode: session.exitCode }),
    stdoutBytes: Buffer.byteLength(session.stdout, "utf8"),
    stderrBytes: Buffer.byteLength(session.stderr, "utf8")
  };
}

function appendBounded(current: string, next: string): string {
  const combined = current + next;
  if (Buffer.byteLength(combined, "utf8") <= MAX_OUTPUT_BYTES) return combined;
  return Buffer.from(combined, "utf8").subarray(0, MAX_OUTPUT_BYTES).toString("utf8") + "\n[truncated]";
}

function pruneSessions(): void {
  if (sessions.size <= MAX_SESSIONS) return;
  const completed = [...sessions.values()]
    .filter((session) => session.exitedAt !== undefined)
    .sort((left, right) => (left.exitedAt ?? "").localeCompare(right.exitedAt ?? ""));
  while (sessions.size > MAX_SESSIONS && completed.length > 0) {
    const session = completed.shift();
    if (session) sessions.delete(session.pid);
  }
}
