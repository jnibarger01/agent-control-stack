import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { DeviceAuthStore, type DeviceAuthAuditEvent, type DeviceRefreshRecoveryConfig } from "./device-auth-store.js";

const DEVICE_PAIR_A = generateKeyPairSync("ed25519");
const DEVICE_PAIR_B = generateKeyPairSync("ed25519");
const DEVICE_KEY_A = DEVICE_PAIR_A.publicKey.export({ type: "spki", format: "pem" }).toString();
const DEVICE_KEY_B = DEVICE_PAIR_B.publicKey.export({ type: "spki", format: "pem" }).toString();

const TEST_RECOVERY_KEY = randomBytes(32).toString("base64");
const TEST_RECOVERY_KEY_2 = randomBytes(32).toString("base64");

function makeRecoveryConfig(overrides: Partial<DeviceRefreshRecoveryConfig> = {}): DeviceRefreshRecoveryConfig {
  return {
    primaryKeyBase64: TEST_RECOVERY_KEY,
    windowSeconds: 120,
    ...overrides
  };
}

function refreshProof(
  input: {
    clientId: string;
    deviceId: string;
    refreshToken: string;
    issuedAt: number;
  },
  privateKey = DEVICE_PAIR_A.privateKey
): string {
  const tokenSha256 = createHash("sha256").update(input.refreshToken).digest("hex");
  const message = [
    "acs-device-refresh-proof-v1",
    `client_id=${input.clientId}`,
    `device_id=${input.deviceId}`,
    `refresh_token_sha256=${tokenSha256}`,
    "operation=refresh_token",
    `issued_at=${input.issuedAt}`
  ].join("\n");
  return sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64url");
}

function proof(deviceCode: string, privateKey = DEVICE_PAIR_A.privateKey): string {
  return sign(null, Buffer.from(`acs-device-code-proof-v1\n${deviceCode}`, "utf8"), privateKey).toString("base64url");
}

function setup(options: {
  recovery?: DeviceRefreshRecoveryConfig | false;
  auditEvents?: DeviceAuthAuditEvent[];
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "acs-device-auth-"));
  const dbPath = join(directory, "control.db");
  const workItems = new SqliteWorkItemStore(dbPath); // owns migrations
  workItems.registerActor({ id: "operator-1", actorType: "HUMAN", displayName: "Operator One" });
  workItems.registerActor({ id: "operator-2", actorType: "HUMAN", displayName: "Operator Two" });
  const store = new DeviceAuthStore(dbPath, {
    recovery: options.recovery === false ? undefined : (options.recovery ?? makeRecoveryConfig()),
    onAuditEvent: options.auditEvents ? (event) => options.auditEvents!.push(event) : undefined
  });
  return { directory, dbPath, workItems, store };
}

function requestCode(
  store: DeviceAuthStore,
  overrides: Partial<{
    clientId: string;
    requestedScopes: string[];
    devicePublicKeyPem: string;
    deviceName: string;
    now: Date;
  }> = {}
) {
  return store.requestDeviceCode({
    clientId: "acs-cli",
    requestedScopes: ["acs:device"],
    devicePublicKeyPem: DEVICE_KEY_A,
    deviceName: "workstation-ubuntu",
    ...overrides
  });
}

describe("DeviceAuthStore", () => {
  let directory: string | undefined;
  let workItems: SqliteWorkItemStore | undefined;
  let store: DeviceAuthStore | undefined;

  afterEach(() => {
    store?.close();
    workItems?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
    store = undefined;
    workItems = undefined;
  });

  it("issues a device code and a formatted, distinct user code", () => {
    ({ directory, workItems, store } = setup());
    const result = requestCode(store);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deviceCode).not.toEqual(result.userCode);
    expect(result.userCodeFormatted).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(result.expiresIn).toBeGreaterThan(0);
    expect(result.interval).toBeGreaterThan(0);
  });

  it("rejects unknown client_id", () => {
    ({ directory, workItems, store } = setup());
    const result = requestCode(store, { clientId: "some-other-app" });
    expect(result).toEqual({ ok: false, error: "invalid_client" });
  });

  it("rejects a request for acs:work:approve", () => {
    ({ directory, workItems, store } = setup());
    const result = requestCode(store, { requestedScopes: ["acs:device", "acs:work:approve"] });
    expect(result).toEqual({ ok: false, error: "invalid_scope" });
  });

  it("finds a pending authorization by user code, tolerating dashes/case/whitespace", () => {
    ({ directory, workItems, store } = setup());
    const issued = requestCode(store);
    if (!issued.ok) throw new Error("setup failed");
    const found = store.findByUserCode(` ${issued.userCode.toLowerCase()} `);
    expect(found?.status).toBe("pending");
    expect(found?.deviceName).toBe("workstation-ubuntu");
    expect(found?.requestedScopes).toEqual(["acs:device"]);
  });

  it("returns undefined for an unknown user code", () => {
    ({ directory, workItems, store } = setup());
    requestCode(store);
    expect(store.findByUserCode("ZZZZ-ZZZZ")).toBeUndefined();
  });

  it("polling a pending, unapproved code returns authorization_pending", () => {
    ({ directory, workItems, store } = setup());
    const issued = requestCode(store);
    if (!issued.ok) throw new Error("setup failed");
    const now = new Date(Date.now() + 10_000);
    expect(store.pollToken(issued.deviceCode, "acs-cli", proof(issued.deviceCode), now)).toEqual({ status: "authorization_pending" });
  });

  it("polling faster than the interval returns slow_down and escalates the interval", () => {
    ({ directory, workItems, store } = setup());
    const start = new Date("2026-01-01T00:00:00.000Z");
    const issued = requestCode(store, { now: start });
    if (!issued.ok) throw new Error("setup failed");
    // First poll establishes last_polled_at.
    expect(store.pollToken(issued.deviceCode, "acs-cli", proof(issued.deviceCode), new Date(start.getTime() + 6_000))).toEqual({
      status: "authorization_pending"
    });
    // Second poll arrives before the 5s interval elapses -> slow_down, interval grows to 10s.
    const second = store.pollToken(issued.deviceCode, "acs-cli", proof(issued.deviceCode), new Date(start.getTime() + 7_000));
    expect(second).toEqual({ status: "slow_down", interval: 10 });
  });

  it("rejects an unknown device_code with invalid_grant", () => {
    ({ directory, workItems, store } = setup());
    expect(store.pollToken("not-a-real-code", "acs-cli", proof("not-a-real-code"))).toEqual({ status: "invalid_grant" });
  });

  it("rejects a device_code presented with the wrong client_id", () => {
    ({ directory, workItems, store } = setup());
    const issued = requestCode(store);
    if (!issued.ok) throw new Error("setup failed");
    expect(store.pollToken(issued.deviceCode, "some-other-app", proof(issued.deviceCode))).toEqual({ status: "invalid_grant" });
  });

  it("expires a device code after its TTL and fails closed", () => {
    ({ directory, workItems, store } = setup());
    const start = new Date("2026-01-01T00:00:00.000Z");
    const issued = requestCode(store, { now: start });
    if (!issued.ok) throw new Error("setup failed");
    const later = new Date(start.getTime() + 16 * 60 * 1000);
    expect(store.pollToken(issued.deviceCode, "acs-cli", proof(issued.deviceCode), later)).toEqual({ status: "expired_token" });
    expect(store.approve(issued.userCode, "operator-1", later)).toEqual({ ok: false, error: "expired" });
  });

  it("denies a pending authorization and reports access_denied on poll", () => {
    ({ directory, workItems, store } = setup());
    const issued = requestCode(store);
    if (!issued.ok) throw new Error("setup failed");
    expect(store.deny(issued.userCode)).toEqual({ ok: true });
    expect(store.pollToken(issued.deviceCode, "acs-cli", proof(issued.deviceCode))).toEqual({ status: "access_denied" });
    // Denied is terminal: cannot later approve the same code.
    expect(store.approve(issued.userCode, "operator-1")).toEqual({ ok: false, error: "not_pending" });
  });

  it("approves a pending authorization, binds the principal, and issues tokens exactly once", () => {
    ({ directory, workItems, store } = setup());
    const issued = requestCode(store);
    if (!issued.ok) throw new Error("setup failed");
    expect(store.approve(issued.userCode, "operator-1")).toEqual({ ok: true });

    const success = store.pollToken(issued.deviceCode, "acs-cli", proof(issued.deviceCode));
    expect(success.status).toBe("success");
    if (success.status !== "success") return;
    expect(success.principalId).toBe("operator-1");
    expect(success.scopes).toEqual(["acs:device"]);
    expect(success.accessToken).toHaveLength(43); // 32 random bytes, base64url
    expect(success.refreshToken).toHaveLength(43);
    expect(success.deviceId).toMatch(/^dev_/);

    const device = store.getDevice(success.deviceId);
    expect(device?.status).toBe("active");
    expect(device?.principalId).toBe("operator-1");

    // Replay: the same device_code cannot be exchanged again.
    expect(store.pollToken(issued.deviceCode, "acs-cli", proof(issued.deviceCode))).toEqual({ status: "invalid_grant" });
  });

  it("cannot approve an already-approved (or already-consumed) code a second time", () => {
    ({ directory, workItems, store } = setup());
    const issued = requestCode(store);
    if (!issued.ok) throw new Error("setup failed");
    expect(store.approve(issued.userCode, "operator-1")).toEqual({ ok: true });
    expect(store.approve(issued.userCode, "operator-2")).toEqual({ ok: false, error: "not_pending" });
  });

  it("reuses the same stable device id across independent approvals of the same public key", () => {
    ({ directory, workItems, store } = setup());
    const first = requestCode(store);
    if (!first.ok) throw new Error("setup failed");
    store.approve(first.userCode, "operator-1");
    const firstSuccess = store.pollToken(first.deviceCode, "acs-cli", proof(first.deviceCode));
    if (firstSuccess.status !== "success") throw new Error("expected success");

    const second = requestCode(store); // same DEVICE_KEY_A -> same device row
    if (!second.ok) throw new Error("setup failed");
    store.approve(second.userCode, "operator-1");
    const secondSuccess = store.pollToken(second.deviceCode, "acs-cli", proof(second.deviceCode));
    if (secondSuccess.status !== "success") throw new Error("expected success");

    expect(secondSuccess.deviceId).toBe(firstSuccess.deviceId);
  });

  it("a stolen refresh token cannot enroll a second device: refresh only rotates the bound device's tokens", () => {
    ({ directory, workItems, store } = setup());
    const issued = requestCode(store, { devicePublicKeyPem: DEVICE_KEY_B });
    if (!issued.ok) throw new Error("setup failed");
    store.approve(issued.userCode, "operator-1");
    const success = store.pollToken(issued.deviceCode, "acs-cli", proof(issued.deviceCode, DEVICE_PAIR_B.privateKey));
    if (success.status !== "success") throw new Error("expected success");

    const now = new Date();
    const issuedAt = Math.floor(now.getTime() / 1000);
    const refreshed = store.refreshAccessToken({
      clientId: "acs-cli",
      refreshToken: success.refreshToken,
      deviceId: success.deviceId,
      proofIssuedAt: issuedAt,
      refreshProof: refreshProof(
        { clientId: "acs-cli", deviceId: success.deviceId, refreshToken: success.refreshToken, issuedAt },
        DEVICE_PAIR_B.privateKey
      ),
      now
    });
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;
    expect(refreshed.deviceId).toBe(success.deviceId);

    // Within the recovery window, a proof-verified retry returns the same successor (idempotent recovery).
    expect(
      store.refreshAccessToken({
        clientId: "acs-cli",
        refreshToken: success.refreshToken,
        deviceId: success.deviceId,
        proofIssuedAt: issuedAt,
        refreshProof: refreshProof(
          { clientId: "acs-cli", deviceId: success.deviceId, refreshToken: success.refreshToken, issuedAt },
          DEVICE_PAIR_B.privateKey
        ),
        now
      })
    ).toEqual({ ...refreshed, recovered: true });

    // No new device row was created by any of this.
    const device = store.getDevice(success.deviceId);
    expect(device).toBeDefined();
  });

  it("revokes a device and blocks further refresh", async () => {
    let dbPath: string;
    ({ directory, dbPath, workItems, store } = setup());
    const issued = requestCode(store);
    if (!issued.ok) throw new Error("setup failed");
    store.approve(issued.userCode, "operator-1");
    const success = store.pollToken(issued.deviceCode, "acs-cli", proof(issued.deviceCode));
    if (success.status !== "success") throw new Error("expected success");

    expect(store.revokeDevice(success.deviceId)).toBe(true);
    expect(store.getDevice(success.deviceId)?.status).toBe("revoked");

    // Direct database assertions: revocation clears all token hashes, expiries, previous refresh hash, and recovery envelopes.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db
        .prepare(
          `SELECT access_token_hash, access_token_expires_at, refresh_token_hash, refresh_token_expires_at, previous_refresh_token_hash
           FROM devices WHERE id = ?`
        )
        .get(success.deviceId) as
        | {
            access_token_hash: string | null;
            access_token_expires_at: string | null;
            refresh_token_hash: string | null;
            refresh_token_expires_at: string | null;
            previous_refresh_token_hash: string | null;
          }
        | undefined;
      expect(row).toBeDefined();
      expect(row?.access_token_hash).toBeNull();
      expect(row?.access_token_expires_at).toBeNull();
      expect(row?.refresh_token_hash).toBeNull();
      expect(row?.refresh_token_expires_at).toBeNull();
      expect(row?.previous_refresh_token_hash).toBeNull();
      const envCount = db
        .prepare(`SELECT COUNT(*) AS count FROM device_refresh_recovery_envelopes WHERE device_id = ?`)
        .get(success.deviceId) as { count: number };
      expect(Number(envCount.count)).toBe(0);
    } finally {
      db.close();
    }

    const now = new Date();
    const issuedAt = Math.floor(now.getTime() / 1000);
    expect(
      store.refreshAccessToken({
        clientId: "acs-cli",
        refreshToken: success.refreshToken,
        deviceId: success.deviceId,
        proofIssuedAt: issuedAt,
        refreshProof: refreshProof({
          clientId: "acs-cli",
          deviceId: success.deviceId,
          refreshToken: success.refreshToken,
          issuedAt
        }),
        now
      })
    ).toEqual({ ok: false, error: "invalid_grant", reason: "device_revoked" });

    // Invalid proof against a revoked device (whose token hashes were cleared) must return
    // the exact same unknown_refresh_token response as a nonexistent device ID.
    const invalidProofForRevoked = store.refreshAccessToken({
      clientId: "acs-cli",
      refreshToken: success.refreshToken,
      deviceId: success.deviceId,
      proofIssuedAt: issuedAt,
      refreshProof: refreshProof(
        {
          clientId: "acs-cli",
          deviceId: success.deviceId,
          refreshToken: success.refreshToken,
          issuedAt
        },
        DEVICE_PAIR_B.privateKey
      ),
      now
    });
    const invalidProofForUnknown = store.refreshAccessToken({
      clientId: "acs-cli",
      refreshToken: success.refreshToken,
      deviceId: "nonexistent-device-id",
      proofIssuedAt: issuedAt,
      refreshProof: refreshProof(
        {
          clientId: "acs-cli",
          deviceId: "nonexistent-device-id",
          refreshToken: success.refreshToken,
          issuedAt
        },
        DEVICE_PAIR_B.privateKey
      ),
      now
    });
    expect(invalidProofForRevoked).toEqual({ ok: false, error: "invalid_grant", reason: "unknown_refresh_token" });
    expect(invalidProofForRevoked).toEqual(invalidProofForUnknown);

    // Revoking an already-revoked (or unknown) device is a no-op, not an error.
    expect(store.revokeDevice(success.deviceId)).toBe(false);
  });

  it("requires a valid Ed25519 proof over the device_code", () => {
    ({ directory, workItems, store } = setup());
    const issued = requestCode(store);
    if (!issued.ok) throw new Error("setup failed");
    expect(store.pollToken(issued.deviceCode, "acs-cli", undefined)).toEqual({ status: "invalid_grant" });
    expect(store.pollToken(issued.deviceCode, "acs-cli", proof(issued.deviceCode, DEVICE_PAIR_B.privateKey))).toEqual({
      status: "invalid_grant"
    });
    expect(store.pollToken(issued.deviceCode, "acs-cli", proof(issued.deviceCode))).toEqual({
      status: "authorization_pending"
    });
  });

  it("rejects unknown device scopes", () => {
    ({ directory, workItems, store } = setup());
    expect(requestCode(store, { requestedScopes: ["acs:admin"] })).toEqual({ ok: false, error: "invalid_scope" });
  });

  it("does not let an approval rebind an existing public key to another principal", () => {
    ({ directory, workItems, store } = setup());
    const first = requestCode(store);
    if (!first.ok) throw new Error("setup failed");
    expect(store.approve(first.userCode, "operator-1")).toEqual({ ok: true });
    const firstToken = store.pollToken(first.deviceCode, "acs-cli", proof(first.deviceCode));
    if (firstToken.status !== "success") throw new Error("expected success");

    const second = requestCode(store);
    if (!second.ok) throw new Error("setup failed");
    expect(store.approve(second.userCode, "operator-2")).toEqual({ ok: false, error: "device_key_conflict" });
    expect(store.getDevice(firstToken.deviceId)?.principalId).toBe("operator-1");
  });

  it("never reactivates a revoked device through re-registration", () => {
    ({ directory, workItems, store } = setup());
    const first = requestCode(store);
    if (!first.ok) throw new Error("setup failed");
    expect(store.approve(first.userCode, "operator-1")).toEqual({ ok: true });
    const token = store.pollToken(first.deviceCode, "acs-cli", proof(first.deviceCode));
    if (token.status !== "success") throw new Error("expected success");
    expect(store.revokeDevice(token.deviceId)).toBe(true);

    const second = requestCode(store);
    if (!second.ok) throw new Error("setup failed");
    expect(store.approve(second.userCode, "operator-1")).toEqual({ ok: false, error: "device_revoked" });
    expect(store.getDevice(token.deviceId)?.status).toBe("revoked");
  });

  it("persists access-token hashes and rejects revoked access tokens", () => {
    ({ directory, workItems, store } = setup());
    const issued = requestCode(store);
    if (!issued.ok) throw new Error("setup failed");
    expect(store.approve(issued.userCode, "operator-1")).toEqual({ ok: true });
    const token = store.pollToken(issued.deviceCode, "acs-cli", proof(issued.deviceCode));
    if (token.status !== "success") throw new Error("expected success");
    expect(store.authenticateAccessToken(token.accessToken)?.deviceId).toBe(token.deviceId);
    expect(store.authenticateAccessToken("not-the-token")).toBeUndefined();
    expect(store.revokeDevice(token.deviceId)).toBe(true);
    expect(store.authenticateAccessToken(token.accessToken)).toBeUndefined();
  });

  it("revokes the device when a rotated refresh token is reused after its successor is superseded", () => {
    ({ directory, workItems, store } = setup());
    const issued = requestCode(store);
    if (!issued.ok) throw new Error("setup failed");
    expect(store.approve(issued.userCode, "operator-1")).toEqual({ ok: true });
    const token = store.pollToken(issued.deviceCode, "acs-cli", proof(issued.deviceCode));
    if (token.status !== "success") throw new Error("expected success");
    const now = new Date();
    const issuedAt = Math.floor(now.getTime() / 1000);
    const refreshed = store.refreshAccessToken({
      clientId: "acs-cli",
      refreshToken: token.refreshToken,
      deviceId: token.deviceId,
      proofIssuedAt: issuedAt,
      refreshProof: refreshProof({
        clientId: "acs-cli",
        deviceId: token.deviceId,
        refreshToken: token.refreshToken,
        issuedAt
      }),
      now
    });
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;
    // Supersede the successor with a second rotation
    const second = store.refreshAccessToken({
      clientId: "acs-cli",
      refreshToken: refreshed.refreshToken,
      deviceId: token.deviceId,
      proofIssuedAt: issuedAt,
      refreshProof: refreshProof({
        clientId: "acs-cli",
        deviceId: token.deviceId,
        refreshToken: refreshed.refreshToken,
        issuedAt
      }),
      now
    });
    expect(second.ok).toBe(true);
    // Replaying the superseded predecessor revokes the device
    expect(
      store.refreshAccessToken({
        clientId: "acs-cli",
        refreshToken: token.refreshToken,
        deviceId: token.deviceId,
        proofIssuedAt: issuedAt,
        refreshProof: refreshProof({
          clientId: "acs-cli",
          deviceId: token.deviceId,
          refreshToken: token.refreshToken,
          issuedAt
        }),
        now
      })
    ).toEqual({ ok: false, error: "invalid_grant", reason: "refresh_replay" });
    expect(store.getDevice(token.deviceId)?.status).toBe("revoked");
  });

  it("never persists the raw device_code or user_code (only their hashes)", () => {
    ({ directory, workItems, store } = setup());
    const issued = requestCode(store);
    if (!issued.ok) throw new Error("setup failed");
    // The store's only read APIs return hashed/derived fields; assert the raw secrets
    // don't leak through the one place a UI ever sees data back out: the summary view.
    const summary = store.findByUserCode(issued.userCode);
    expect(JSON.stringify(summary)).not.toContain(issued.deviceCode);
    expect(JSON.stringify(summary)).not.toContain(issued.userCode);
  });

  it("requires proof-of-possession on refreshAccessToken and rejects missing/invalid/stale/mismatched proofs without revoking", () => {
    const auditEvents: DeviceAuthAuditEvent[] = [];
    ({ directory, workItems, store } = setup({ auditEvents }));
    const issued = requestCode(store);
    if (!issued.ok) throw new Error("setup failed");
    expect(store.approve(issued.userCode, "operator-1")).toEqual({ ok: true });
    const token = store.pollToken(issued.deviceCode, "acs-cli", proof(issued.deviceCode));
    if (token.status !== "success") throw new Error("expected success");

    const now = new Date("2026-06-01T12:00:00.000Z");
    const issuedAt = Math.floor(now.getTime() / 1000);

    // Missing proof fields
    expect(
      store.refreshAccessToken({
        clientId: "acs-cli",
        refreshToken: token.refreshToken,
        deviceId: token.deviceId,
        proofIssuedAt: undefined,
        refreshProof: undefined,
        now
      })
    ).toEqual({ ok: false, error: "invalid_request", reason: "missing_proof" });

    // Wrong key signature -> invalid_proof, device stays active
    expect(
      store.refreshAccessToken({
        clientId: "acs-cli",
        refreshToken: token.refreshToken,
        deviceId: token.deviceId,
        proofIssuedAt: issuedAt,
        refreshProof: refreshProof(
          { clientId: "acs-cli", deviceId: token.deviceId, refreshToken: token.refreshToken, issuedAt },
          DEVICE_PAIR_B.privateKey
        ),
        now
      })
    ).toEqual({ ok: false, error: "invalid_grant", reason: "invalid_proof" });
    expect(store.getDevice(token.deviceId)?.status).toBe("active");

    // Stale proof (> 300s skew) -> invalid_proof
    expect(
      store.refreshAccessToken({
        clientId: "acs-cli",
        refreshToken: token.refreshToken,
        deviceId: token.deviceId,
        proofIssuedAt: issuedAt - 301,
        refreshProof: refreshProof({
          clientId: "acs-cli",
          deviceId: token.deviceId,
          refreshToken: token.refreshToken,
          issuedAt: issuedAt - 301
        }),
        now
      })
    ).toEqual({ ok: false, error: "invalid_grant", reason: "invalid_proof" });

    // Mismatched deviceId -> invalid_proof
    expect(
      store.refreshAccessToken({
        clientId: "acs-cli",
        refreshToken: token.refreshToken,
        deviceId: "dev_wrong",
        proofIssuedAt: issuedAt,
        refreshProof: refreshProof({
          clientId: "acs-cli",
          deviceId: "dev_wrong",
          refreshToken: token.refreshToken,
          issuedAt
        }),
        now
      })
    ).toEqual({ ok: false, error: "invalid_grant", reason: "invalid_proof" });

    expect(auditEvents.some((e) => e.name === "device_auth.refresh_invalid_proof")).toBe(true);
    expect(store.getDevice(token.deviceId)?.status).toBe("active");
  });

  it("supports idempotent recovery within the bounded window and revokes on genuine replay outside window or after superseding", () => {
    const auditEvents: DeviceAuthAuditEvent[] = [];
    ({ directory, workItems, store } = setup({ recovery: makeRecoveryConfig({ windowSeconds: 60 }), auditEvents }));
    const issued = requestCode(store);
    if (!issued.ok) throw new Error("setup failed");
    expect(store.approve(issued.userCode, "operator-1")).toEqual({ ok: true });
    const t0 = new Date("2026-06-01T12:00:00.000Z");
    const token = store.pollToken(issued.deviceCode, "acs-cli", proof(issued.deviceCode), t0);
    if (token.status !== "success") throw new Error("expected success");

    const t1 = new Date(t0.getTime() + 10_000);
    const issuedAt1 = Math.floor(t1.getTime() / 1000);
    const r1 = store.refreshAccessToken({
      clientId: "acs-cli",
      refreshToken: token.refreshToken,
      deviceId: token.deviceId,
      proofIssuedAt: issuedAt1,
      refreshProof: refreshProof({
        clientId: "acs-cli",
        deviceId: token.deviceId,
        refreshToken: token.refreshToken,
        issuedAt: issuedAt1
      }),
      now: t1
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    // Retry with predecessor token inside window -> returns SAME successor without rotating
    const t2 = new Date(t1.getTime() + 30_000);
    const issuedAt2 = Math.floor(t2.getTime() / 1000);
    const recovered = store.refreshAccessToken({
      clientId: "acs-cli",
      refreshToken: token.refreshToken,
      deviceId: token.deviceId,
      proofIssuedAt: issuedAt2,
      refreshProof: refreshProof({
        clientId: "acs-cli",
        deviceId: token.deviceId,
        refreshToken: token.refreshToken,
        issuedAt: issuedAt2
      }),
      now: t2
    });
    expect(recovered).toEqual({ ...r1, recovered: true });
    expect(store.getDevice(token.deviceId)?.status).toBe("active");
    expect(auditEvents.some((e) => e.name === "device_auth.refresh_recovered")).toBe(true);
    expect(JSON.stringify(auditEvents)).not.toContain(token.refreshToken);
    expect(JSON.stringify(auditEvents)).not.toContain(r1.refreshToken);
    expect(JSON.stringify(auditEvents)).not.toContain(r1.accessToken);
    expect(JSON.stringify(auditEvents)).not.toContain(TEST_RECOVERY_KEY);

    // Retry with predecessor token OUTSIDE window -> genuine replay -> revokes device
    const t3 = new Date(t1.getTime() + 61_000);
    const issuedAt3 = Math.floor(t3.getTime() / 1000);
    const replay = store.refreshAccessToken({
      clientId: "acs-cli",
      refreshToken: token.refreshToken,
      deviceId: token.deviceId,
      proofIssuedAt: issuedAt3,
      refreshProof: refreshProof({
        clientId: "acs-cli",
        deviceId: token.deviceId,
        refreshToken: token.refreshToken,
        issuedAt: issuedAt3
      }),
      now: t3
    });
    expect(replay).toEqual({ ok: false, error: "invalid_grant", reason: "refresh_replay" });
    expect(store.getDevice(token.deviceId)?.status).toBe("revoked");
    expect(auditEvents.some((e) => e.name === "device_auth.refresh_replay_detected")).toBe(true);
  });

  it("fails closed with recovery_unavailable when recovery key is missing or invalid, without rotating", () => {
    ({ directory, workItems, store } = setup({ recovery: false }));
    const issued = requestCode(store);
    if (!issued.ok) throw new Error("setup failed");
    expect(store.approve(issued.userCode, "operator-1")).toEqual({ ok: true });
    const token = store.pollToken(issued.deviceCode, "acs-cli", proof(issued.deviceCode));
    if (token.status !== "success") throw new Error("expected success");

    const now = new Date();
    const issuedAt = Math.floor(now.getTime() / 1000);
    const res = store.refreshAccessToken({
      clientId: "acs-cli",
      refreshToken: token.refreshToken,
      deviceId: token.deviceId,
      proofIssuedAt: issuedAt,
      refreshProof: refreshProof({
        clientId: "acs-cli",
        deviceId: token.deviceId,
        refreshToken: token.refreshToken,
        issuedAt
      }),
      now
    });
    expect(res).toEqual({ ok: false, error: "server_error", reason: "recovery_unavailable" });
    expect(store.getDevice(token.deviceId)?.status).toBe("active");
  });

  it("decrypts recovery envelope using previous key after key rotation", () => {
    const dirSetup = setup({ recovery: makeRecoveryConfig({ primaryKeyBase64: TEST_RECOVERY_KEY, keyId: "k1" }) });
    directory = dirSetup.directory;
    workItems = dirSetup.workItems;
    store = dirSetup.store;

    const issued = requestCode(store);
    if (!issued.ok) throw new Error("setup failed");
    expect(store.approve(issued.userCode, "operator-1")).toEqual({ ok: true });
    const token = store.pollToken(issued.deviceCode, "acs-cli", proof(issued.deviceCode));
    if (token.status !== "success") throw new Error("expected success");

    const now = new Date();
    const issuedAt = Math.floor(now.getTime() / 1000);
    const r1 = store.refreshAccessToken({
      clientId: "acs-cli",
      refreshToken: token.refreshToken,
      deviceId: token.deviceId,
      proofIssuedAt: issuedAt,
      refreshProof: refreshProof({
        clientId: "acs-cli",
        deviceId: token.deviceId,
        refreshToken: token.refreshToken,
        issuedAt
      }),
      now
    });
    expect(r1.ok).toBe(true);
    store.close();

    // Reopen store with rotated primary key k2 and previous key k1
    store = new DeviceAuthStore(dirSetup.dbPath, {
      recovery: {
        primaryKeyBase64: TEST_RECOVERY_KEY_2,
        keyId: "k2",
        previousKeyBase64: TEST_RECOVERY_KEY,
        previousKeyId: "k1",
        windowSeconds: 120
      }
    });
    const recovered = store.refreshAccessToken({
      clientId: "acs-cli",
      refreshToken: token.refreshToken,
      deviceId: token.deviceId,
      proofIssuedAt: issuedAt,
      refreshProof: refreshProof({
        clientId: "acs-cli",
        deviceId: token.deviceId,
        refreshToken: token.refreshToken,
        issuedAt
      }),
      now
    });
    expect(recovered).toEqual({ ...r1, recovered: true });
  });
});
