import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { DeviceAuthStore } from "./device-auth-store.js";

/**
 * Pins the device-auth store's prepared-statement cache.
 *
 * `DatabaseSync.prepare` re-parses and re-compiles its SQL text on every call, and
 * `authenticateAccessToken` runs on every authenticated gateway request, so the access-token
 * lookup (and the rest of this store's fixed statements) must be compiled once per connection
 * instead of once per call. These tests assert *that* property directly, and separately assert
 * that a reused compiled statement still observes current rows - a cache that handed back stale
 * rows would silently keep authenticating a revoked device.
 */
describe("DeviceAuthStore prepared-statement cache", () => {
  let directory: string | undefined;
  let workItems: SqliteWorkItemStore | undefined;
  let store: DeviceAuthStore | undefined;

  const DEVICE_PAIR = generateKeyPairSync("ed25519");
  const DEVICE_KEY = DEVICE_PAIR.publicKey.export({ type: "spki", format: "pem" }).toString();
  const ACCESS_TOKEN_LOOKUP_SQL = "SELECT * FROM devices WHERE access_token_hash = ?";
  /** Enough calls that a per-call recompile would be impossible to miss. */
  const REPEAT_CALLS = 100;
  /** refreshAccessToken introduces the refresh-token lookup and the rotation UPDATE. */
  const REFRESH_FLOW_STATEMENTS = 2;

  function proof(deviceCode: string): string {
    return sign(null, Buffer.from(`acs-device-code-proof-v1\n${deviceCode}`, "utf8"), DEVICE_PAIR.privateKey).toString(
      "base64url"
    );
  }

  /**
   * Migrations and actor registration are SqliteWorkItemStore's job (it shares the
   * DatabaseSync prototype and prepares without a cache), so fixtures are built first and the
   * prepare spy is installed only for the DeviceAuthStore under test.
   */
  function setupFixtures() {
    const dir = mkdtempSync(join(tmpdir(), "acs-device-auth-stmt-"));
    const dbPath = join(dir, "control.db");
    const items = new SqliteWorkItemStore(dbPath); // owns migrations
    items.registerActor({ id: "operator-1", actorType: "HUMAN", displayName: "Operator One" });
    return { directory: dir, dbPath, workItems: items };
  }

  /** Runs the flow up to a live access token. */
  function issueAccessToken(deviceAuth: DeviceAuthStore) {
    const issued = deviceAuth.requestDeviceCode({
      clientId: "acs-cli",
      requestedScopes: ["acs:device"],
      devicePublicKeyPem: DEVICE_KEY,
      deviceName: "workstation-ubuntu"
    });
    if (!issued.ok) throw new Error("device code issuance failed");
    const approved = deviceAuth.approve(issued.userCode, "operator-1");
    if (!approved.ok) throw new Error(`device approval failed: ${approved.error}`);
    const polled = deviceAuth.pollToken(issued.deviceCode, "acs-cli", proof(issued.deviceCode));
    if (polled.status !== "success") throw new Error(`device poll failed: ${polled.status}`);
    return polled;
  }

  /** Yields a store whose SQL compiles are the only ones the prepare spy records. */
  function setupWithPrepareSpy() {
    const fixtures = setupFixtures();
    directory = fixtures.directory;
    workItems = fixtures.workItems;
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    store = new DeviceAuthStore(fixtures.dbPath);
    return { prepare, store };
  }

  afterEach(() => {
    store?.close();
    workItems?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
    store = undefined;
    workItems = undefined;
    vi.restoreAllMocks();
  });

  it("compiles the access-token lookup once for repeated authentications", () => {
    const { prepare, store: deviceAuth } = setupWithPrepareSpy();
    const tokens = issueAccessToken(deviceAuth);

    const compilesBeforeLoop = prepare.mock.calls.length;
    for (let call = 0; call < REPEAT_CALLS; call += 1) {
      expect(deviceAuth.authenticateAccessToken(tokens.accessToken)?.deviceId).toBe(tokens.deviceId);
    }

    // RED without the cache: one compile per call (REPEAT_CALLS), not one.
    expect(
      prepare.mock.calls.slice(compilesBeforeLoop).filter(([sql]) => sql === ACCESS_TOKEN_LOOKUP_SQL)
    ).toHaveLength(1);
    expect(prepare.mock.calls.length - compilesBeforeLoop).toBe(1);
  });

  it("compiles each fixed statement once per connection across a whole authorization flow", () => {
    const { prepare, store: deviceAuth } = setupWithPrepareSpy();
    const tokens = issueAccessToken(deviceAuth);
    for (let call = 0; call < 20; call += 1) deviceAuth.authenticateAccessToken(tokens.accessToken);
    expect(deviceAuth.getDevice(tokens.deviceId)?.status).toBe("active");

    const compiled = prepare.mock.calls.map(([sql]) => sql);
    // This store's SQL is a fixed set of literals: no statement is compiled twice, and the
    // number of compiles never grows with the number of calls.
    expect(compiled.length).toBe(new Set(compiled).size);
    expect(compiled.length).toBeLessThanOrEqual(12);

    const refreshed = deviceAuth.refreshAccessToken(tokens.refreshToken);
    if (!refreshed.ok) throw new Error(`refresh rotation failed: ${refreshed.error}`);
    for (let call = 0; call < 20; call += 1) deviceAuth.authenticateAccessToken(refreshed.accessToken);

    const afterRefresh = prepare.mock.calls.map(([sql]) => sql);
    expect(afterRefresh.length).toBe(compiled.length + REFRESH_FLOW_STATEMENTS);
    expect(afterRefresh.length).toBe(new Set(afterRefresh).size);
  });

  it("re-executes the cached statement, so a revoked device stops authenticating", () => {
    const { store: deviceAuth } = setupWithPrepareSpy();
    const tokens = issueAccessToken(deviceAuth);
    expect(deviceAuth.authenticateAccessToken(tokens.accessToken)?.deviceId).toBe(tokens.deviceId);

    expect(deviceAuth.revokeDevice(tokens.deviceId)).toBe(true);

    // Same compiled statement, current rows: the revocation must be observed.
    expect(deviceAuth.authenticateAccessToken(tokens.accessToken)).toBeUndefined();
    expect(deviceAuth.getDevice(tokens.deviceId)?.status).toBe("revoked");
  });

  it("keeps the compiled statement's bound-parameter isolation", () => {
    const { store: deviceAuth } = setupWithPrepareSpy();
    const tokens = issueAccessToken(deviceAuth);

    expect(deviceAuth.authenticateAccessToken("not-a-real-token")).toBeUndefined();
    expect(deviceAuth.authenticateAccessToken(tokens.accessToken)?.principalId).toBe("operator-1");
    expect(deviceAuth.authenticateAccessToken("not-a-real-token")).toBeUndefined();
  });
});
