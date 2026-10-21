/**
 * Governed child processes. argv[0] is an absolute executable, never a shell.
 * Each argv entry is one argument; nothing is interpreted.
 *
 * Output is retained per stream with ABSOLUTE offsets, so a client that stored
 * its cursor can resume after truncation or a reconnect and learns how many
 * bytes it missed. Every child runs in its own process group, so timeouts and
 * kill_process stop the whole pipeline, not just the first process.
 *
 * The CLI does not spawn; it calls these handlers through /jc/mcp.
 *
 * ACS approval binds the exact argv, cwd and timeoutMs through the signed
 * invocation hash. The approval summary (jaceCommanderApprovalSummary in
 * packages/desktop-commander-adapter) shows that text redacted for display only.
 * kill_process approvals show only the session id / pid: ACS never sees a
 * session's argv, which lives in this process.
 * The shell refusal below is defense in depth, not a sandbox: an approved
 * interpreter (python, node, ...) can still run arbitrary code.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { jcChildEnv } from './child-env.js';
import { containJcPath, type JcFsPolicy } from './filesystem.js';
import { IntegrationError } from './integrations.js';

/** Retained characters per stream. Older output is dropped; offsets stay absolute. */
const MAX_OUTPUT = 256 * 1024;
const MAX_SESSIONS = 32;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 5_000;
/** After the leader exits, how long to wait for stdio to close before settling anyway (a descendant may hold the pipes). */
const STREAM_CLOSE_GRACE_MS = 2_000;
/** How often a session whose stdio has closed re-checks whether its process group is gone. */
const GROUP_POLL_MS = 200;
/** How long a finished session stays readable before it is pruned. */
const FINISHED_RETENTION_MS = 10 * 60_000;
/** Longest `waitMs` a read may long-poll for new output. */
const MAX_WAIT_MS = 30_000;
const DENIED_BASE = new Set([
  'sh', 'bash', 'dash', 'zsh', 'ksh', 'mksh', 'ash', 'fish', 'csh', 'tcsh', 'rbash',
  'sudo', 'su', 'doas', 'pkexec', 'env', 'busybox',
]);

/**
 * One stream's retained tail. `end` is the absolute offset just past the last
 * character written, so a cursor is always `end` at the time it was read.
 * Offsets count decoded UTF-16 code units; a multibyte character split across
 * chunks is held by the decoder until it completes.
 */
export class OutputBuffer {
  private text = '';
  private base = 0;
  private readonly decoder = new StringDecoder('utf8');

  write(chunk: Buffer): void {
    this.append(this.decoder.write(chunk));
  }

  finish(): void {
    this.append(this.decoder.end());
  }

  get end(): number {
    return this.base + this.text.length;
  }

  /** Text from `from` to the end. `skipped` counts characters lost before the retained tail. */
  read(from: number): { text: string; offset: number; nextOffset: number; skipped: number } {
    const start = Math.min(Math.max(from, this.base), this.end);
    return {
      text: this.text.slice(start - this.base),
      offset: start,
      nextOffset: this.end,
      skipped: Math.max(0, this.base - from),
    };
  }

  private append(piece: string): void {
    this.text += piece;
    if (this.text.length > MAX_OUTPUT) {
      let drop = this.text.length - MAX_OUTPUT;
      // Never leave a lone low surrogate at the head: the cut would split an astral character.
      if (isLowSurrogate(this.text.charCodeAt(drop))) drop += 1;
      this.text = this.text.slice(drop);
      this.base += drop;
    }
  }
}

type SessionKind = 'process';
type SessionState = 'running' | 'exited' | 'failed';

interface Session {
  sessionId: string;
  kind: SessionKind;
  pid: number;
  argv: string[];
  cwd: string;
  timeoutMs: number;
  startedAt: number;
  finishedAt: number | undefined;
  stdout: OutputBuffer;
  stderr: OutputBuffer;
  exitCode: number | null;
  signal: string | null;
  state: SessionState;
  timedOut: boolean;
  error: string | undefined;
  child: ChildProcessWithoutNullStreams;
  /** Resolves when stdio has closed (output is final), or the spawn failed. */
  done: Promise<void>;
  /** Wakes long-polling readers on new output or exit. */
  wakers: Array<() => void>;
}

export interface ProcessRegistry {
  start(args: Record<string, unknown>, policy: JcFsPolicy): Record<string, unknown>;
  output(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  list(): Record<string, unknown>;
  kill(args: Record<string, unknown>): Record<string, unknown>;
}

function resolveExecutable(executable: string): string {
  if (!path.isAbsolute(executable)) throw new IntegrationError('invalid_argument', 'argv[0] must be an absolute path');
  let real: string;
  try {
    real = fs.realpathSync(executable);
  } catch {
    throw new IntegrationError('not_found', 'executable does not exist');
  }
  // Check both names: /bin/sh is usually a symlink to dash or bash.
  if (DENIED_BASE.has(path.basename(executable)) || DENIED_BASE.has(path.basename(real))) {
    throw new IntegrationError('command_denied', 'shells and privilege tools cannot be started through start_process');
  }
  try {
    fs.accessSync(real, fs.constants.X_OK);
  } catch {
    throw new IntegrationError('not_executable', 'argv[0] is not executable');
  }
  return real;
}

function parseTimeout(value: unknown): number {
  const timeoutMs = value === undefined ? DEFAULT_TIMEOUT_MS : value;
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new IntegrationError('invalid_argument', `timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`);
  }
  return timeoutMs;
}

function parseCursor(value: unknown, name: string): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new IntegrationError('invalid_argument', `${name} must be a non-negative integer`);
  }
  return value;
}

function parseWait(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_WAIT_MS) {
    throw new IntegrationError('invalid_argument', `waitMs must be an integer from 0 to ${MAX_WAIT_MS}`);
  }
  return value;
}

/** Signals the whole process group. Falls back to the leader if the group is already gone. */
function signalGroup(session: Session, signal: NodeJS.Signals): void {
  try {
    process.kill(-session.pid, signal);
  } catch {
    try {
      session.child.kill(signal);
    } catch {
      // Already gone; nothing left to signal.
    }
  }
}

function wake(session: Session): void {
  const wakers = session.wakers.splice(0);
  for (const waker of wakers) waker();
}

export function createProcessRegistry(): ProcessRegistry {
  const sessions = new Map<string, Session>();

  function prune(now: number): void {
    for (const [id, session] of sessions) {
      if (session.finishedAt !== undefined && now - session.finishedAt > FINISHED_RETENTION_MS) sessions.delete(id);
    }
  }

  function makeRoom(now: number): void {
    prune(now);
    if (sessions.size < MAX_SESSIONS) return;
    const oldestFinished = [...sessions.values()]
      .filter((session) => session.state !== 'running')
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))[0];
    if (!oldestFinished) throw new IntegrationError('too_many_processes', `at most ${MAX_SESSIONS} managed processes may run at once`);
    sessions.delete(oldestFinished.sessionId);
  }

  /** Spawns one governed session. The caller has already validated and contained every argument. */
  function launch(kind: SessionKind, argv: string[], executable: string, args: string[], cwd: string, timeoutMs: number): Session {
    const now = Date.now();
    makeRoom(now);
    // detached: the child leads its own process group, so the whole pipeline can be signalled.
    const child = spawn(executable, args, { cwd, env: jcChildEnv(), shell: false, stdio: 'pipe', detached: true });
    // Attached before anything else: a failed spawn emits 'error' asynchronously, and an unhandled
    // 'error' event would crash the server. The session handler below takes over once one exists.
    child.on('error', () => undefined);
    if (!child.pid) throw new IntegrationError('start_failed', 'process did not start');
    // No stdin: a command that reads input gets EOF instead of hanging until its timeout.
    child.stdin.end();
    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const session: Session = {
      sessionId: `proc_${randomBytes(8).toString('hex')}`,
      kind,
      pid: child.pid,
      argv,
      cwd,
      timeoutMs,
      startedAt: now,
      finishedAt: undefined,
      stdout: new OutputBuffer(),
      stderr: new OutputBuffer(),
      exitCode: null,
      signal: null,
      state: 'running',
      timedOut: false,
      error: undefined,
      child,
      done,
      wakers: [],
    };
    child.stdout.on('data', (chunk: Buffer) => { session.stdout.write(chunk); wake(session); });
    child.stderr.on('data', (chunk: Buffer) => { session.stderr.write(chunk); wake(session); });
    // A spawn failure (EACCES, ENOEXEC, a vanished cwd) arrives as an 'error' event. Without a
    // listener it is an uncaught exception that takes the whole server down.
    child.on('error', (error: NodeJS.ErrnoException) => {
      session.state = 'failed';
      session.error = error.code ?? 'spawn_failed';
      session.finishedAt = Date.now();
      clearTimeout(timer);
      wake(session);
      resolveDone();
    });
    // 'running' ends only when stdio has closed: until then a reader could see the exit and miss
    // the last chunk. If a descendant keeps the pipes open, settle after a grace period anyway.
    // A session ends only when its whole process group is gone AND its stdio has closed, so its output
    // is final once no writer can add to it. A descendant that holds a pipe past the grace period is
    // detached: its later output is discarded, and the session stays running until the group is gone.
    let concluded = false;
    let streamsClosed = false;
    let closeFallback: NodeJS.Timeout | undefined;
    let groupWatch: NodeJS.Timeout | undefined;
    const conclude = (): void => {
      if (concluded) return;
      concluded = true;
      clearTimeout(closeFallback);
      clearInterval(groupWatch);
      clearTimeout(timer);
      session.stdout.finish();
      session.stderr.finish();
      if (session.state === 'running') {
        session.state = 'exited';
        session.finishedAt = Date.now();
      }
      wake(session);
      resolveDone();
    };
    const tryConclude = (): void => {
      if (!concluded && streamsClosed && !groupAlive(session.pid)) conclude();
    };
    child.on('exit', (code, signal) => {
      session.exitCode = code;
      session.signal = signal;
      closeFallback = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, STREAM_CLOSE_GRACE_MS);
      closeFallback.unref();
      groupWatch = setInterval(tryConclude, GROUP_POLL_MS);
      groupWatch.unref();
    });
    child.on('close', () => {
      streamsClosed = true;
      tryConclude();
    });
    const timer = setTimeout(() => {
      session.timedOut = true;
      terminate(session);
    }, timeoutMs);
    timer.unref();
    sessions.set(session.sessionId, session);
    return session;
  }

  function summary(session: Session): Record<string, unknown> {
    return { ...status(session), argv: session.argv };
  }

  /** Lifecycle fields only. Output replies use this, so argv (which can carry secrets) stays out of them. */
  function status(session: Session): Record<string, unknown> {
    return {
      sessionId: session.sessionId,
      kind: session.kind,
      pid: session.pid,
      cwd: session.cwd,
      state: session.state,
      running: session.state === 'running',
      exitCode: session.exitCode,
      signal: session.signal,
      timedOut: session.timedOut,
    };
  }

  function readOutput(session: Session, stdoutOffset: number, stderrOffset: number): Record<string, unknown> {
    const out = session.stdout.read(stdoutOffset);
    const err = session.stderr.read(stderrOffset);
    return {
      ...status(session),
      ...(session.error !== undefined ? { error: session.error } : {}),
      stdout: out.text,
      stdoutOffset: out.offset,
      stdoutNextOffset: out.nextOffset,
      stdoutSkipped: out.skipped,
      stderr: err.text,
      stderrOffset: err.offset,
      stderrNextOffset: err.nextOffset,
      stderrSkipped: err.skipped,
      truncated: out.skipped > 0 || err.skipped > 0 || session.stdout.end > MAX_OUTPUT || session.stderr.end > MAX_OUTPUT,
    };
  }

  function requireSession(sessionId: unknown): Session {
    const session = sessions.get(String(sessionId ?? ''));
    if (!session) throw new IntegrationError('not_found', 'session not found');
    return session;
  }

  return {
    start(args, policy) {
      if (!Array.isArray(args.argv) || args.argv.length < 1 || args.argv.length > 32) {
        throw new IntegrationError('invalid_argument', 'argv must contain 1 to 32 strings');
      }
      const argv = args.argv.map((part) => {
        if (typeof part !== 'string' || part.length < 1 || part.length > 1024 || part.includes('\0')) {
          throw new IntegrationError('invalid_argument', 'each argv entry must be a bounded string');
        }
        return part;
      });
      const executable = resolveExecutable(argv[0]!);
      const cwd = containJcPath(args.cwd, policy);
      const timeoutMs = parseTimeout(args.timeoutMs);
      const session = launch('process', argv, executable, argv.slice(1), cwd, timeoutMs);
      return { sessionId: session.sessionId, pid: session.pid, cwd, argv, timeoutMs, kind: 'process' };
    },

    async output(args) {
      prune(Date.now());
      const session = requireSession(args.sessionId);
      const stdoutOffset = parseCursor(args.offset, 'offset');
      const stderrOffset = parseCursor(args.stderrOffset, 'stderrOffset');
      const waitMs = parseWait(args.waitMs);
      if (waitMs > 0 && session.state === 'running' && session.stdout.end === stdoutOffset && session.stderr.end === stderrOffset) {
        await new Promise<void>((resolve) => {
          const waker = (): void => { clearTimeout(timer); resolve(); };
          // Drop our waker on timeout too; otherwise a client that long-polls a quiet session grows the list without bound.
          const timer = setTimeout(() => {
            session.wakers = session.wakers.filter((item) => item !== waker);
            resolve();
          }, waitMs);
          session.wakers.push(waker);
        });
      }
      return readOutput(session, stdoutOffset, stderrOffset);
    },

    list() {
      prune(Date.now());
      return { processes: [...sessions.values()].map(summary) };
    },

    kill(args) {
      const session = [...sessions.values()].find((item) =>
        item.sessionId === args.sessionId || (typeof args.pid === 'number' && item.pid === args.pid));
      if (!session) throw new IntegrationError('not_found', 'managed process not found');
      if (session.state !== 'running' && !groupAlive(session.pid)) {
        return { sessionId: session.sessionId, pid: session.pid, alreadyExited: true };
      }
      terminate(session);
      return { sessionId: session.sessionId, pid: session.pid, signal: 'SIGTERM', escalatesAfterMs: KILL_GRACE_MS };
    },
  };
}

/** SIGTERM the group now; SIGKILL it after the grace period if the leader is still alive. */
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** True while any process still belongs to the group led by `pid` (signal 0 probes without sending). */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * SIGTERM the group now; SIGKILL the group after the grace period if any member is still alive.
 * Escalation follows the group, not the leader: a descendant can survive the leader's SIGTERM exit.
 */
function terminate(session: Session): void {
  // Once the leader has been reaped its group may still hold live descendants; signal them while any remain.
  if (session.state !== 'running' && !groupAlive(session.pid)) return;
  signalGroup(session, 'SIGTERM');
  const escalate = setTimeout(() => {
    if (groupAlive(session.pid)) signalGroup(session, 'SIGKILL');
  }, KILL_GRACE_MS);
  escalate.unref();
}
