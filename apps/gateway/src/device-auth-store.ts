// RFC 8628 device authorization persistence. See docs/adr/0015-public-oauth-device-authorization.md.
//
// This is a narrowly-scoped authorization-server component, deliberately kept separate
// from apps/gateway/src/auth.ts (the MCP *resource-server* JWT verifier) and from
// packages/work-items/src/store.ts's connector_records (operator-provisioned tunnel
// infrastructure, a different trust model). It owns exactly two tables: `devices` and
// `oauth_device_authorizations` (storage/migrations/009_device_auth.sql).
import { createHash, randomBytes, randomInt } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createId } from "@agent-control-stack/shared";

export const DEFAULT_DEVICE_AUTH_CLIENT_ID = "acs-cli";
const DEVICE_CODE_TTL_SECONDS = 15 * 60;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const SLOW_DOWN_INCREMENT_SECONDS = 5;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I - avoids transcription errors
const DISALLOWED_DEVICE_SCOPES = new Set(["acs:work:approve"]);

export interface DeviceCodeRequestInput {
  clientId: string;
  requestedScopes: string[];
  devicePublicKeyPem: string;
  deviceName: string;
  now?: Date;
}

export type DeviceCodeRequestResult =
  | {
      ok: true;
      deviceCode: string;
      userCode: string;
      userCodeFormatted: string;
      expiresIn: number;
      interval: number;
    }
  | { ok: false; error: "invalid_client" | "invalid_scope" };

export type DeviceTokenPollResult =
  | { status: "authorization_pending" }
  | { status: "slow_down"; interval: number }
  | { status: "access_denied" }
  | { status: "expired_token" }
  | { status: "invalid_grant" }
  | { status: "invalid_client" }
  | {
      status: "success";
      deviceId: string;
      principalId: string;
      scopes: string[];
      accessToken: string;
      accessTokenExpiresIn: number;
      refreshToken: string;
      refreshTokenExpiresIn: number;
    };

export interface DeviceAuthorizationSummary {
  id: string;
  clientId: string;
  requestedScopes: string[];
  deviceName: string;
  devicePublicKeyFingerprint: string;
  status: "pending" | "approved" | "denied" | "consumed" | "expired";
  expiresAt: string;
}

export interface DeviceRecord {
  id: string;
  principalId: string;
  name: string;
  status: "active" | "revoked";
  allowedScopes: string[];
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

interface DeviceAuthorizationRow {
  id: string;
  device_code_hash: string;
  user_code_hash: string;
  client_id: string;
  requested_scopes_json: string;
  device_public_key_pem: string;
  device_name: string;
  principal_id: string | null;
  device_id: string | null;
  status: string;
  poll_interval_seconds: number;
  last_polled_at: string | null;
  poll_count: number;
  created_at: string;
  expires_at: string;
  approved_at: string | null;
  denied_at: string | null;
  consumed_at: string | null;
}

interface DeviceRow {
  id: string;
  principal_id: string;
  name: string;
  public_key_pem: string;
  allowed_scopes_json: string;
  status: string;
  metadata_json: string;
  refresh_token_hash: string | null;
  refresh_token_expires_at: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

export class DeviceAuthStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  close(): void {
    this.db.close();
  }

  requestDeviceCode(
    input: DeviceCodeRequestInput,
    allowedClientIds: readonly string[] = [DEFAULT_DEVICE_AUTH_CLIENT_ID]
  ): DeviceCodeRequestResult {
    if (!allowedClientIds.includes(input.clientId)) {
      return { ok: false, error: "invalid_client" };
    }
    const scopes = [...new Set(input.requestedScopes)];
    if (scopes.length === 0 || scopes.some((scope) => DISALLOWED_DEVICE_SCOPES.has(scope))) {
      return { ok: false, error: "invalid_scope" };
    }
    const now = input.now ?? new Date();
    const deviceCode = randomBytes(32).toString("base64url");
    const userCode = generateUserCode();
    const id = createId("devauth");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO oauth_device_authorizations
           (id, device_code_hash, user_code_hash, client_id, requested_scopes_json,
            device_public_key_pem, device_name, status, poll_interval_seconds, poll_count,
            created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?)`
        )
        .run(
          id,
          sha256(deviceCode),
          sha256(userCode),
          input.clientId,
          JSON.stringify(scopes),
          input.devicePublicKeyPem,
          input.deviceName,
          DEFAULT_POLL_INTERVAL_SECONDS,
          now.toISOString(),
          new Date(now.getTime() + DEVICE_CODE_TTL_SECONDS * 1000).toISOString()
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return {
      ok: true,
      deviceCode,
      userCode,
      userCodeFormatted: formatUserCode(userCode),
      expiresIn: DEVICE_CODE_TTL_SECONDS,
      interval: DEFAULT_POLL_INTERVAL_SECONDS
    };
  }

  /** Looks up a pending authorization by the human-typed user code, for the /device/verify screen. */
  findByUserCode(rawUserCode: string, now: Date = new Date()): DeviceAuthorizationSummary | undefined {
    const normalized = normalizeUserCode(rawUserCode);
    if (!normalized) return undefined;
    const row = this.db
      .prepare(`SELECT * FROM oauth_device_authorizations WHERE user_code_hash = ?`)
      .get(sha256(normalized)) as DeviceAuthorizationRow | undefined;
    if (!row) return undefined;
    this.expireIfNeeded(row, now);
    const fresh = this.getById(row.id);
    return fresh && toSummary(fresh);
  }

  approve(
    rawUserCode: string,
    principalId: string,
    now: Date = new Date()
  ): { ok: true } | { ok: false; error: string } {
    const normalized = normalizeUserCode(rawUserCode);
    if (!normalized) return { ok: false, error: "not_found" };
    const row = this.db
      .prepare(`SELECT * FROM oauth_device_authorizations WHERE user_code_hash = ?`)
      .get(sha256(normalized)) as DeviceAuthorizationRow | undefined;
    if (!row) return { ok: false, error: "not_found" };
    this.expireIfNeeded(row, now);
    const fresh = this.getById(row.id)!;
    if (fresh.status === "expired") return { ok: false, error: "expired" };
    if (fresh.status !== "pending") return { ok: false, error: "not_pending" };

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const deviceId = this.upsertDeviceForApproval(fresh, principalId, now);
      this.db
        .prepare(
          `UPDATE oauth_device_authorizations
           SET status = 'approved', principal_id = ?, device_id = ?, approved_at = ?
           WHERE id = ? AND status = 'pending'`
        )
        .run(principalId, deviceId, now.toISOString(), fresh.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { ok: true };
  }

  deny(rawUserCode: string, now: Date = new Date()): { ok: true } | { ok: false; error: string } {
    const normalized = normalizeUserCode(rawUserCode);
    if (!normalized) return { ok: false, error: "not_found" };
    const row = this.db
      .prepare(`SELECT * FROM oauth_device_authorizations WHERE user_code_hash = ?`)
      .get(sha256(normalized)) as DeviceAuthorizationRow | undefined;
    if (!row) return { ok: false, error: "not_found" };
    this.expireIfNeeded(row, now);
    const fresh = this.getById(row.id)!;
    if (fresh.status !== "pending") return { ok: false, error: "not_pending" };
    this.db
      .prepare(
        `UPDATE oauth_device_authorizations SET status = 'denied', denied_at = ? WHERE id = ? AND status = 'pending'`
      )
      .run(now.toISOString(), fresh.id);
    return { ok: true };
  }

  pollToken(deviceCode: string, clientId: string, now: Date = new Date()): DeviceTokenPollResult {
    const row = this.db
      .prepare(`SELECT * FROM oauth_device_authorizations WHERE device_code_hash = ?`)
      .get(sha256(deviceCode)) as DeviceAuthorizationRow | undefined;
    if (!row) return { status: "invalid_grant" };
    if (row.client_id !== clientId) return { status: "invalid_grant" };
    this.expireIfNeeded(row, now);
    const fresh = this.getById(row.id)!;

    if (fresh.status === "expired") return { status: "expired_token" };
    if (fresh.status === "denied") return { status: "access_denied" };
    if (fresh.status === "consumed") return { status: "invalid_grant" }; // replay of an already-used code

    if (fresh.status === "pending") {
      const elapsedSeconds = fresh.last_polled_at
        ? (now.getTime() - Date.parse(fresh.last_polled_at)) / 1000
        : Number.POSITIVE_INFINITY;
      if (elapsedSeconds < fresh.poll_interval_seconds) {
        const newInterval = fresh.poll_interval_seconds + SLOW_DOWN_INCREMENT_SECONDS;
        this.db
          .prepare(
            `UPDATE oauth_device_authorizations
             SET poll_interval_seconds = ?, last_polled_at = ?, poll_count = poll_count + 1 WHERE id = ?`
          )
          .run(newInterval, now.toISOString(), fresh.id);
        return { status: "slow_down", interval: newInterval };
      }
      this.db
        .prepare(`UPDATE oauth_device_authorizations SET last_polled_at = ?, poll_count = poll_count + 1 WHERE id = ?`)
        .run(now.toISOString(), fresh.id);
      return { status: "authorization_pending" };
    }

    // status === "approved": single consumption happens here, inside the write lock.
    const scopes = JSON.parse(fresh.requested_scopes_json) as string[];
    const accessToken = randomBytes(32).toString("base64url");
    const refreshToken = randomBytes(32).toString("base64url");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare(`SELECT status FROM oauth_device_authorizations WHERE id = ?`).get(fresh.id) as {
        status: string;
      };
      if (current.status !== "approved") {
        this.db.exec("ROLLBACK");
        return current.status === "denied" ? { status: "access_denied" } : { status: "invalid_grant" };
      }
      this.db
        .prepare(`UPDATE oauth_device_authorizations SET status = 'consumed', consumed_at = ? WHERE id = ?`)
        .run(now.toISOString(), fresh.id);
      this.db
        .prepare(
          `UPDATE devices
           SET refresh_token_hash = ?, refresh_token_expires_at = ?, last_seen_at = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          sha256(refreshToken),
          new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString(),
          now.toISOString(),
          now.toISOString(),
          fresh.device_id
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return {
      status: "success",
      deviceId: fresh.device_id!,
      principalId: fresh.principal_id!,
      scopes,
      accessToken,
      accessTokenExpiresIn: ACCESS_TOKEN_TTL_SECONDS,
      refreshToken,
      refreshTokenExpiresIn: REFRESH_TOKEN_TTL_SECONDS
    };
  }

  /** Refresh-token rotation: same device row, never mints a new device. */
  refreshAccessToken(
    rawRefreshToken: string,
    now: Date = new Date()
  ):
    | {
        ok: true;
        deviceId: string;
        principalId: string;
        scopes: string[];
        accessToken: string;
        accessTokenExpiresIn: number;
        refreshToken: string;
        refreshTokenExpiresIn: number;
      }
    | { ok: false; error: "invalid_grant" | "device_revoked" } {
    const hash = sha256(rawRefreshToken);
    const row = this.db.prepare(`SELECT * FROM devices WHERE refresh_token_hash = ?`).get(hash) as
      DeviceRow | undefined;
    if (!row) return { ok: false, error: "invalid_grant" };
    if (row.status === "revoked") return { ok: false, error: "device_revoked" };
    if (!row.refresh_token_expires_at || Date.parse(row.refresh_token_expires_at) <= now.getTime()) {
      return { ok: false, error: "invalid_grant" };
    }
    const accessToken = randomBytes(32).toString("base64url");
    const refreshToken = randomBytes(32).toString("base64url");
    this.db
      .prepare(
        `UPDATE devices SET refresh_token_hash = ?, refresh_token_expires_at = ?, last_seen_at = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        sha256(refreshToken),
        new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString(),
        now.toISOString(),
        now.toISOString(),
        row.id
      );
    return {
      ok: true,
      deviceId: row.id,
      principalId: row.principal_id,
      scopes: JSON.parse(row.allowed_scopes_json) as string[],
      accessToken,
      accessTokenExpiresIn: ACCESS_TOKEN_TTL_SECONDS,
      refreshToken,
      refreshTokenExpiresIn: REFRESH_TOKEN_TTL_SECONDS
    };
  }

  getDevice(deviceId: string): DeviceRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM devices WHERE id = ?`).get(deviceId) as DeviceRow | undefined;
    return row && toDeviceRecord(row);
  }

  revokeDevice(deviceId: string, now: Date = new Date()): boolean {
    const result = this.db
      .prepare(
        `UPDATE devices SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ? AND status = 'active'`
      )
      .run(now.toISOString(), now.toISOString(), deviceId);
    return Number(result.changes) > 0;
  }

  private upsertDeviceForApproval(auth: DeviceAuthorizationRow, principalId: string, now: Date): string {
    const existing = this.db
      .prepare(`SELECT id FROM devices WHERE public_key_pem = ?`)
      .get(auth.device_public_key_pem) as { id: string } | undefined;
    if (existing) {
      this.db
        .prepare(
          `UPDATE devices SET status = 'active', principal_id = ?, name = ?, allowed_scopes_json = ?, updated_at = ? WHERE id = ?`
        )
        .run(principalId, auth.device_name, auth.requested_scopes_json, now.toISOString(), existing.id);
      return existing.id;
    }
    const id = createId("dev");
    this.db
      .prepare(
        `INSERT INTO devices
         (id, principal_id, name, public_key_pem, allowed_scopes_json, status, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', '{}', ?, ?)`
      )
      .run(
        id,
        principalId,
        auth.device_name,
        auth.device_public_key_pem,
        auth.requested_scopes_json,
        now.toISOString(),
        now.toISOString()
      );
    return id;
  }

  private getById(id: string): DeviceAuthorizationRow | undefined {
    return this.db.prepare(`SELECT * FROM oauth_device_authorizations WHERE id = ?`).get(id) as
      DeviceAuthorizationRow | undefined;
  }

  private expireIfNeeded(row: DeviceAuthorizationRow, now: Date): void {
    if (row.status === "pending" && Date.parse(row.expires_at) <= now.getTime()) {
      this.db
        .prepare(`UPDATE oauth_device_authorizations SET status = 'expired' WHERE id = ? AND status = 'pending'`)
        .run(row.id);
    }
  }
}

function toSummary(row: DeviceAuthorizationRow): DeviceAuthorizationSummary {
  return {
    id: row.id,
    clientId: row.client_id,
    requestedScopes: JSON.parse(row.requested_scopes_json) as string[],
    deviceName: row.device_name,
    devicePublicKeyFingerprint: sha256(row.device_public_key_pem).slice(0, 16),
    status: row.status as DeviceAuthorizationSummary["status"],
    expiresAt: row.expires_at
  };
}

function toDeviceRecord(row: DeviceRow): DeviceRecord {
  return {
    id: row.id,
    principalId: row.principal_id,
    name: row.name,
    status: row.status as DeviceRecord["status"],
    allowedScopes: JSON.parse(row.allowed_scopes_json) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at
  };
}

function generateUserCode(): string {
  let code = "";
  for (let i = 0; i < 8; i += 1) {
    code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  }
  return code;
}

function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function normalizeUserCode(input: string): string | undefined {
  const upper = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return upper.length === 8 ? upper : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
