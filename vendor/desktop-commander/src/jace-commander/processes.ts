/**
 * Governed child processes. argv[0] is an absolute executable, never a shell.
 * The CLI does not spawn; it calls these handlers through /jc/mcp.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { containJcPath, type JcFsPolicy } from './filesystem.js';
import { IntegrationError } from './integrations.js';

const MAX_OUTPUT = 256 * 1024;
const DENIED_BASE = new Set(['sh', 'bash', 'dash', 'zsh', 'sudo', 'env', 'busybox']);

interface Session {
  sessionId: string;
  pid: number;
  argv: string[];
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
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

export function createProcessRegistry(): ProcessRegistry {
  const sessions = new Map<string, Session>();

  return {
    start(args, policy) {
      if (!Array.isArray(args.argv) || args.argv.length < 1 || args.argv.length > 32) {
        throw new IntegrationError('invalid_argument', 'argv must contain 1 to 32 strings');
      }
      const argv = args.argv.map((part) => {
        if (typeof part !== 'string' || part.length < 1 || part.length > 1024) {
          throw new IntegrationError('invalid_argument', 'each argv entry must be a bounded string');
        }
        return part;
      });
      const executable = argv[0]!;
      if (!path.isAbsolute(executable)) throw new IntegrationError('invalid_argument', 'argv[0] must be an absolute path');
      if (DENIED_BASE.has(path.basename(executable))) {
        throw new IntegrationError('command_denied', 'shells and sudo cannot be started through start_process');
      }
      if (!fs.existsSync(executable)) throw new IntegrationError('not_found', 'executable does not exist');
      const cwd = containJcPath(args.cwd, policy);
      const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : 30_000;
      const child = spawn(executable, argv.slice(1), { cwd, shell: false, stdio: 'pipe' });
      if (!child.pid) throw new IntegrationError('start_failed', 'process did not start');
      const session: Session = {
        sessionId: `proc_${randomBytes(8).toString('hex')}`,
        pid: child.pid,
        argv,
        cwd,
        stdout: '',
        stderr: '',
        exitCode: null,
        child,
      };
      child.stdout.on('data', (chunk: Buffer) => { session.stdout = append(session.stdout, chunk); });
      child.stderr.on('data', (chunk: Buffer) => { session.stderr = append(session.stderr, chunk); });
      child.on('exit', (code) => { session.exitCode = code; });
      const timer = setTimeout(() => { child.kill('SIGTERM'); }, timeoutMs);
      child.on('exit', () => clearTimeout(timer));
      sessions.set(session.sessionId, session);
      return { sessionId: session.sessionId, pid: session.pid, cwd, argv };
    },
    output(args) {
      const session = sessions.get(String(args.sessionId ?? ''));
      if (!session) throw new IntegrationError('not_found', 'session not found');
      const offset = typeof args.offset === 'number' ? args.offset : 0;
      return {
        sessionId: session.sessionId,
        pid: session.pid,
        exitCode: session.exitCode,
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
        })),
      };
    },
    kill(args) {
      const session = [...sessions.values()].find((item) =>
        item.sessionId === args.sessionId || (typeof args.pid === 'number' && item.pid === args.pid));
      if (!session) throw new IntegrationError('not_found', 'managed process not found');
      session.child.kill('SIGTERM');
      return { sessionId: session.sessionId, pid: session.pid, signal: 'SIGTERM' };
    },
  };
}
