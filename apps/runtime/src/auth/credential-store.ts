// Local CLI credential storage for RFC 8628 device authorization.
// See docs/adr/0016-public-oauth-device-authorization.md.
//
// No OS keychain integration exists anywhere in this workspace today (checked: no
// keytar/libsecret dependency, no existing secure-storage convention for CLI clients).
// Adding one is disproportionate to this feature, so credentials are stored in a file
// under restrictive (0600) permissions. This is a documented limitation, not a silent
// gap - `acs auth status` and docs/oauth-authentication.md both say so.
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

const credentialSchema = z.object({
  v: z.literal(1),
  acsUrl: z.string().min(1),
  clientId: z.string().min(1),
  deviceName: z.string().min(1),
  devicePrivateKeyPem: z.string().min(1),
  devicePublicKeyPem: z.string().min(1),
  session: z
    .object({
      deviceId: z.string().min(1),
      principal: z.string().min(1),
      accessToken: z.string().min(1),
      accessTokenExpiresAt: z.string().min(1).refine((v) => Number.isFinite(Date.parse(v))),
      refreshToken: z.string().min(1),
      scopes: z.array(z.string())
    })
    .optional()
});

export type StoredCredentials = z.infer<typeof credentialSchema>;
export type StoredSession = NonNullable<StoredCredentials["session"]>;

export class CorruptCredentialsError extends Error {
  readonly code = "corrupt_credentials";

  constructor(path: string, detail: string) {
    super(`Credentials file is corrupt (${path}): ${detail}. Remove or repair it, then run \`acs auth login\`.`);
    this.name = "CorruptCredentialsError";
  }
}

export interface WriteCredentialsOptions {
  renameSyncImpl?: typeof renameSync;
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ACS_CLI_CREDENTIALS_PATH) return env.ACS_CLI_CREDENTIALS_PATH;
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(configHome, "acs", "credentials.json");
}

export function readCredentials(path: string): StoredCredentials | undefined {
  cleanupStaleTempFiles(path);
  if (!existsSync(path)) return undefined;
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    const detail = err instanceof Error ? err.message : "invalid JSON";
    throw new CorruptCredentialsError(path, detail);
  }
  const parsed = credentialSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new CorruptCredentialsError(path, "invalid schema");
  }
  return parsed.data;
}

export function writeCredentials(
  path: string,
  credentials: StoredCredentials,
  options: WriteCredentialsOptions = {}
): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  cleanupStaleTempFiles(path);

  const tempPath = join(dir, `${basename(path)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  const payload = Buffer.from(JSON.stringify(credentials, null, 2), "utf8");
  let fd: number | undefined;
  let renamed = false;

  try {
    fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    let offset = 0;
    while (offset < payload.length) {
      offset += writeSync(fd, payload, offset, payload.length - offset);
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    try {
      chmodSync(tempPath, 0o600);
    } catch {
      // best effort on platforms without POSIX permission bits (e.g. some Windows filesystems).
    }

    (options.renameSyncImpl ?? renameSync)(tempPath, path);
    renamed = true;
    fsyncDirectory(dir);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore close failure during cleanup
      }
    }
    if (!renamed) {
      try {
        unlinkSync(tempPath);
      } catch {
        // ignore cleanup failure
      }
    }
  }
}

export function writeSession(path: string, session: StoredSession): void {
  const existing = readCredentials(path);
  if (!existing) {
    throw new Error("cannot write a session before a device identity exists; call loadOrCreateDeviceIdentity first");
  }
  writeCredentials(path, { ...existing, session });
}

/** Clears the session (tokens + server identity) but keeps the device keypair, so a
 * subsequent login is recognized by the server as the same device. This is "local
 * logout," distinct from server-side device revocation. */
export function clearSession(path: string): void {
  const existing = readCredentials(path);
  if (!existing) return;
  const { session: _session, ...rest } = existing;
  writeCredentials(path, rest);
}

/** Deletes the credentials file entirely, including the device keypair. Used only when
 * the caller explicitly wants a fresh device identity, not by plain `acs auth logout`. */
export function deleteCredentials(path: string): void {
  if (existsSync(path)) rmSync(path);
}

function cleanupStaleTempFiles(targetPath: string): void {
  const dir = dirname(targetPath);
  if (!existsSync(dir)) return;
  const prefix = `${basename(targetPath)}.tmp-`;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  const nowMs = Date.now();
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const full = join(dir, entry);
    const pidPart = entry.slice(prefix.length).split("-")[0];
    const pid = Number(pidPart);
    const pidDead = Number.isInteger(pid) && pid > 0 && pid !== process.pid && !isProcessAlive(pid);

    let ageMs: number;
    try {
      ageMs = nowMs - statSync(full).mtimeMs;
    } catch {
      continue;
    }

    if (pidDead || ageMs > 5_000) {
      try {
        unlinkSync(full);
      } catch {
        // ignore concurrent unlink
      }
    }
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

function fsyncDirectory(dir: string): void {
  let dirFd: number | undefined;
  try {
    dirFd = openSync(dir, constants.O_RDONLY);
    fsyncSync(dirFd);
  } catch {
    // Directory fsync is not supported on all filesystems/platforms.
  } finally {
    if (dirFd !== undefined) {
      try {
        closeSync(dirFd);
      } catch {
        // ignore close failure
      }
    }
  }
}
