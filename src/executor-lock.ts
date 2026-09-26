/**
 * Executor singleton lock/lease.
 *
 * A file-based exclusive lease that guarantees at most one live desktop-
 * commander executor runtime claims the canonical executor slot on this
 * machine/user. Uses stdlib only:
 *  - lockfile created with `wx` (O_CREAT|O_EXCL) so creation is atomic
 *  - PID liveness via process.kill(pid, 0)
 *  - optional advisory flock() via a tiny fs.flockSync binding when the
 *    platform exposes it (Linux), used as a second belt on top of O_EXCL
 *
 * Crash recovery: a lease left behind by a dead process is reported as stale
 * and can be taken over after a short grace window. New Linux leases bind
 * the PID to its boot ID and process start ticks, so PID reuse is not ownership.
 * Legacy leases with a live PID and no process identity remain fail-closed;
 * an operator must establish that their old owner is gone before retiring them.
 * An expired TTL alone NEVER makes a lease stale while its holder process is
 * alive — live holders renew the lease on an interval instead.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

export interface LeaseInfo {
  instanceId: string;
  pid: number;
  acquiredAt: number;
  renews: number;
  /** Monotonic-ish wall-clock deadline; ISO string for humans. */
  expiresAt: number;
  hostname: string;
  /** Linux process identity: PID alone can be reused, including after reboot. */
  bootId?: string;
  processStartTicks?: string;
}

export type LeaseFailureReason =
  | 'held-by-live-process'
  | 'stale-taken-over'
  | 'already-held-by-this-instance'
  | 'lockfile-unwritable'
  | 'not-held'
  | 'flock-conflict';

export interface LeaseResult {
  ok: boolean;
  reason?: LeaseFailureReason;
  leaseInfo?: LeaseInfo;
  /** PID or service name blocking acquisition, when known. */
  blockedBy?: string;
  /** True when the previous holder's lease was stale and we took it over. */
  tookOverStale?: boolean;
}

export class ExecutorLeaseConflictError extends Error {
  readonly blockedBy: string;
  readonly leaseInfo?: LeaseInfo;

  constructor(message: string, blockedBy: string, leaseInfo?: LeaseInfo) {
    super(message);
    this.name = 'ExecutorLeaseConflictError';
    this.blockedBy = blockedBy;
    this.leaseInfo = leaseInfo;
  }
}

interface LeaseOptions {
  instanceId?: string;
  /** Lease TTL / dead-PID takeover grace. Dead-PID leases get this grace window since acquiredAt before takeover; live holders renew to extend the TTL. Default 10 seconds. */
  staleAfterMs?: number;
  /** Called when we detect the lease we hold (or see) is stale. */
  onStale?: (info: { leasePath: string; previous?: LeaseInfo; cause?: 'dead-pid' | 'expired-ttl' }) => void;
  /** Override the lock directory (tests). Default: ~/.desktop-commander */
  lockDir?: string;
  /** Override lock file name (tests). */
  lockName?: string;
  /** Also try fs.flockSync-style advisory locking when available. Default true. */
  useFlock?: boolean;
}

/**
 * Dead-PID takeover grace window. After a holder's PID is observed dead we
 * still wait this long before taking its lease over, to cover PID reuse and
 * coarse clock granularity. Default 10 seconds (configurable per call).
 */
const DEFAULT_STALE_AFTER_MS = 10 * 1000;

function defaultLockDir(): string {
  // Namespace override for isolated environments (e.g. a certification E2E
  // sandbox with its own DESKTOP_COMMANDER_STATE_DIR): each lock directory
  // still enforces exactly one canonical executor within it, and the default
  // remains the shared home directory, so production behavior is unchanged.
  const override = process.env.DESKTOP_COMMANDER_EXECUTOR_LOCK_DIR;
  if (override && override.trim().length > 0) return path.resolve(override.trim());
  return path.join(os.homedir(), '.desktop-commander');
}

export function executorLeasePath(lockDir?: string, lockName?: string): string {
  return path.join(lockDir ?? defaultLockDir(), lockName ?? 'executor.lock');
}

/** Best-effort PID liveness. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    if (err && err.code === 'EPERM') return true; // exists, we just can't signal it
    return false;
  }
}

/**
 * Tiny flock helper. Node's stdlib doesn't expose flock(2), but on Linux we
 * can get the same advisory lock via `flock` from util-linux when present.
 * Returns true if the lock was taken, false on conflict, null if unavailable.
 */
function tryFlock(_fd: number, lockPath: string): boolean | null {
  if (process.platform !== 'linux') return null;
  try {
    // Lock by PATH, not by fd number: Node does not inherit fds >= 3 into
    // spawned children, so `flock -n <fdnum>` makes the utility treat the
    // number as a FILENAME (undefined behavior — it made the takeover path
    // flaky). `flock -n <path>` opens and locks the file itself, which is
    // well-defined and provides the same secondary guard.
    execFileSync('flock', ['-n', lockPath], { stdio: 'ignore' });
    return true;
  } catch (err: any) {
    if (err && err.status === 1) return false; // flock(1) exits 1 on conflict
    return null; // flock not installed or unusable — O_EXCL alone still guards
  }
}

function readLeaseFile(lockPath: string): LeaseInfo | null {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.pid === 'number' && typeof parsed.instanceId === 'string') {
      return parsed as LeaseInfo;
    }
    return null;
  } catch {
    return null;
  }
}

/** Unavailable process identity is unknown, never evidence that an owner is dead. */
function linuxProcessIdentity(pid: number): { bootId: string; processStartTicks: string } | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm (field 2) can contain spaces and parentheses. starttime is field 22.
    const processStartTicks = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    if (!/^[a-f0-9-]{36}$/.test(bootId) || !/^\d+$/.test(processStartTicks ?? '')) return undefined;
    return { bootId, processStartTicks };
  } catch {
    return undefined;
  }
}

function leaseProcessWasReplaced(info: LeaseInfo): boolean {
  // Legacy or malformed records cannot prove PID reuse: preserve their live owner.
  if (typeof info.bootId !== 'string' || !/^[a-f0-9-]{36}$/.test(info.bootId)
    || typeof info.processStartTicks !== 'string' || !/^\d+$/.test(info.processStartTicks)) return false;
  const actual = linuxProcessIdentity(info.pid);
  return !!actual && (actual.bootId !== info.bootId || actual.processStartTicks !== info.processStartTicks);
}

function classifyLease(info: LeaseInfo | null, staleAfterMs: number): {
  stale: boolean;
  cause?: 'dead-pid' | 'expired-ttl';
} {
  if (!info) return { stale: true, cause: 'dead-pid' }; // unparsable garbage is stale
  if (!isPidAlive(info.pid) || leaseProcessWasReplaced(info)) return { stale: true, cause: 'dead-pid' };
  // NEVER classify an expired-TTL lease as stale while the holder PID is
  // still alive: a live holder that simply has not renewed yet (GC pause,
  // busy event loop, slow disk) must not be taken over — that would break
  // the singleton guarantee. Expired TTL + alive PID => conflict, and the
  // holder is expected to renew. Only a dead PID is stale.
  return { stale: false };
}

const heldLeases = new Map<string, LeaseInfo>();

/**
 * Acquire the singleton executor lease.
 *
 * - Fresh machine: creates the lockfile, lease held.
 * - Existing lease from a live process: fails with blockedBy = that PID.
 * - Existing lease from a dead PID or past its TTL: after the caller-supplied
 *   staleAfterMs grace has elapsed since acquiredAt, the stale lease is
 *   taken over (crash recovery).
 */
export function acquireExecutorLease(options: LeaseOptions = {}): LeaseResult {
  const lockPath = executorLeasePath(options.lockDir, options.lockName);
  const instanceId = options.instanceId ?? `executor-${process.pid}-${Date.now()}`;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

  if (heldLeases.get(lockPath)?.instanceId === instanceId) {
    return { ok: true, reason: 'already-held-by-this-instance', leaseInfo: heldLeases.get(lockPath) };
  }

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  const attemptWrite = (): { fd: number } | { conflict: LeaseInfo | null } => {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      return { fd };
    } catch (err: any) {
      if (err && err.code === 'EEXIST') return { conflict: readLeaseFile(lockPath) };
      throw err;
    }
  };

  let first = attemptWrite();
  let conflict = 'conflict' in first ? first.conflict : null;
  let fd: number | null = 'fd' in first ? first.fd : null;
  let tookOverStale = false;

  if (fd === null) {
    // Lockfile exists — classify the current holder.
    const holder = conflict;
    const verdict = classifyLease(holder, staleAfterMs);
    if (!verdict.stale) {
      return {
        ok: false,
        reason: 'held-by-live-process',
        blockedBy: holder ? `pid:${holder.pid}` : 'unknown',
        leaseInfo: holder ?? undefined,
      };
    }
    // Stale: honor the grace window before takeover.
    if (holder && Date.now() - holder.acquiredAt < staleAfterMs && verdict.cause === 'dead-pid') {
      // Recent crash inside the grace window — still refuse, caller can retry
      // or force via a shorter staleAfterMs. Report as blocked but stale.
      options.onStale?.({ leasePath: lockPath, previous: holder, cause: verdict.cause });
      return {
        ok: false,
        reason: 'held-by-live-process',
        blockedBy: `stale-pid:${holder.pid}`,
        leaseInfo: holder,
      };
    }
    options.onStale?.({
      leasePath: lockPath,
      previous: holder ?? undefined,
      cause: verdict.cause,
    });
    // Crash recovery: remove the stale file and retry the exclusive create.
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* someone else may have cleaned it; retry will tell */
    }
    const second = attemptWrite();
    if ('conflict' in second) {
      // Another instance raced us for the takeover and won.
      const winner = second.conflict;
      return {
        ok: false,
        reason: 'held-by-live-process',
        blockedBy: winner ? `pid:${winner.pid}` : 'unknown',
        leaseInfo: winner ?? undefined,
      };
    }
    fd = second.fd;
    tookOverStale = true;
  }

  // Optional advisory flock as a second guard (ignored when unavailable).
  if (options.useFlock !== false && fd !== null) {
    const flock = tryFlock(fd, lockPath);
    if (flock === false) {
      fs.closeSync(fd);
      return { ok: false, reason: 'flock-conflict', blockedBy: `lockfile:${lockPath}` };
    }
  }

  const now = Date.now();
  const leaseInfo: LeaseInfo = {
    instanceId,
    pid: process.pid,
    acquiredAt: now,
    renews: 0,
    expiresAt: now + staleAfterMs,
    hostname: os.hostname(),
    ...linuxProcessIdentity(process.pid),
  };
  fs.writeFileSync(fd, JSON.stringify(leaseInfo, null, 2));
  fs.closeSync(fd);
  heldLeases.set(lockPath, leaseInfo);
  return { ok: true, leaseInfo, tookOverStale, reason: tookOverStale ? 'stale-taken-over' : undefined };
}

/** Renew the lease we hold (extends the TTL). */
export function renewLease(options: LeaseOptions = {}): LeaseResult {
  const lockPath = executorLeasePath(options.lockDir, options.lockName);
  const current = heldLeases.get(lockPath);
  if (!current) return { ok: false, reason: 'not-held' };

  const onDisk = readLeaseFile(lockPath);
  if (!onDisk || onDisk.instanceId !== current.instanceId) {
    // We lost the file (deleted or stolen) — try to re-acquire.
    heldLeases.delete(lockPath);
    const again = acquireExecutorLease(options);
    return again.ok ? { ...again, reason: 'stale-taken-over' } : again;
  }

  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const verdict = classifyLease(onDisk, staleAfterMs);
  if (verdict.stale) {
    options.onStale?.({ leasePath: lockPath, previous: onDisk, cause: verdict.cause });
    // Expired TTL while we still live: rewrite to re-arm the lease.
    current.renews += 1;
    current.expiresAt = Date.now() + staleAfterMs;
    try {
      fs.writeFileSync(lockPath, JSON.stringify(current, null, 2));
      return { ok: true, leaseInfo: current };
    } catch {
      return { ok: false, reason: 'lockfile-unwritable' };
    }
  }

  current.renews += 1;
  current.expiresAt = Date.now() + staleAfterMs;
  try {
    fs.writeFileSync(lockPath, JSON.stringify(current, null, 2));
    return { ok: true, leaseInfo: current };
  } catch {
    return { ok: false, reason: 'lockfile-unwritable' };
  }
}

/** Release the lease (only if we still hold it). */
export function releaseLease(options: LeaseOptions = {}): LeaseResult {
  const lockPath = executorLeasePath(options.lockDir, options.lockName);
  const current = heldLeases.get(lockPath);
  if (!current) return { ok: false, reason: 'not-held' };

  const onDisk = readLeaseFile(lockPath);
  if (onDisk && onDisk.instanceId !== current.instanceId) {
    // No longer ours on disk; just drop our in-memory claim.
    heldLeases.delete(lockPath);
    return { ok: true, leaseInfo: current };
  }
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* already gone */
  }
  heldLeases.delete(lockPath);
  return { ok: true, leaseInfo: current };
}

/* ------------------------------------------------------------------ */
/* Competing executor enumeration                                      */
/* ------------------------------------------------------------------ */

export interface CompetingExecutor {
  kind: 'runtime-process' | 'stale-lease' | 'systemd-service';
  detail: string;
  pid?: number;
  alive?: boolean;
  active?: boolean;
  leaseInfo?: LeaseInfo;
}

export interface CompetingExecutorReport {
  competing: CompetingExecutor[];
  runtimeProcesses: CompetingExecutor[];
  staleLeases: CompetingExecutor[];
  systemdServices: CompetingExecutor[];
  checkedAt: number;
}

const KNOWN_SYSTEMD_UNITS = [
  'desktop-commander-remote.service',
  'desktop-commander.service',
];

const ENTRYPOINT_MARKERS = [
  'desktop-commander/dist/index.js',
  'desktop-commander/dist/server.js',
  'desktop-commander/dist/cli.js',
  'desktop-commander/dist/local-runtime.js',
];

function scanProcForRuntimes(): CompetingExecutor[] {
  const found: CompetingExecutor[] = [];
  if (process.platform !== 'linux') return found;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync('/proc').filter((e) => /^\d+$/.test(e));
  } catch {
    return found;
  }
  for (const entry of entries) {
    const pid = parseInt(entry, 10);
    if (pid === process.pid) continue;
    let cmdline = '';
    try {
      cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8');
    } catch {
      continue; // raced exit or no permission
    }
    const normalized = cmdline.replace(/\0/g, ' ');
    if (ENTRYPOINT_MARKERS.some((m) => normalized.includes(m))) {
      found.push({
        kind: 'runtime-process',
        detail: normalized.trim().slice(0, 200),
        pid,
        alive: isPidAlive(pid),
      });
    }
  }
  return found;
}

function scanLeaseFiles(lockDir?: string): CompetingExecutor[] {
  const results: CompetingExecutor[] = [];
  const dir = lockDir ?? defaultLockDir();
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.lock'));
  } catch {
    return results;
  }
  for (const name of names) {
    const lockPath = path.join(dir, name);
    const info = readLeaseFile(lockPath);
    const verdict = classifyLease(info, DEFAULT_STALE_AFTER_MS);
    if (verdict.stale) {
      results.push({
        kind: 'stale-lease',
        detail: `stale lease file ${lockPath}${verdict.cause ? ` (${verdict.cause})` : ''}`,
        pid: info?.pid,
        alive: info ? isPidAlive(info.pid) : false,
        leaseInfo: info ?? undefined,
      });
    }
  }
  return results;
}

function scanSystemdUnits(): CompetingExecutor[] {
  const results: CompetingExecutor[] = [];
  for (const unit of KNOWN_SYSTEMD_UNITS) {
    let active: boolean;
    let output = 'unavailable';
    try {
      output = execFileSync('systemctl', ['is-active', unit], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      active = output === 'active';
    } catch (err: any) {
      output = (err && typeof err.stdout === 'string' ? err.stdout.trim() : '') || 'inactive/unknown';
      active = output === 'active';
    }
    if (active) {
      results.push({ kind: 'systemd-service', detail: `${unit}: ${output}`, active: true });
    }
  }
  return results;
}

/** Enumerate everything that might currently be acting as the executor. */
export function detectCompetingExecutors(lockDir?: string): CompetingExecutorReport {
  const runtimeProcesses = scanProcForRuntimes();
  const staleLeases = scanLeaseFiles(lockDir);
  const systemdServices = scanSystemdUnits();
  return {
    competing: [...runtimeProcesses, ...staleLeases, ...systemdServices],
    runtimeProcesses,
    staleLeases,
    systemdServices,
    checkedAt: Date.now(),
  };
}

/**
 * Enforcement: acquire the lease or throw ExecutorLeaseConflictError naming
 * the blocking PID / service. Call at executor startup to become (or refuse
 * not to be) the canonical executor.
 */
export function claimCanonicalExecutor(options: LeaseOptions = {}): LeaseResult {
  const result = acquireExecutorLease(options);
  if (result.ok) return result;

  const blockers: string[] = [];
  if (result.blockedBy) blockers.push(result.blockedBy);
  const report = detectCompetingExecutors(options.lockDir);
  for (const proc of report.runtimeProcesses) blockers.push(`runtime pid:${proc.pid}`);
  for (const svc of report.systemdServices) blockers.push(svc.detail);

  const detail = blockers.length ? blockers.join('; ') : 'unknown holder';
  throw new ExecutorLeaseConflictError(
    `Another executor holds the singleton lease: ${detail}`,
    blockers[0] ?? 'unknown',
    result.leaseInfo,
  );
}
