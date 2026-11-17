/**
 * Native Jace Commander executor lease.
 *
 * A managed `serve` process owns the canonical ACS executor slot by holding
 * `<lockDir>/executor.lock` (default ~/.desktop-commander, or
 * DESKTOP_COMMANDER_EXECUTOR_LOCK_DIR). The record is the same canonical shape
 * the Desktop Commander lock uses, extended with additive v2 fields so ACS can
 * bind the lease to the installed JC release that holds it:
 *
 *   executorKind  "jace-commander"
 *   releaseRoot   the installed release directory the process runs from
 *   releaseCommit the release commit recorded in RELEASE.json
 *
 * Ownership is identity-bound, never PID-bound. A holder is alive only when its
 * PID is alive AND its boot id and process start ticks still match the record.
 * Acquisition is exclusive and atomic: the record is fully written to a temp
 * file and then hard-linked into place, so no reader can observe a partial
 * lease and no two processes can both create it. A dead or reused holder is
 * taken over only after a grace window, under a takeover mutex. A malformed
 * record is never taken over; it fails closed.
 *
 * Holding the lease grants no permission to execute anything. ACS still
 * authorizes every action; the lease only proves which runtime is the executor.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const JC_EXECUTOR_KIND = 'jace-commander';
const LEASE_FILE = 'executor.lock';
const BOOT_ID_PATTERN = /^[a-f0-9-]{36}$/u;
const TICKS_PATTERN = /^\d+$/u;

export interface ProcessIdentity {
  bootId: string;
  processStartTicks: string;
}

export interface ExecutorLeaseRecord {
  instanceId: string;
  pid: number;
  acquiredAt: number;
  renews: number;
  expiresAt: number;
  hostname: string;
  bootId: string;
  processStartTicks: string;
  executorKind: typeof JC_EXECUTOR_KIND;
  releaseRoot: string;
  releaseCommit: string;
}

export type AcquireFailure =
  | 'process-identity-unavailable'
  | 'held-by-live-process'
  | 'stale-within-grace'
  | 'lease-unreadable'
  | 'takeover-in-progress'
  | 'lost-race';

export type AcquireResult =
  | { ok: true; record: ExecutorLeaseRecord; tookOverStale: boolean }
  | { ok: false; reason: AcquireFailure; blockedBy?: number };

export interface AcquireOptions {
  lockDir: string;
  pid: number;
  instanceId: string;
  releaseRoot: string;
  releaseCommit: string;
  nowMs: number;
  ttlMs: number;
  graceMs: number;
  isAlive: (pid: number) => boolean;
  readIdentity: (pid: number) => ProcessIdentity | undefined;
}

export type RenewResult = { ok: true; record: ExecutorLeaseRecord } | { ok: false; reason: 'lost' | 'unwritable' };
export type ReleaseResult = { ok: true } | { ok: false; reason: 'not-held' | 'not-owner' };

/**
 * The runtime identity a managed lease is bound to. The root is the entrypoint
 * directory's parent, taken from the path as spelled (not realpath), because ACS
 * matches the holder by its command line, which names the `current` symlink.
 * The commit comes from RELEASE.json; a runtime outside an installed release
 * records `unreleased`, which ACS never recognizes as its managed executor.
 */
export function resolveJcReleaseIdentity(entrypoint: string): { releaseRoot: string; releaseCommit: string } {
  const releaseRoot = path.dirname(path.dirname(path.resolve(entrypoint)));
  try {
    const release = JSON.parse(fs.readFileSync(path.join(releaseRoot, 'RELEASE.json'), 'utf8')) as { commit?: unknown };
    if (typeof release.commit === 'string' && /^[A-Za-z0-9._-]{1,64}$/u.test(release.commit)) {
      return { releaseRoot, releaseCommit: release.commit };
    }
  } catch {
    // Not an installed release.
  }
  return { releaseRoot, releaseCommit: 'unreleased' };
}

/** Only a managed executor claims the ACS singleton. Standalone and local never do. */
export function executorLeaseRequired(mode: string): boolean {
  return mode === 'managed';
}

/** Linux process identity for a PID, or undefined when it cannot be proven. */
export function readLinuxProcessIdentity(pid: number): ProcessIdentity | undefined {
  try {
    const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm (field 2) may contain spaces and parentheses; starttime is field 22.
    const processStartTicks = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u)[19] ?? '';
    if (!BOOT_ID_PATTERN.test(bootId) || !TICKS_PATTERN.test(processStartTicks)) return undefined;
    return { bootId, processStartTicks };
  } catch {
    return undefined;
  }
}

/** Best-effort liveness: EPERM means the process exists but cannot be signalled. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EPERM');
  }
}

export function executorLeasePath(lockDir: string): string {
  return path.join(lockDir, LEASE_FILE);
}

export function defaultExecutorLockDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.DESKTOP_COMMANDER_EXECUTOR_LOCK_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), '.desktop-commander');
}

function isRecord(value: unknown): value is ExecutorLeaseRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.instanceId === 'string' &&
    v.instanceId.length > 0 &&
    Number.isInteger(v.pid) &&
    typeof v.expiresAt === 'number' &&
    typeof v.acquiredAt === 'number' &&
    typeof v.renews === 'number'
  );
}

/** Reads and validates the current record. `null` means absent; `'malformed'` means unreadable. */
function readRecord(file: string): ExecutorLeaseRecord | 'malformed' | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' ? null : 'malformed';
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : 'malformed';
  } catch {
    return 'malformed';
  }
}

/** Publishes a complete record at `target` exclusively. Returns false when the path already exists. */
function createExclusive(target: string, record: ExecutorLeaseRecord): boolean {
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(record, null, 2), { mode: 0o600, flag: 'wx' });
  try {
    fs.linkSync(temp, target);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') return false;
    throw error;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/** A holder is alive only when its PID lives and its boot id and start ticks still match. */
function holderIsLive(record: ExecutorLeaseRecord, options: AcquireOptions): boolean {
  if (!options.isAlive(record.pid)) return false;
  // Legacy records without process identity cannot prove the owner is gone: fail closed.
  if (typeof record.bootId !== 'string' || typeof record.processStartTicks !== 'string') return true;
  const actual = options.readIdentity(record.pid);
  // Unknown identity of a live PID is never evidence the owner is dead.
  if (!actual) return true;
  return actual.bootId === record.bootId && actual.processStartTicks === record.processStartTicks;
}

function buildRecord(options: AcquireOptions, identity: ProcessIdentity): ExecutorLeaseRecord {
  return {
    instanceId: options.instanceId,
    pid: options.pid,
    acquiredAt: options.nowMs,
    renews: 0,
    expiresAt: options.nowMs + options.ttlMs,
    hostname: os.hostname(),
    bootId: identity.bootId,
    processStartTicks: identity.processStartTicks,
    executorKind: JC_EXECUTOR_KIND,
    releaseRoot: options.releaseRoot,
    releaseCommit: options.releaseCommit,
  };
}

/** Takes over a provably stale lease under a mutex so only one process can replace it. */
function takeOverStale(lockPath: string, stale: ExecutorLeaseRecord, options: AcquireOptions): AcquireResult {
  const mutex = `${lockPath}.takeover`;
  let fd: number;
  try {
    fd = fs.openSync(mutex, 'wx', 0o600);
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
    // A takeover that crashed mid-way must not wedge the slot forever.
    const ageMs = Date.now() - fs.statSync(mutex).mtimeMs;
    if (ageMs < options.graceMs * 3) return { ok: false, reason: 'takeover-in-progress' };
    fs.rmSync(mutex, { force: true });
    return takeOverStale(lockPath, stale, options);
  }
  try {
    fs.closeSync(fd);
    // Re-check under the mutex: the record we judged stale must still be the one on disk.
    const current = readRecord(lockPath);
    if (current === null || current === 'malformed' || current.instanceId !== stale.instanceId) {
      return { ok: false, reason: 'lost-race' };
    }
    fs.rmSync(lockPath, { force: true });
    const identity = options.readIdentity(options.pid);
    if (!identity) return { ok: false, reason: 'process-identity-unavailable' };
    const record = buildRecord(options, identity);
    if (!createExclusive(lockPath, record)) return { ok: false, reason: 'lost-race' };
    return { ok: true, record, tookOverStale: true };
  } finally {
    fs.rmSync(mutex, { force: true });
  }
}

/** Acquires the native JC executor lease, or reports exactly why it cannot. */
export function acquireJcExecutorLease(options: AcquireOptions): AcquireResult {
  const identity = options.readIdentity(options.pid);
  // Without proof of this process's identity, a lease could only be spoofed. Refuse.
  if (!identity || !BOOT_ID_PATTERN.test(identity.bootId) || !TICKS_PATTERN.test(identity.processStartTicks)) {
    return { ok: false, reason: 'process-identity-unavailable' };
  }
  fs.mkdirSync(options.lockDir, { recursive: true, mode: 0o700 });
  const lockPath = executorLeasePath(options.lockDir);
  const record = buildRecord(options, identity);
  if (createExclusive(lockPath, record)) return { ok: true, record, tookOverStale: false };

  const existing = readRecord(lockPath);
  if (existing === null) {
    // Removed between our attempt and the read: one retry is enough to decide.
    return createExclusive(lockPath, record)
      ? { ok: true, record, tookOverStale: false }
      : { ok: false, reason: 'lost-race' };
  }
  if (existing === 'malformed') return { ok: false, reason: 'lease-unreadable' };
  if (holderIsLive(existing, options)) {
    return { ok: false, reason: 'held-by-live-process', blockedBy: existing.pid };
  }
  // A dead or reused holder is stale, but only after the grace window: restarts must not race a dying owner.
  if (options.nowMs - existing.acquiredAt < options.graceMs) {
    return { ok: false, reason: 'stale-within-grace', blockedBy: existing.pid };
  }
  return takeOverStale(lockPath, existing, options);
}

/** Extends the deadline of a lease this process holds. Reports `lost` if another owner has it. */
export function renewJcExecutorLease(input: {
  lockDir: string;
  record: ExecutorLeaseRecord;
  nowMs: number;
  ttlMs: number;
}): RenewResult {
  const lockPath = executorLeasePath(input.lockDir);
  const current = readRecord(lockPath);
  if (current === null || current === 'malformed' || current.instanceId !== input.record.instanceId) {
    return { ok: false, reason: 'lost' };
  }
  const next: ExecutorLeaseRecord = {
    ...input.record,
    renews: input.record.renews + 1,
    expiresAt: input.nowMs + input.ttlMs,
  };
  const temp = `${lockPath}.${process.pid}.${randomUUID()}.renew`;
  try {
    fs.writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, lockPath);
    return { ok: true, record: next };
  } catch {
    fs.rmSync(temp, { force: true });
    return { ok: false, reason: 'unwritable' };
  }
}

/** Releases the lease only if this process still owns it on disk. */
export function releaseJcExecutorLease(input: { lockDir: string; record: ExecutorLeaseRecord }): ReleaseResult {
  const lockPath = executorLeasePath(input.lockDir);
  const current = readRecord(lockPath);
  if (current === null) return { ok: false, reason: 'not-held' };
  if (current === 'malformed' || current.instanceId !== input.record.instanceId) {
    return { ok: false, reason: 'not-owner' };
  }
  fs.rmSync(lockPath, { force: true });
  return { ok: true };
}

export interface HeldExecutorLease {
  record: ExecutorLeaseRecord;
  release(): void;
}

/**
 * Acquires the lease and keeps it renewed for the life of the process. If the
 * lease is lost, `onLost` runs so the caller can fail closed and stop serving.
 */
export function holdJcExecutorLease(
  options: AcquireOptions & { renewMs: number; onLost: (reason: string) => void },
): { ok: true; lease: HeldExecutorLease } | { ok: false; reason: AcquireFailure; blockedBy?: number } {
  const acquired = acquireJcExecutorLease(options);
  if (!acquired.ok) return acquired;
  let record = acquired.record;
  let released = false;
  const timer: NodeJS.Timeout = setInterval(() => {
    const renewed = renewJcExecutorLease({ lockDir: options.lockDir, record, nowMs: Date.now(), ttlMs: options.ttlMs });
    if (renewed.ok) {
      record = renewed.record;
      return;
    }
    clearInterval(timer);
    released = true;
    options.onLost(renewed.reason);
  }, options.renewMs);
  const release = (): void => {
    if (released) return;
    released = true;
    clearInterval(timer);
    releaseJcExecutorLease({ lockDir: options.lockDir, record });
  };
  timer.unref();
  process.once('exit', release);
  return {
    ok: true,
    lease: {
      get record() {
        return record;
      },
      release,
    } as HeldExecutorLease,
  };
}
