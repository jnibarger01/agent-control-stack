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
 * Only a verified installed release may acquire the lease (verifyJcReleaseIdentity).
 * A development checkout is refused before it can occupy the slot, because ACS
 * would never recognize it and it would block the recognized executor.
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
  | 'release-unverified'
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
 * A release commit is an immutable git object id: 7 to 40 lowercase hex digits
 * (install-user-release.sh writes `git rev-parse --short=12`). Placeholders the
 * installer or older code can emit, such as `unknown` or `unreleased`, never match.
 */
export const JC_RELEASE_COMMIT_PATTERN = /^[0-9a-f]{7,40}$/u;

export type JcReleaseRefusal =
  | 'not-an-installed-release'
  | 'vendored-runtime'
  | 'release-root-unresolvable'
  | 'release-root-escapes-releases-dir'
  | 'entrypoint-escapes-release'
  | 'release-metadata-missing'
  | 'release-metadata-invalid'
  | 'release-commit-invalid';

export type JcReleaseVerification =
  | { ok: true; releaseRoot: string; releaseCommit: string }
  | { ok: false; reason: JcReleaseRefusal; detail: string };

const refuse = (reason: JcReleaseRefusal, detail: string): JcReleaseVerification => ({ ok: false, reason, detail });

/**
 * Proves the running entrypoint is an installed Jace Commander release, or says
 * exactly why not. Only a verified release may hold the managed executor lease.
 *
 * An installed release is `<prefix>/releases/<id>/dist/cli.js`, reached either
 * directly or through `<prefix>/current`, where `<id>` is a real directory inside
 * the real `<prefix>/releases`, its `dist/cli.js` lives inside it, and its
 * RELEASE.json names a git commit. A development checkout (`apps/jace-commander/dist`),
 * a vendored copy under node_modules, a `current` link pointed at a checkout,
 * or a release whose commit is missing or a placeholder is refused. Every
 * failure to read or prove any of this refuses; nothing falls back to a default.
 *
 * The returned root is spelled as the process spells it (not realpath), because
 * ACS matches the holder by its command line, which names the `current` link.
 */
export function verifyJcReleaseIdentity(entrypoint: string): JcReleaseVerification {
  if (typeof entrypoint !== 'string' || entrypoint.length === 0) {
    return refuse('not-an-installed-release', 'no entrypoint path');
  }
  const spelled = path.resolve(entrypoint);
  if (spelled.split(path.sep).includes('node_modules')) {
    return refuse('vendored-runtime', `${spelled} is under node_modules`);
  }
  if (path.basename(spelled) !== 'cli.js' || path.basename(path.dirname(spelled)) !== 'dist') {
    return refuse('not-an-installed-release', `${spelled} is not <release>/dist/cli.js`);
  }
  const releaseRoot = path.dirname(path.dirname(spelled));
  const slotParent = path.dirname(releaseRoot);
  let prefix: string;
  if (path.basename(releaseRoot) === 'current') {
    prefix = slotParent;
  } else if (path.basename(slotParent) === 'releases') {
    prefix = path.dirname(slotParent);
  } else {
    return refuse('not-an-installed-release', `${releaseRoot} is neither <prefix>/current nor <prefix>/releases/<id>`);
  }

  let realRoot: string;
  let realReleasesDir: string;
  let realEntrypoint: string;
  try {
    realRoot = fs.realpathSync(releaseRoot);
    realReleasesDir = fs.realpathSync(path.join(prefix, 'releases'));
    realEntrypoint = fs.realpathSync(spelled);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'error';
    return refuse('release-root-unresolvable', `${releaseRoot} could not be resolved (${code})`);
  }
  // `current` (or the root itself) must land on a real release directory, never a checkout.
  if (path.dirname(realRoot) !== realReleasesDir || !fs.statSync(realRoot).isDirectory()) {
    return refuse('release-root-escapes-releases-dir', `${releaseRoot} resolves to ${realRoot}, outside ${realReleasesDir}`);
  }
  // A release whose dist/cli.js links back into a checkout is not that release.
  if (realEntrypoint !== path.join(realRoot, 'dist', 'cli.js')) {
    return refuse('entrypoint-escapes-release', `${spelled} resolves to ${realEntrypoint}, outside ${realRoot}`);
  }

  const metadataPath = path.join(realRoot, 'RELEASE.json');
  let raw: string;
  try {
    const stat = fs.lstatSync(metadataPath);
    if (!stat.isFile()) return refuse('release-metadata-invalid', `${metadataPath} is not a regular file`);
    raw = fs.readFileSync(metadataPath, 'utf8');
  } catch {
    return refuse('release-metadata-missing', `${metadataPath} is missing or unreadable`);
  }
  let commit: unknown;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return refuse('release-metadata-invalid', `${metadataPath} is not a JSON object`);
    }
    commit = (parsed as { commit?: unknown }).commit;
  } catch {
    return refuse('release-metadata-invalid', `${metadataPath} is not valid JSON`);
  }
  if (typeof commit !== 'string' || !JC_RELEASE_COMMIT_PATTERN.test(commit)) {
    return refuse('release-commit-invalid', `${metadataPath} commit ${JSON.stringify(commit)} is not a git commit id`);
  }
  return { ok: true, releaseRoot, releaseCommit: commit };
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
  // Defense in depth: whatever the caller verified, never write a lease that names
  // no release or a placeholder commit. Callers prove the release with verifyJcReleaseIdentity.
  if (
    typeof options.releaseRoot !== 'string' ||
    options.releaseRoot.length === 0 ||
    typeof options.releaseCommit !== 'string' ||
    !JC_RELEASE_COMMIT_PATTERN.test(options.releaseCommit)
  ) {
    return { ok: false, reason: 'release-unverified' };
  }
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
