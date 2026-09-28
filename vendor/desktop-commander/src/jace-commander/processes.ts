/**
 * Governed child processes. argv[0] is an absolute executable, never a shell.
 * The CLI does not spawn; it calls these handlers through /jc/mcp.
 *
 * ACS approval binds the exact argv, cwd and timeoutMs through the signed
 * invocation hash, and the approval summary ACS shows the approver
 * (jaceCommanderApprovalSummary in packages/desktop-commander-adapter) lists
 * that argv (secret-looking values redacted), cwd and timeoutMs.
 * kill_process approvals show only the session id / pid: ACS never sees a
 * session's argv, which lives in this process.
 * The shell refusal below is defense in depth, not a sandbox: an approved
 * interpreter (python, node, ...) can still run arbitrary code.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { jcChildEnv } from './child-env.js';
import { containJcPath, type JcFsPolicy } from './filesystem.js';
import { IntegrationError } from './integrations.js';

const MAX_OUTPUT = 256 * 1024;
const MAX_SESSIONS = 32;
const MAX_TIMEOUT_MS = 600_000;
const KILL_GRACE_MS = 5_000;
const DENIED_BASE = new Set([
  'sh', 'bash', 'dash', 'zsh', 'ksh', 'mksh', 'ash', 'fish', 'csh', 'tcsh', 'rbash',
  'sudo', 'su', 'doas', 'pkexec', 'env', 'busybox',
]);

interface Session {
  sessionId: string;
  pid: number;
  argv: string[];
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  child: ChildProcessWithoutNullStreams;
}

export interface ProcessRegistry {
  start(args: Record<string, unknown>, policy: JcFsPolicy): Record<string, unknown>;
  output(args: Record<string, unknown>): Record<string, unknown>;
  list(): Record<string, unknown>;
  kill(args: Record<string, unknown>): Record<string, unknown>;
}

function append(current: string, chunk: Buffer): string {
  const next = current + chunk.toString('utf8');
  return next.length > MAX_OUTPUT ? next.slice(next.length - MAX_OUTPUT) : next;
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
  return real;
}

export function createProcessRegistry(): ProcessRegistry {
  const sessions = new Map<string, Session>();

  function makeRoom(): void {
    if (sessions.size < MAX_SESSIONS) return;
    const finished = [...sessions.values()].find((session) => session.exitCode !== null || session.signal !== null);
    if (!finished) throw new IntegrationError('too_many_processes', `at most ${MAX_SESSIONS} managed processes may run at once`);
    sessions.delete(finished.sessionId);
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
      const timeoutMs = args.timeoutMs === undefined ? 30_000 : args.timeoutMs;
      if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
        throw new IntegrationError('invalid_argument', `timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`);
      }
      makeRoom();
      const child = spawn(executable, argv.slice(1), { cwd, env: jcChildEnv(), shell: false, stdio: 'pipe' });
      if (!child.pid) throw new IntegrationError('start_failed', 'process did not start');
      const session: Session = {
        sessionId: `proc_${randomBytes(8).toString('hex')}`,
        pid: child.pid,
        argv,
        cwd,
        stdout: '',
        stderr: '',
        exitCode: null,
        signal: null,
        child,
      };
      child.stdout.on('data', (chunk: Buffer) => { session.stdout = append(session.stdout, chunk); });
      child.stderr.on('data', (chunk: Buffer) => { session.stderr = append(session.stderr, chunk); });
      const timer = setTimeout(() => terminate(session), timeoutMs);
      child.on('exit', (code, signal) => {
        session.exitCode = code;
        session.signal = signal;
        clearTimeout(timer);
      });
      sessions.set(session.sessionId, session);
      return { sessionId: session.sessionId, pid: session.pid, cwd, argv, timeoutMs };
    },
    output(args) {
      const session = sessions.get(String(args.sessionId ?? ''));
      if (!session) throw new IntegrationError('not_found', 'session not found');
      const offset = typeof args.offset === 'number' ? args.offset : 0;
      return {
        sessionId: session.sessionId,
        pid: session.pid,
        exitCode: session.exitCode,
        signal: session.signal,
        running: session.exitCode === null && session.signal === null,
        stdout: session.stdout.slice(offset),
        stderr: session.stderr.slice(offset),
        truncated: session.stdout.length >= MAX_OUTPUT || session.stderr.length >= MAX_OUTPUT,
      };
    },
    list() {
      return {
        processes: [...sessions.values()].map((session) => ({
          sessionId: session.sessionId,
          pid: session.pid,
          cwd: session.cwd,
          argv: session.argv,
          exitCode: session.exitCode,
          signal: session.signal,
          running: session.exitCode === null && session.signal === null,
        })),
      };
    },
    kill(args) {
      const session = [...sessions.values()].find((item) =>
        item.sessionId === args.sessionId || (typeof args.pid === 'number' && item.pid === args.pid));
      if (!session) throw new IntegrationError('not_found', 'managed process not found');
      if (session.exitCode !== null || session.signal !== null) {
        return { sessionId: session.sessionId, pid: session.pid, alreadyExited: true };
      }
      terminate(session);
      return { sessionId: session.sessionId, pid: session.pid, signal: 'SIGTERM', escalatesAfterMs: KILL_GRACE_MS };
    },
  };
}

function terminate(session: Session): void {
  session.child.kill('SIGTERM');
  const escalate = setTimeout(() => {
    if (session.exitCode === null && session.signal === null) session.child.kill('SIGKILL');
  }, KILL_GRACE_MS);
  escalate.unref();
  session.child.once('exit', () => clearTimeout(escalate));
}
