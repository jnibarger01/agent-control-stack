/**
 * Narrowly scoped typed process runner.
 *
 * Spawns a single executable with an explicit argv array (shell:false, no
 * shell interpreter — no string ever gets re-parsed for `;`, `&&`, `$(...)`,
 * etc). Callers supply the exact argv; this module never builds a command
 * line string.
 *
 * Responsibilities:
 * - keep stdout/stderr separate
 * - preserve the real exit code (and signal, when killed)
 * - cap stdout/stderr at caller-supplied byte limits and report truncation
 *   explicitly instead of growing memory unbounded
 * - enforce a hard timeout, reporting it explicitly, and terminate the
 *   process (and its process group where supported) so nothing is orphaned
 * - support cooperative cancellation via an AbortSignal, using the same
 *   termination path as the timeout
 */

import { spawn } from 'child_process';

export interface TypedProcessOptions {
  /** Absolute or PATH-resolved executable name. Never a shell string. */
  executable: string;
  /** Argv elements, passed to spawn verbatim — never concatenated into a string. */
  argv: string[];
  /** Working directory for the child process. */
  cwd: string;
  /** Hard wall-clock deadline in milliseconds. */
  timeoutMs: number;
  /** Max stdout size to retain, in characters. */
  maxStdoutChars: number;
  /** Max stderr size to retain, in characters. */
  maxStderrChars: number;
  /** Optional external cancellation signal (cooperative — same kill path as timeout). */
  signal?: AbortSignal;
  /** Optional environment override; defaults to the current process environment. */
  env?: NodeJS.ProcessEnv;
}

export interface TypedProcessResult {
  /** Exit code reported by the OS, or null if the process was killed by a signal. */
  exitCode: number | null;
  /** Signal that terminated the process, or null if it exited normally. */
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** True when the hard timeout fired and the process had to be terminated. */
  timedOut: boolean;
  /** True when termination was triggered by the caller's AbortSignal. */
  aborted: boolean;
  durationMs: number;
}

const GRACEFUL_KILL_GRACE_MS = 2000;

/**
 * Appends chunk to buf, honoring maxChars. Returns [newBuf, truncated].
 * Once truncated, further chunks are dropped (the stream is still drained
 * to avoid backpressure stalls, but nothing more is retained).
 */
function appendCapped(buf: string, truncated: boolean, chunk: string, maxChars: number): [string, boolean] {
  if (truncated) return [buf, true];
  if (buf.length + chunk.length <= maxChars) {
    return [buf + chunk, false];
  }
  const remaining = maxChars - buf.length;
  return [buf + (remaining > 0 ? chunk.slice(0, remaining) : ''), true];
}

export function runTypedProcess(options: TypedProcessOptions): Promise<TypedProcessResult> {
  const { executable, argv, cwd, timeoutMs, maxStdoutChars, maxStderrChars, signal, env } = options;

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let killEscalationTimer: NodeJS.Timeout | null = null;

    let child;
    try {
      child = spawn(executable, argv, {
        cwd,
        shell: false,
        // Own process group on POSIX so we can terminate the whole tree
        // (the child plus anything it spawns) instead of leaving orphans.
        detached: process.platform !== 'win32',
        env: env ?? process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    const clearTimers = (keepKillEscalation = false) => {
      clearTimeout(deadlineTimer);
      if (killEscalationTimer && !keepKillEscalation) clearTimeout(killEscalationTimer);
    };

    const terminate = (signalToSend: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        if (process.platform !== 'win32') {
          // Negative pid targets the whole process group we created via detached:true.
          process.kill(-child.pid, signalToSend);
        } else {
          // Node cannot signal a Windows process group. taskkill /T terminates
          // the complete descendant tree; /F is required for deterministic
          // timeout/cancellation cleanup.
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            shell: false,
            windowsHide: true,
            stdio: 'ignore',
          });
          killer.on('error', () => child.kill(signalToSend));
        }
      } catch {
        // Process may have already exited between the check and the kill.
      }
    };

    const killDeadline = (reason: 'timeout' | 'abort') => {
      if (reason === 'timeout') timedOut = true;
      if (reason === 'abort') aborted = true;
      terminate('SIGTERM');
      killEscalationTimer = setTimeout(() => terminate('SIGKILL'), GRACEFUL_KILL_GRACE_MS);
    };

    const deadlineTimer = setTimeout(() => killDeadline('timeout'), timeoutMs);

    const onAbort = () => killDeadline('abort');
    if (signal) {
      if (signal.aborted) {
        // Already aborted before we could attach — terminate right away.
        queueMicrotask(() => killDeadline('abort'));
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      [stdout, stdoutTruncated] = appendCapped(stdout, stdoutTruncated, chunk.toString('utf8'), maxStdoutChars);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      [stderr, stderrTruncated] = appendCapped(stderr, stderrTruncated, chunk.toString('utf8'), maxStderrChars);
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(error);
    });

    child.on('close', (code, closeSignal) => {
      if (settled) return;
      settled = true;
      // If timeout/cancellation sent SIGTERM, keep the SIGKILL group timer even
      // after the root exits: a descendant may ignore SIGTERM and outlive it.
      clearTimers(timedOut || aborted);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({
        exitCode: code,
        signal: closeSignal,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        timedOut,
        aborted,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
