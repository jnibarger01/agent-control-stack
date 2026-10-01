import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearSession,
  CredentialsFileCorruptError,
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

  it("fails closed with an actionable error when the file is not valid JSON", () => {
    const file = path();
    const truncated = '{"v":1,"devicePrivateKeyPem":"LEAKED-PRIVATE-KEY"';
    writeFileSync(file, truncated);

    let thrown: unknown;
    try {
      readCredentials(file);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CredentialsFileCorruptError);
    const corrupt = thrown as CredentialsFileCorruptError;
    expect(corrupt.code).toBe("credentials_file_corrupt");
    expect(corrupt.message).toContain(file);
    expect(corrupt.message).toContain("acs auth login"); // tells the operator how to recover
    expect(corrupt.message).not.toContain("LEAKED-PRIVATE-KEY"); // never echo file contents
    expect(readFileSync(file, "utf8")).toBe(truncated); // the unusable file is left for the operator
  });

  it("fails closed instead of reporting 'no credentials' when the file has the wrong shape", () => {
    const file = path();
    // Valid JSON, but not a v1 credentials record. Treating this as "no credentials" would let
    // `acs auth login` silently mint and persist a brand-new device identity over it.
    writeFileSync(file, JSON.stringify({ v: 2, acsUrl: "https://acs.example.com" }));

    expect(() => readCredentials(file)).toThrow(CredentialsFileCorruptError);
    expect(() => readCredentials(file)).toThrow(/schema/);
  });

  it("fails closed when the credentials path cannot be read as a file", () => {
    const file = path();
    const asDirectory = join(file, "..");
    // A directory (or any unreadable path) is an operator-fixable state, not an ENOENT.
    expect(() => readCredentials(asDirectory)).toThrow(CredentialsFileCorruptError);
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
});
