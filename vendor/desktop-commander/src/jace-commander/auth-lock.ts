/**
 * Cross-process file lock and pending-refresh recovery journal for auth operations.
 *
 * Uses O_CREAT | O_EXCL + linkSync atomic lock publishing (matching
 * apps/runtime/src/auth/refresh.ts) so concurrent CLI processes serialize token
 * refresh and rotation safely, with PID/inode stale-lock reclamation.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const LOCK_CORRUPT_GRACE_MS = 2_000;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_POLL_MS = 25;

export interface AuthLockOptions {
  lockName?: string;
  timeoutMs?: number;
  pollMs?: number;
  isProcessAlive?: (pid: number) => boolean;
}

export interface PendingRefreshRecord {
  domain: 'jc-mcp' | 'acs';
  url: string;
  clientId: string;
  deviceId?: string | null;
  refreshRequestId: string;
  oldRefreshTokenHash: string;
  startedAt: string;
}

interface LockPayload {
  pid: number;
  token: string;
  acquiredAtMs: number;
}

interface LockHandle {
  lockPath: string;
  token: string;
  ino: number;
  dev: number;
}

type StaleInspection =
  | { stale: false }
  | { stale: true; ino: number; dev: number; raw: string };

export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink()) {
      throw new Error(`refusing symlink state directory: ${dir}`);
    }
    fs.chmodSync(dir, 0o700);
  } catch (error) {
    if (error instanceof Error && /refusing symlink/.test(error.message)) throw error;
  }
}

export function writePrivateFileAtomic(targetPath: string, content: string): void {
  const dir = path.dirname(targetPath);
  ensurePrivateDir(dir);
  if (fs.existsSync(targetPath)) {
    const st = fs.lstatSync(targetPath);
    if (st.isSymbolicLink()) {
      throw new Error(`refusing to overwrite symlink: ${targetPath}`);
    }
  }
  const tmpPath = `${targetPath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const payload = Buffer.from(content, 'utf8');
  let fd: number | undefined;
  let renamed = false;
  try {
    fd = fs.openSync(tmpPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    let offset = 0;
    while (offset < payload.length) {
      offset += fs.writeSync(fd, payload, offset, payload.length - offset);
    }
    fs.fsyncSync(fd);
    try {
      fs.fchmodSync(fd, 0o600);
    } catch {
      // ignore on platforms without POSIX fchmod
    }
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmpPath, targetPath);
    renamed = true;
    fsyncDirectory(dir);
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
    if (!renamed) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
    }
  }
}

function fsyncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch {
    // Directory fsync not supported on all filesystems
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

export function pendingRefreshPath(stateDir: string, domain: 'jc-mcp' | 'acs' = 'jc-mcp'): string {
  return path.join(stateDir, domain === 'jc-mcp' ? 'pending-refresh.json' : 'pending-acs-refresh.json');
}

export function readPendingRefresh(stateDir: string, domain: 'jc-mcp' | 'acs' = 'jc-mcp'): PendingRefreshRecord | undefined {
  const target = pendingRefreshPath(stateDir, domain);
  try {
    if (!fs.existsSync(target)) return undefined;
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) return undefined;
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as Partial<PendingRefreshRecord>;
    if (
      parsed &&
      parsed.domain === domain &&
      typeof parsed.url === 'string' &&
      typeof parsed.clientId === 'string' &&
      typeof parsed.refreshRequestId === 'string' &&
      typeof parsed.oldRefreshTokenHash === 'string'
    ) {
      return parsed as PendingRefreshRecord;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function writePendingRefresh(stateDir: string, record: PendingRefreshRecord): void {
  writePrivateFileAtomic(pendingRefreshPath(stateDir, record.domain), JSON.stringify(record, null, 2));
}

export function clearPendingRefresh(stateDir: string, domain: 'jc-mcp' | 'acs' = 'jc-mcp'): void {
  fs.rmSync(pendingRefreshPath(stateDir, domain), { force: true });
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === 'EPERM';
  }
}

function writeAllSync(fd: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) {
    const written = fs.writeSync(fd, data, offset, data.length - offset);
    if (written <= 0) throw new Error('Short write creating auth lockfile');
    offset += written;
  }
}

function tryAcquireLockFile(lockPath: string, token: string, nowMs: number): LockHandle {
  const tmpPath = `${lockPath}.tmp.${process.pid}.${crypto.randomBytes(8).toString('hex')}`;
  const fd = fs.openSync(tmpPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  let stats: fs.Stats;
  try {
    const payload: LockPayload = { pid: process.pid, token, acquiredAtMs: nowMs };
    writeAllSync(fd, Buffer.from(JSON.stringify(payload), 'utf8'));
    stats = fs.fstatSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(tmpPath, lockPath);
    return { lockPath, token, ino: stats.ino, dev: stats.dev };
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
  }
}

function parseLockPayload(raw: string): { pid: number; token?: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as Partial<LockPayload>;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.pid === 'number' &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.token === 'string' &&
      parsed.token.length > 0
    ) {
      return { pid: parsed.pid, token: parsed.token };
    }
  } catch {
    // ignore
  }
  return null;
}

function inspectStaleLock(lockPath: string, nowMs: number, checkAlive: (pid: number) => boolean): StaleInspection {
  try {
    const stats = fs.lstatSync(lockPath);
    if (stats.isSymbolicLink()) return { stale: true, ino: stats.ino, dev: stats.dev, raw: '' };
    const raw = fs.readFileSync(lockPath, 'utf8');
    const parsed = parseLockPayload(raw);
    if (parsed !== null) {
      if (parsed.pid === process.pid || checkAlive(parsed.pid)) {
        return { stale: false };
      }
      return { stale: true, ino: stats.ino, dev: stats.dev, raw };
    }
    if (nowMs - stats.mtimeMs > LOCK_CORRUPT_GRACE_MS) {
      return { stale: true, ino: stats.ino, dev: stats.dev, raw };
    }
    return { stale: false };
  } catch {
    return { stale: false };
  }
}

function quarantineAndRemove(lockPath: string, expectedIno: number, expectedDev: number): boolean {
  try {
    const stats = fs.lstatSync(lockPath);
    if (stats.ino !== expectedIno || stats.dev !== expectedDev) return false;
    const trashPath = `${lockPath}.dead.${process.pid}.${crypto.randomBytes(8).toString('hex')}`;
    fs.renameSync(lockPath, trashPath);
    try {
      fs.unlinkSync(trashPath);
    } catch {
      // ignore
    }
    return true;
  } catch {
    return false;
  }
}

function reclaimStaleLock(
  lockPath: string,
  expectedIno: number,
  expectedDev: number,
  expectedRaw: string,
  nowMs: number,
  checkAlive: (pid: number) => boolean,
): boolean {
  const reclaimPath = `${lockPath}.reclaim`;
  let reclaimHandle: LockHandle;
  try {
    reclaimHandle = tryAcquireLockFile(reclaimPath, crypto.randomBytes(16).toString('hex'), nowMs);
  } catch {
    const staleReclaim = inspectStaleLock(reclaimPath, nowMs, checkAlive);
    if (staleReclaim.stale) quarantineAndRemove(reclaimPath, staleReclaim.ino, staleReclaim.dev);
    return false;
  }
  try {
    const stats = fs.lstatSync(lockPath);
    if (stats.ino !== expectedIno || stats.dev !== expectedDev) return false;
    const raw = stats.isSymbolicLink() ? '' : fs.readFileSync(lockPath, 'utf8');
    if (raw !== expectedRaw) return false;
    const recheck = inspectStaleLock(lockPath, nowMs, checkAlive);
    if (!recheck.stale) return false;
    return quarantineAndRemove(lockPath, expectedIno, expectedDev);
  } catch {
    return false;
  } finally {
    releaseLockFile(reclaimHandle);
  }
}

function releaseLockFile(handle: LockHandle): void {
  try {
    const stats = fs.lstatSync(handle.lockPath);
    if (stats.ino !== handle.ino || stats.dev !== handle.dev) return;
    const parsed = parseLockPayload(fs.readFileSync(handle.lockPath, 'utf8'));
    if (!parsed || parsed.token !== handle.token || parsed.pid !== process.pid) return;
    quarantineAndRemove(handle.lockPath, handle.ino, handle.dev);
  } catch {
    // ignore
  }
}

export async function withAuthLock<T>(
  stateDir: string,
  fn: () => Promise<T>,
  options: AuthLockOptions = {},
): Promise<T> {
  ensurePrivateDir(stateDir);
  const lockPath = path.join(stateDir, options.lockName ?? 'auth.lock');
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_LOCK_POLL_MS;
  const checkAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const deadline = Date.now() + timeoutMs;
  const token = crypto.randomBytes(16).toString('hex');
  let handle: LockHandle | undefined;

  while (!handle) {
    const attemptNow = Date.now();
    try {
      handle = tryAcquireLockFile(lockPath, token, attemptNow);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'EEXIST') {
        throw new Error(`Failed to acquire auth lock: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
      const inspection = inspectStaleLock(lockPath, attemptNow, checkAlive);
      if (inspection.stale) {
        if (reclaimStaleLock(lockPath, inspection.ino, inspection.dev, inspection.raw, attemptNow, checkAlive)) {
          continue;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out after ${timeoutMs}ms waiting for auth lock`, { cause: err });
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  try {
    return await fn();
  } finally {
    releaseLockFile(handle);
  }
}
