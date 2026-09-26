/**
 * Post-cancellation recovery checkup.
 *
 * After a cancel/timeout kills a child process, verify the kill actually
 * landed: the direct child and its whole process group are dead, and no
 * orphaned descendants survive. Best-effort and idempotent — never throws,
 * every step reports what it could verify.
 *
 * Pairs with the detached:true process-group spawn convention used by
 * command-manager/terminal-manager (child is its own group leader, so
 * killing -pid reaches the entire tree).
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isPidAlive } from '../executor-lock.js';

export interface RecoveryCheckupResult {
  /** Direct child PID is no longer alive. */
  childDead: boolean;
  /** Orphaned descendants were found and killed (0 if none found). */
  descendantsKilled: number;
  /** Whether the executor lease file is still held/valid (informational). */
  leaseStillHeld: boolean;
  /** Overall readiness: child dead, no survivors, environment clean. */
  ready: boolean;
  /** Extra detail for diagnostics. */
  details: string[];
}

function pgidOf(pid: number): number | null {
  try {
    // Node exposes no getpgid; read /proc instead (Linux).
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const after = stat.slice(stat.lastIndexOf(')') + 1).trim().split(' ');
    return parseInt(after[2], 10); // field 5 = pgrp
  } catch {
    return null;
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals | number): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid: number, signal: NodeJS.Signals | number): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Enumerate surviving processes whose process group is (or was) the child's
 * group. Reads /proc directly so it works even after the child's pid is
 * reused by nothing else in our group.
 */
function findGroupSurvivors(pgid: number): number[] {
  const survivors: number[] = [];
  if (process.platform !== 'linux') return survivors;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync('/proc').filter((e) => /^\d+$/.test(e));
  } catch {
    return survivors;
  }
  for (const entry of entries) {
    const pid = parseInt(entry, 10);
    if (pgidOf(pid) === pgid) survivors.push(pid);
  }
  return survivors;
}

/**
 * Kill every process still in the child's process group (escalating
 * SIGTERM -> SIGKILL). Idempotent: killing dead pids is a no-op here.
 */
function killOrphanedGroup(pgid: number): { killed: number; survivors: number[] } {
  let killed = 0;
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    const survivors = findGroupSurvivors(pgid);
    for (const pid of survivors) {
      if (killPid(pid, signal)) killed += 1;
    }
    if (findGroupSurvivors(pgid).length === 0) break;
  }
  return { killed, survivors: findGroupSurvivors(pgid) };
}

/**
 * Lease health: does a lease file exist and does its holder look live?
 * Purely informational for the recovery report.
 */
function leaseHealth(lockName = 'executor.lock'): boolean {
  const lockPath = path.join(os.homedir(), '.desktop-commander', lockName);
  try {
    const info = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return typeof info.pid === 'number' && isPidAlive(info.pid);
  } catch {
    return false; // no lease file: nothing stale being held on disk
  }
}

/**
 * Run a best-effort recovery checkup after a cancel/timeout.
 * Never throws; every step is idempotent.
 */
export async function runRecoveryCheckup(options: {
  /** Child pid from the cancelled execution. Omit for a generic checkup. */
  killedChildPid?: number;
  /** Extra settle time before declaring the child dead (ms). Default 150. */
  settleMs?: number;
  /** Lock file name used by the executor lease (for leaseStillHeld). */
  lockName?: string;
}): Promise<RecoveryCheckupResult> {
  const details: string[] = [];
  const { killedChildPid } = options;

  // (a) Is the child actually dead?
  const settleMs = options.settleMs ?? 150;
  let childDead = true;
  if (typeof killedChildPid === 'number' && killedChildPid > 0) {
  childDead = false;
  for (let i = 0; i < 20; i++) {
    if (!isPidAlive(killedChildPid)) {
      childDead = true;
      break;
    }
    await new Promise((r) => setTimeout(r, Math.max(settleMs / 4, 25)));
  }
  if (!childDead) {
    // Give it one SIGKILL as a courtesy; some cancellations only sent SIGTERM.
    killPid(killedChildPid, 'SIGKILL');
    childDead = !isPidAlive(killedChildPid);
  }
  }
  details.push(`child pid ${killedChildPid ?? 'none'} dead=${childDead}`);

  // (b) Orphaned descendants: whole-process-group cleanup.
  let descendantsKilled = 0;
  const pgid = (typeof killedChildPid === 'number' && killedChildPid > 0)
    ? (pgidOf(killedChildPid) ?? killedChildPid)
    : 0;
  if (childDead && pgid > 1) {
    // Child dead but group may still hold grandchildren (e.g. a detached
    // grandchild, or a reparented child whose pgid we recorded).
    const survivors = findGroupSurvivors(pgid);
    if (survivors.length > 0) {
      details.push(`process group ${pgid} still has survivors: ${survivors.join(',')}`);
      const res = killOrphanedGroupSafe(pgid);
      descendantsKilled = res.killed;
      if (res.survivors.length > 0) {
        details.push(`ungroupable survivors remain: ${res.survivors.join(',')}`);
      } else {
        details.push(`killed ${res.killed} orphaned descendant(s) in group ${pgid}`);
      }
    } else {
      details.push(`process group ${pgid} has no survivors`);
    }
  }

  // (c) Lease/temp-resource health (informational, best-effort).
  const leaseStillHeld = leaseHealth(options.lockName);
  details.push(`leaseStillHeld=${leaseStillHeld}`);

  const survivorsAfter = pgid > 1 ? findGroupSurvivors(pgid) : [];
  const ready = childDead && survivorsAfter.length === 0;

  return { childDead, descendantsKilled, leaseStillHeld, ready, details };
}

/**
 * Like killOrphanedGroup but tolerates the group already being gone.
 * Group-scoped so we never signal unrelated processes.
 */
function killOrphanedGroupSafe(pgid: number): { killed: number; survivors: number[] } {
  let killed = 0;
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    for (const pid of findGroupSurvivors(pgid)) {
      if (killPid(pid, signal)) killed += 1;
    }
    if (findGroupSurvivors(pgid).length === 0) break;
  }
  return { killed, survivors: findGroupSurvivors(pgid) };
}

/**
 * Convenience helper used by the executor after a timeout: spawn a probe
 * command to confirm the environment is immediately usable again.
 * Returns true when the probe exits 0.
 */
export function verifyEnvironmentUsable(timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const probe = spawn('true', [], { detached: true, stdio: 'ignore' });
      const timer = setTimeout(() => {
        killOrphanedGroupSafe(probe.pid ?? 0);
        resolve(false);
      }, timeoutMs);
      probe.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
      probe.once('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
      probe.unref();
    } catch {
      resolve(false);
    }
  });
}
