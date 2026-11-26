import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { dirname } from "node:path";
import {
  credentialsPath,
  readCredentials,
  writeSession,
  type StoredCredentials,
  type StoredSession
} from "./credential-store.js";

export const DEFAULT_REFRESH_THRESHOLD_MS = 60_000;
const LOCK_CORRUPT_GRACE_MS = 2_000;
const LOCK_WAIT_TIMEOUT_MS = 5_000;
const LOCK_POLL_MS = 25;

export type RefreshFailureReason =
  | "not_authenticated"
  | "device_revoked"
  | "refresh_expired"
  | "refresh_replay"
  | "unknown_refresh_token"
  | "invalid_grant"
  | "missing_proof"
  | "invalid_proof"
  | "recovery_unavailable"
  | "transient_error";

export class RefreshSessionError extends Error {
  readonly reason: RefreshFailureReason;
  readonly requiresLogin: boolean;

  constructor(reason: RefreshFailureReason, requiresLogin: boolean, message: string) {
    super(message);
    this.name = "RefreshSessionError";
    this.reason = reason;
    this.requiresLogin = requiresLogin;
  }
}

export interface RefreshSessionOptions {
  acsUrl?: string;
  credentialsPathOverride?: string;
  env?: NodeJS.ProcessEnv;
  force?: boolean;
  refreshThresholdMs?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
  lockTimeoutMs?: number;
  lockPollMs?: number;
}

export interface RefreshSessionResult {
  refreshed: boolean;
  session: StoredSession;
}

export async function refreshSession(options: RefreshSessionOptions = {}): Promise<RefreshSessionResult> {
  const env = options.env ?? process.env;
  const path = options.credentialsPathOverride ?? credentialsPath(env);
  const now = options.now ?? Date.now;
  const thresholdMs = options.refreshThresholdMs ?? DEFAULT_REFRESH_THRESHOLD_MS;

  const initial = readCredentials(path);
  if (!initial?.session) {
    throw new RefreshSessionError("not_authenticated", true, "Not authenticated. Run `acs auth login`.");
  }

  if (!options.force && !needsRefresh(initial.session, now(), thresholdMs)) {
    return { refreshed: false, session: initial.session };
  }

  return withCredentialLock(
    path,
    async () => {
      const credentials = readCredentials(path);
      if (!credentials?.session) {
        throw new RefreshSessionError("not_authenticated", true, "Not authenticated. Run `acs auth login`.");
      }

      const currentNowMs = now();
      if (!options.force && !needsRefresh(credentials.session, currentNowMs, thresholdMs)) {
        return { refreshed: false, session: credentials.session };
      }

      const acsUrl = trimTrailingSlash(options.acsUrl ?? credentials.acsUrl);
      const nextSession = await requestTokenRefresh(acsUrl, credentials, credentials.session, currentNowMs, options.fetchImpl ?? fetch);

      writeSession(path, nextSession);
      return { refreshed: true, session: nextSession };
    },
    {
      timeoutMs: options.lockTimeoutMs,
      pollMs: options.lockPollMs
    }
  );
}

function needsRefresh(session: StoredSession, nowMs: number, thresholdMs: number): boolean {
  const expiresAtMs = Date.parse(session.accessTokenExpiresAt);
  if (!Number.isFinite(expiresAtMs)) return true;
  return expiresAtMs - nowMs <= thresholdMs;
}

async function requestTokenRefresh(
  acsUrl: string,
  credentials: StoredCredentials,
  session: StoredSession,
  nowMs: number,
  fetchImpl: typeof fetch
): Promise<StoredSession> {
  const proofIssuedAt = Math.floor(nowMs / 1000);
  const refreshProof = signRefreshProof(
    credentials.devicePrivateKeyPem,
    credentials.clientId,
    session.deviceId,
    session.refreshToken,
    proofIssuedAt
  );

  let response: Response;
  try {
    response = await fetchImpl(`${acsUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: credentials.clientId,
        refresh_token: session.refreshToken,
        device_id: session.deviceId,
        proof_issued_at: String(proofIssuedAt),
        refresh_proof: refreshProof
      }).toString()
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "network error";
    throw new RefreshSessionError("transient_error", false, `Token refresh request failed: ${detail}`);
  }

  let body: Record<string, unknown> = {};
  try {
    const parsed = await response.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    if (!response.ok) {
      throw new RefreshSessionError("transient_error", false, `Token refresh failed with HTTP ${response.status}.`);
    }
    throw new RefreshSessionError("transient_error", false, "Token refresh returned invalid JSON.");
  }

  if (!response.ok) {
    throw mapRefreshError(response.status, body);
  }

  const accessToken = typeof body.access_token === "string" ? body.access_token : "";
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : "";
  const expiresIn = Number(body.expires_in);
  if (!accessToken || !refreshToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new RefreshSessionError("transient_error", false, "Token refresh response is missing required token fields.");
  }
  if (typeof body.device_id === "string" && body.device_id && body.device_id !== session.deviceId) {
    throw new RefreshSessionError("transient_error", false, "Token refresh response returned a mismatched device_id.");
  }

  return {
    deviceId: session.deviceId,
    principal: typeof body.principal === "string" && body.principal ? body.principal : session.principal,
    accessToken,
    accessTokenExpiresAt: new Date(nowMs + expiresIn * 1000).toISOString(),
    refreshToken,
    scopes: typeof body.scope === "string" ? body.scope.split(/\s+/).filter(Boolean) : session.scopes
  };
}

function mapRefreshError(status: number, body: Record<string, unknown>): RefreshSessionError {
  const oauthError = typeof body.error === "string" ? body.error : "unknown_error";
  const acsReason = typeof body.acs_reason === "string" ? body.acs_reason : undefined;

  switch (acsReason) {
    case "device_revoked":
      return new RefreshSessionError(
        "device_revoked",
        true,
        "Device has been revoked on the gateway. Run `acs auth login` to re-authenticate."
      );
    case "refresh_expired":
      return new RefreshSessionError(
        "refresh_expired",
        true,
        "Refresh token has expired. Run `acs auth login` to re-authenticate."
      );
    case "refresh_replay":
      return new RefreshSessionError(
        "refresh_replay",
        true,
        "Refresh token replay was detected and the device session was invalidated. Run `acs auth login` to re-authenticate."
      );
    case "unknown_refresh_token":
      return new RefreshSessionError(
        "unknown_refresh_token",
        true,
        "Refresh token is no longer recognized. Run `acs auth login` to re-authenticate."
      );
    case "missing_proof":
      return new RefreshSessionError(
        "missing_proof",
        false,
        "Token refresh failed: gateway reported missing device proof-of-possession."
      );
    case "invalid_proof":
      return new RefreshSessionError(
        "invalid_proof",
        false,
        "Token refresh failed: gateway rejected the device Ed25519 refresh proof."
      );
    case "recovery_unavailable":
      return new RefreshSessionError(
        "recovery_unavailable",
        false,
        "Gateway refresh recovery is temporarily unavailable; retry later."
      );
    default:
      break;
  }

  if (oauthError === "invalid_grant") {
    return new RefreshSessionError(
      "invalid_grant",
      true,
      "Session refresh was rejected (invalid_grant). Run `acs auth login` to re-authenticate."
    );
  }

  return new RefreshSessionError(
    "transient_error",
    false,
    `Token refresh failed (HTTP ${status}, ${oauthError}).`
  );
}

export function signRefreshProof(
  devicePrivateKeyPem: string,
  clientId: string,
  deviceId: string,
  refreshToken: string,
  issuedAtSeconds: number
): string {
  const privateKey = createPrivateKey(devicePrivateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("device private key must be Ed25519");
  }
  const refreshTokenSha256 = createHash("sha256").update(refreshToken, "utf8").digest("hex");
  const message = [
    "acs-device-refresh-proof-v1",
    `client_id=${clientId}`,
    `device_id=${deviceId}`,
    `refresh_token_sha256=${refreshTokenSha256}`,
    "operation=refresh_token",
    `issued_at=${issuedAtSeconds}`
  ].join("\n");
  return sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64url");
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export interface CredentialLockOptions {
  timeoutMs?: number;
  pollMs?: number;
  isProcessAlive?: (pid: number) => boolean;
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

/**
 * Serializes credential-file refresh operations across processes and in-process callers.
 * Never executes `fn` unless the lock is demonstrably acquired, and never reclaims
 * a lock whose owning process is still alive.
 */
export async function withCredentialLock<T>(
  credPath: string,
  fn: () => Promise<T>,
  options: CredentialLockOptions = {}
): Promise<T> {
  const lockPath = `${credPath}.lock`;
  const timeoutMs = options.timeoutMs ?? LOCK_WAIT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? LOCK_POLL_MS;
  const checkAlive = options.isProcessAlive ?? isProcessAlive;

  mkdirSync(dirname(credPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  const token = randomBytes(16).toString("hex");
  let handle: LockHandle | undefined;

  while (!handle) {
    const attemptNow = Date.now();
    try {
      handle = tryAcquireLockFile(lockPath, token, attemptNow);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") {
        const detail = err instanceof Error ? err.message : String(err);
        throw new RefreshSessionError(
          "transient_error",
          false,
          `Failed to acquire credential lock: ${detail}`
        );
      }

      const inspection = inspectStaleLock(lockPath, attemptNow, checkAlive);
      if (inspection.stale) {
        const reclaimed = reclaimStaleLock(
          lockPath,
          inspection.ino,
          inspection.dev,
          inspection.raw,
          attemptNow,
          checkAlive
        );
        if (reclaimed) {
          continue;
        }
      }

      if (Date.now() >= deadline) {
        throw new RefreshSessionError(
          "transient_error",
          false,
          `Timed out after ${timeoutMs}ms waiting for credential lock.`
        );
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

function writeAllSync(fd: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) {
    const written = writeSync(fd, data, offset, data.length - offset);
    if (written <= 0) {
      throw new Error("Short write while creating credential lockfile");
    }
    offset += written;
  }
}

function tryAcquireLockFile(lockPath: string, token: string, nowMs: number): LockHandle {
  const tmpPath = `${lockPath}.tmp.${process.pid}.${randomBytes(8).toString("hex")}`;
  const fd = openSync(tmpPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  let stats: ReturnType<typeof fstatSync>;
  try {
    const payload: LockPayload = { pid: process.pid, token, acquiredAtMs: nowMs };
    writeAllSync(fd, Buffer.from(JSON.stringify(payload), "utf8"));
    stats = fstatSync(fd);
  } finally {
    closeSync(fd);
  }

  try {
    // Hard-link atomically publishes the fully written lockfile inode, eliminating any
    // empty/partial-write window at `lockPath` while still failing with EEXIST on contention.
    linkSync(tmpPath, lockPath);
    return { lockPath, token, ino: stats.ino, dev: stats.dev };
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore temp cleanup failure
    }
  }
}

function quarantineAndRemove(path: string, expectedIno: number, expectedDev: number): boolean {
  try {
    const stats = statSync(path);
    if (stats.ino !== expectedIno || stats.dev !== expectedDev) {
      return false;
    }
    const trashPath = `${path}.dead.${process.pid}.${randomBytes(8).toString("hex")}`;
    // Renaming moves this exact directory entry away atomically; a concurrent creator
    // would then publish a new entry at `path` instead of being unlinked by us.
    renameSync(path, trashPath);
    try {
      unlinkSync(trashPath);
    } catch {
      // ignore trash cleanup failure
    }
    return true;
  } catch {
    return false;
  }
}

function releaseLockFile(handle: LockHandle): void {
  try {
    const stats = statSync(handle.lockPath);
    if (stats.ino !== handle.ino || stats.dev !== handle.dev) {
      return;
    }
    const raw = readFileSync(handle.lockPath, "utf8");
    const parsed = parseLockPayload(raw);
    if (!parsed || parsed.token !== handle.token || parsed.pid !== process.pid) {
      return;
    }
    quarantineAndRemove(handle.lockPath, handle.ino, handle.dev);
  } catch {
    // ignore lock cleanup failure (e.g., ENOENT)
  }
}

function parseLockPayload(raw: string): { pid: number; token?: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const pid = Number(trimmed);
    return Number.isInteger(pid) && pid > 0 ? { pid } : null;
  }
  try {
    const parsed = JSON.parse(trimmed) as Partial<LockPayload>;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.token === "string" &&
      parsed.token.length > 0
    ) {
      return { pid: parsed.pid, token: parsed.token };
    }
  } catch {
    // fall through to null
  }
  return null;
}

function inspectStaleLock(
  lockPath: string,
  nowMs: number,
  checkAlive: (pid: number) => boolean
): StaleInspection {
  try {
    const stats = statSync(lockPath);
    const raw = readFileSync(lockPath, "utf8");
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

function cleanupStaleReclaimLock(
  reclaimPath: string,
  nowMs: number,
  checkAlive: (pid: number) => boolean
): void {
  const reclaimStale = inspectStaleLock(reclaimPath, nowMs, checkAlive);
  if (!reclaimStale.stale) {
    return;
  }

  const guardPath = `${reclaimPath}.guard`;
  const guardToken = randomBytes(16).toString("hex");
  let guardHandle: LockHandle;
  try {
    guardHandle = tryAcquireLockFile(guardPath, guardToken, nowMs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
      const guardStale = inspectStaleLock(guardPath, nowMs, checkAlive);
      if (guardStale.stale) {
        quarantineAndRemove(guardPath, guardStale.ino, guardStale.dev);
      }
    }
    return;
  }

  try {
    const currentStats = statSync(reclaimPath);
    if (currentStats.ino !== reclaimStale.ino || currentStats.dev !== reclaimStale.dev) {
      return;
    }
    const currentRaw = readFileSync(reclaimPath, "utf8");
    if (currentRaw !== reclaimStale.raw) {
      return;
    }
    const recheck = inspectStaleLock(reclaimPath, nowMs, checkAlive);
    if (recheck.stale) {
      quarantineAndRemove(reclaimPath, reclaimStale.ino, reclaimStale.dev);
    }
  } catch {
    // ignore concurrent reclaim cleanup
  } finally {
    releaseLockFile(guardHandle);
  }
}

function reclaimStaleLock(
  lockPath: string,
  expectedIno: number,
  expectedDev: number,
  expectedRaw: string,
  nowMs: number,
  checkAlive: (pid: number) => boolean
): boolean {
  const reclaimPath = `${lockPath}.reclaim`;
  const reclaimToken = randomBytes(16).toString("hex");
  let reclaimHandle: LockHandle;

  try {
    reclaimHandle = tryAcquireLockFile(reclaimPath, reclaimToken, nowMs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
      cleanupStaleReclaimLock(reclaimPath, nowMs, checkAlive);
    }
    return false;
  }

  try {
    const currentStats = statSync(lockPath);
    if (currentStats.ino !== expectedIno || currentStats.dev !== expectedDev) {
      return false;
    }
    const currentRaw = readFileSync(lockPath, "utf8");
    if (currentRaw !== expectedRaw) {
      return false;
    }
    const recheck = inspectStaleLock(lockPath, nowMs, checkAlive);
    if (!recheck.stale) {
      return false;
    }
    return quarantineAndRemove(lockPath, expectedIno, expectedDev);
  } catch {
    return false;
  } finally {
    releaseLockFile(reclaimHandle);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === "EPERM";
  }
}
