// Local CLI credential storage for RFC 8628 device authorization.
// See docs/adr/0016-public-oauth-device-authorization.md.
//
// No OS keychain integration exists anywhere in this workspace today (checked: no
// keytar/libsecret dependency, no existing secure-storage convention for CLI clients).
// Adding one is disproportionate to this feature, so credentials are stored in a file
// under restrictive (0600) permissions. This is a documented limitation, not a silent
// gap - `acs auth status` and docs/oauth-authentication.md both say so.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
      accessTokenExpiresAt: z.string().min(1),
      refreshToken: z.string().min(1),
      scopes: z.array(z.string())
    })
    .optional()
});

export type StoredCredentials = z.infer<typeof credentialSchema>;
export type StoredSession = NonNullable<StoredCredentials["session"]>;

/**
 * Raised when the credentials file exists but cannot be used (unreadable, not JSON,
 * or not the v1 credentials shape). Callers must fail closed rather than treat this
 * as "no credentials": regenerating a device identity would silently replace the
 * operator's keypair and re-register the device on the server. The message never
 * includes file contents - the file holds a private key and session tokens.
 */
export class CredentialsFileCorruptError extends Error {
  readonly code = "credentials_file_corrupt";

  constructor(
    readonly path: string,
    readonly reason: string
  ) {
    super(
      `ACS CLI credentials file is unusable: ${path} (${reason}). ` +
        "Move or delete that file, then run `acs auth login` to register this device again."
    );
    this.name = "CredentialsFileCorruptError";
  }
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ACS_CLI_CREDENTIALS_PATH) return env.ACS_CLI_CREDENTIALS_PATH;
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(configHome, "acs", "credentials.json");
}

/** Returns undefined only when the file is absent. A present-but-unusable file throws
 * `CredentialsFileCorruptError` so the CLI can print an actionable message instead of a
 * raw JSON parse error, and so no caller silently overwrites the operator's identity. */
export function readCredentials(path: string): StoredCredentials | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw new CredentialsFileCorruptError(path, `cannot read the file (${code ?? "unknown error"})`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new CredentialsFileCorruptError(path, "the file is not valid JSON");
  }
  const parsed = credentialSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new CredentialsFileCorruptError(path, "the file does not match the stored-credentials schema (v1)");
  }
  return parsed.data;
}

export function writeCredentials(path: string, credentials: StoredCredentials): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(credentials, null, 2), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort on platforms without POSIX permission bits (e.g. some Windows filesystems).
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
