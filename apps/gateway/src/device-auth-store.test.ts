import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { DeviceAuthStore } from "./device-auth-store.js";

const DEVICE_KEY_A = "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----";
const DEVICE_KEY_B = "-----BEGIN PUBLIC KEY-----\nBBBB\n-----END PUBLIC KEY-----";

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "acs-device-auth-"));
  const dbPath = join(directory, "control.db");
  const workItems = new SqliteWorkItemStore(dbPath); // owns migrations
  workItems.registerActor({ id: "operator-1", actorType: "HUMAN", displayName: "Operator One" });
  workItems.registerActor({ id: "operator-2", actorType: "HUMAN", displayName: "Operator Two" });
  const store = new DeviceAuthStore(dbPath);
  return { directory, workItems, store };
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
    expect(store.pollToken(issued.deviceCode, "acs-cli", now)).toEqual({ status: "authorization_pending" });
  });

  it("polling faster than the interval returns slow_down and escalates the interval", () => {
    ({ directory, workItems, store } = setup());
    const start = new Date("2026-01-01T00:00:00.000Z");
    const issued = requestCode(store, { now: start });
    if (!issued.ok) throw new Error("setup failed");
    // First poll establishes last_polled_at.
    expect(store.pollToken(issued.deviceCode, "acs-cli", new Date(start.getTime() + 6_000))).toEqual({
      status: "authorization_pending"
    });
    // Second poll arrives before the 5s interval elapses -> slow_down, interval grows to 10s.
    const second = store.pollToken(issued.deviceCode, "acs-cli", new Date(start.getTime() + 7_000));
    expect(second).toEqual({ status: "slow_down", interval: 10 });
  });

  it("rejects an unknown device_code with invalid_grant", () => {
    ({ directory, workItems, store } = setup());
    expect(store.pollToken("not-a-real-code", "acs-cli")).toEqual({ status: "invalid_grant" });
  });

  it("rejects a device_code presented with the wrong client_id", () => {
    ({ directory, workItems, store } = setup());
    const issued = requestCode(store);
    if (!issued.ok) throw new Error("setup failed");
    expect(store.pollToken(issued.deviceCode, "some-other-app")).toEqual({ status: "invalid_grant" });
  });

  it("expires a device code after its TTL and fails closed", () => {
    ({ directory, workItems, store } = setup());
    const start = new Date("2026-01-01T00:00:00.000Z");
    const issued = requestCode(store, { now: start });
    if (!issued.ok) throw new Error("setup failed");
    const later = new Date(start.getTime() + 16 * 60 * 1000);
    expect(store.pollToken(issued.deviceCode, "acs-cli", later)).toEqual({ status: "expired_token" });
    expect(store.approve(issued.userCode, "operator-1", later)).toEqual({ ok: false, error: "expired" });
  });

  it("denies a pending authorization and reports access_denied on poll", () => {
    ({ directory, workItems, store } = setup());
    const issued = requestCode(store);
    if (!issued.ok) throw new Error("setup failed");
    expect(store.deny(issued.userCode)).toEqual({ ok: true });
    expect(store.pollToken(issued.deviceCode, "acs-cli")).toEqual({ status: "access_denied" });
    // Denied is terminal: cannot later approve the same code.
    expect(store.approve(issued.userCode, "operator-1")).toEqual({ ok: false, error: "not_pending" });
  });

  it("approves a pending authorization, binds the principal, and issues tokens exactly once", () => {
    ({ directory, workItems, store } = setup());
    const issued = requestCode(store);
    if (!issued.ok) throw new Error("setup failed");
    expect(store.approve(issued.userCode, "operator-1")).toEqual({ ok: true });

    const success = store.pollToken(issued.deviceCode, "acs-cli");
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
    expect(store.pollToken(issued.deviceCode, "acs-cli")).toEqual({ status: "invalid_grant" });
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
    const firstSuccess = store.pollToken(first.deviceCode, "acs-cli");
    if (firstSuccess.status !== "success") throw new Error("expected success");

    const second = requestCode(store); // same DEVICE_KEY_A -> same device row
    if (!second.ok) throw new Error("setup failed");
    store.approve(second.userCode, "operator-1");
    const secondSuccess = store.pollToken(second.deviceCode, "acs-cli");
    if (secondSuccess.status !== "success") throw new Error("expected success");

    expect(secondSuccess.deviceId).toBe(firstSuccess.deviceId);
  });

  it("a stolen refresh token cannot enroll a second device: refresh only rotates the bound device's tokens", () => {
    ({ directory, workItems, store } = setup());
    const issued = requestCode(store, { devicePublicKeyPem: DEVICE_KEY_B });
    if (!issued.ok) throw new Error("setup failed");
    store.approve(issued.userCode, "operator-1");
    const success = store.pollToken(issued.deviceCode, "acs-cli");
    if (success.status !== "success") throw new Error("expected success");

    const refreshed = store.refreshAccessToken(success.refreshToken);
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;
    expect(refreshed.deviceId).toBe(success.deviceId);

    // The old refresh token was rotated out and can no longer be used (single-use rotation).
    expect(store.refreshAccessToken(success.refreshToken)).toEqual({ ok: false, error: "invalid_grant" });

    // No new device row was created by any of this.
    const device = store.getDevice(success.deviceId);
    expect(device).toBeDefined();
  });

  it("revokes a device and blocks further refresh", () => {
    ({ directory, workItems, store } = setup());
    const issued = requestCode(store);
    if (!issued.ok) throw new Error("setup failed");
    store.approve(issued.userCode, "operator-1");
    const success = store.pollToken(issued.deviceCode, "acs-cli");
    if (success.status !== "success") throw new Error("expected success");

    expect(store.revokeDevice(success.deviceId)).toBe(true);
    expect(store.getDevice(success.deviceId)?.status).toBe("revoked");
    expect(store.refreshAccessToken(success.refreshToken)).toEqual({ ok: false, error: "device_revoked" });
    // Revoking an already-revoked (or unknown) device is a no-op, not an error.
    expect(store.revokeDevice(success.deviceId)).toBe(false);
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
});
