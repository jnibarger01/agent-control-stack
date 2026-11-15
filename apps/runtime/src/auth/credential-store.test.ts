import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearSession,
  CorruptCredentialsError,
  deleteCredentials,
  readCredentials,
  writeCredentials,
  writeSession
} from "./credential-store.js";

const base = {
  v: 1 as const,
  acsUrl: "https://acs.example.com",
  clientId: "acs-cli",
  deviceName: "workstation",
  devicePrivateKeyPem: "PRIVATE",
  devicePublicKeyPem: "PUBLIC"
};

describe("credential-store", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function path(): string {
    dir = mkdtempSync(join(tmpdir(), "acs-cli-creds-"));
    return join(dir, "credentials.json");
  }

  it("round-trips credentials and sets 0600 permissions", () => {
    const file = path();
    writeCredentials(file, base);
    expect(readCredentials(file)).toEqual(base);
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("returns undefined when no credentials file exists", () => {
    const file = path();
    expect(readCredentials(file)).toBeUndefined();
  });

  it("writeSession attaches a session to an existing device identity", () => {
    const file = path();
    writeCredentials(file, base);
    writeSession(file, {
      deviceId: "dev_1",
      principal: "operator-1",
      accessToken: "at",
      accessTokenExpiresAt: "2026-01-01T00:00:00.000Z",
      refreshToken: "rt",
      scopes: ["acs:device"]
    });
    const stored = readCredentials(file);
    expect(stored?.session?.deviceId).toBe("dev_1");
    expect(stored?.devicePrivateKeyPem).toBe("PRIVATE"); // identity preserved
  });

  it("writeSession refuses to run before a device identity exists", () => {
    const file = path();
    expect(() =>
      writeSession(file, {
        deviceId: "dev_1",
        principal: "operator-1",
        accessToken: "at",
        accessTokenExpiresAt: "2026-01-01T00:00:00.000Z",
        refreshToken: "rt",
        scopes: []
      })
    ).toThrow();
  });

  it("clearSession removes the session but keeps the device keypair", () => {
    const file = path();
    writeCredentials(file, {
      ...base,
      session: {
        deviceId: "dev_1",
        principal: "operator-1",
        accessToken: "at",
        accessTokenExpiresAt: "2026-01-01T00:00:00.000Z",
        refreshToken: "rt",
        scopes: []
      }
    });
    clearSession(file);
    const stored = readCredentials(file);
    expect(stored?.session).toBeUndefined();
    expect(stored?.devicePrivateKeyPem).toBe("PRIVATE");
  });

  it("clearSession on a file with no credentials is a no-op", () => {
    const file = path();
    expect(() => clearSession(file)).not.toThrow();
    expect(existsSync(file)).toBe(false);
  });

  it("deleteCredentials removes the whole file, including the device keypair", () => {
    const file = path();
    writeCredentials(file, base);
    deleteCredentials(file);
    expect(existsSync(file)).toBe(false);
  });

  it("throws CorruptCredentialsError on malformed JSON", () => {
    const file = path();
    writeFileSync(file, "{not-valid-json", { mode: 0o600 });
    expect(() => readCredentials(file)).toThrow(CorruptCredentialsError);
  });

  it("throws CorruptCredentialsError on schema-invalid credentials", () => {
    const file = path();
    writeFileSync(file, JSON.stringify({ v: 1, acsUrl: "" }), { mode: 0o600 });
    expect(() => readCredentials(file)).toThrow(CorruptCredentialsError);
  });

  it("leaves no temp files behind after writeCredentials and cleans stale temps on read/write", () => {
    const file = path();
    const stale1 = `${file}.tmp-99999-stale1`;
    const stale2 = `${file}.tmp-99999-stale2`;
    writeFileSync(stale1, "partial", { mode: 0o600 });
    writeCredentials(file, base);
    expect(readdirSync(dir!)).toEqual(["credentials.json"]);

    writeFileSync(stale2, "partial", { mode: 0o600 });
    expect(readCredentials(file)).toEqual(base);
    expect(readdirSync(dir!)).toEqual(["credentials.json"]);
  });

  it("preserves existing credentials and cleans up temp file when atomic rename fails", () => {
    const file = path();
    writeCredentials(file, base);
    const updated = { ...base, deviceName: "updated-workstation" };
    expect(() =>
      writeCredentials(file, updated, {
        renameSyncImpl: () => {
          throw new Error("simulated rename failure");
        }
      })
    ).toThrow("simulated rename failure");
    expect(readCredentials(file)).toEqual(base);
    expect(readdirSync(dir!)).toEqual(["credentials.json"]);
  });
});
