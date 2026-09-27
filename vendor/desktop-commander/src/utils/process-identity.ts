import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

/**
 * Process liveness and identity verification, used by durable session
 * recovery (P2.1) to answer two different questions safely:
 *
 *   1. Is this PID currently alive?
 *   2. Is it the SAME process we originally spawned, or has the OS reused
 *      the PID for something unrelated since then?
 *
 * (1) alone is not enough to recover a session: PIDs are recycled by every
 * OS, typically fairly quickly on a busy system. Adopting "whatever process
 * currently holds this PID" as a recovered Desktop Commander session would
 * let an unrelated process (started by anything, owned by anyone the OS
 * permits us to signal) be treated as one of ours — including becoming
 * killable via force_terminate. getProcessStartFingerprint() captures a
 * value that changes whenever the PID is reused, so recovery can require
 * an exact match instead of trusting the PID alone.
 */

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    // EPERM means the process exists but we lack permission to signal it —
    // still "alive" for our purposes (and definitely not safe to adopt).
    return error?.code === 'EPERM';
  }
}

/**
 * A fingerprint that changes when a PID is reused for a different process.
 * Returns undefined when no fingerprint could be captured (process already
 * gone, or the platform-specific lookup failed) — callers must treat that
 * as "cannot verify identity", never as "identity confirmed".
 */
export async function getProcessStartFingerprint(pid: number): Promise<string | undefined> {
  if (process.platform === 'linux') {
    return getLinuxProcFingerprint(pid);
  }
  if (process.platform === 'darwin') {
    return getPsBasedFingerprint(pid, ['-o', 'lstart=', '-p', String(pid)]);
  }
  if (process.platform === 'win32') {
    return getWindowsFingerprint(pid);
  }
  // Unknown platform: no reliable fingerprint available. Recovery will
  // treat every such record as unverifiable and refuse to adopt it,
  // per fail-closed default (see session-reconciliation.ts).
  return undefined;
}

/**
 * Linux: /proc/<pid>/stat field 22 (starttime, in clock ticks since boot)
 * is stable for the lifetime of a PID and changes whenever the kernel
 * reissues that PID to a new process. comm (field 2) can itself contain
 * spaces and parentheses, so we split on the LAST ')' rather than by
 * naive whitespace splitting.
 */
async function getLinuxProcFingerprint(pid: number): Promise<string | undefined> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    const closingParen = stat.lastIndexOf(')');
    if (closingParen === -1) return undefined;
    const fields = stat.slice(closingParen + 2).trim().split(/\s+/);
    const starttime = fields[19]; // 0-indexed: state,ppid,pgrp,session,tty,tpgid,flags,minflt,cminflt,majflt,cmajflt,utime,stime,cutime,cstime,priority,nice,threads,itrealvalue,starttime
    if (!starttime || !/^\d+$/.test(starttime)) return undefined;
    return `linux:starttime:${starttime}`;
  } catch {
    return undefined;
  }
}

/** macOS/BSD best-effort fallback: process start timestamp via `ps`. */
async function getPsBasedFingerprint(pid: number, args: string[]): Promise<string | undefined> {
  try {
    const output = await runCommandCaptureStdout('ps', args);
    const trimmed = output.trim();
    return trimmed ? `ps:lstart:${trimmed}` : undefined;
  } catch {
    return undefined;
  }
}

/** Windows best-effort fallback: process creation date via WMIC. */
async function getWindowsFingerprint(pid: number): Promise<string | undefined> {
  try {
    const output = await runCommandCaptureStdout('wmic', [
      'process', 'where', `ProcessId=${pid}`, 'get', 'CreationDate',
    ]);
    const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    // First non-empty line is the header ("CreationDate"); the value follows.
    const value = lines[1];
    return value ? `windows:creationdate:${value}` : undefined;
  } catch {
    return undefined;
  }
}

function runCommandCaptureStdout(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

/**
 * Verifies a persisted (pid, fingerprint) pair against the current OS
 * state. Returns 'alive' only when the PID is alive AND its fingerprint
 * matches exactly; 'reused' when the PID is alive but the fingerprint
 * differs (PID reuse detected — never adopt); 'dead' when the PID no
 * longer exists; 'unverifiable' when liveness can't be established at all.
 *
 * A record with no stored fingerprint (e.g. captured on a platform where
 * fingerprinting failed at spawn time) can never resolve to 'alive' —
 * fail closed rather than trust the PID alone.
 */
export async function verifyProcessIdentity(
  pid: number,
  expectedFingerprint: string | undefined,
): Promise<'alive' | 'reused' | 'dead' | 'unverifiable'> {
  if (!isProcessAlive(pid)) return 'dead';
  if (!expectedFingerprint) return 'unverifiable';
  const currentFingerprint = await getProcessStartFingerprint(pid);
  if (!currentFingerprint) return 'unverifiable';
  return currentFingerprint === expectedFingerprint ? 'alive' : 'reused';
}
