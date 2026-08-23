import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeCredentials, writeSession, readCredentials } from "./credential-store.js";
import { runLogout } from "./logout.js";
import { runStatus } from "./status.js";

const base = {
  v: 1 as const,
  acsUrl: "https://acs.example.com",
  clientId: "acs-cli",
  deviceName: "workstation",
  devicePrivateKeyPem: "PRIVATE",
  devicePublicKeyPem: "PUBLIC"
};

describe("acs auth status / logout", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function path(): string {
    dir = mkdtempSync(join(tmpdir(), "acs-cli-status-"));
    return join(dir, "credentials.json");
  }

  it("reports not_authenticated with no stored credentials", () => {
    const file = path();
    const lines: string[] = [];
    const report = runStatus({ credentialsPathOverride: file, print: (line) => lines.push(line) });
    expect(report.connectionState).toBe("not_authenticated");
    expect(lines.join("\n")).toContain("Not authenticated");
  });

  it("reports authenticated with a live token and never prints the raw token", () => {
    const file = path();
    writeCredentials(file, base);
    writeSession(file, {
      deviceId: "dev_1",
      principal: "operator-1",
      accessToken: "super-secret-access-token",
      accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      refreshToken: "super-secret-refresh-token",
      scopes: ["acs:device"]
    });
    const lines: string[] = [];
    const report = runStatus({ credentialsPathOverride: file, print: (line) => lines.push(line) });
    expect(report.connectionState).toBe("authenticated");
    expect(report.deviceId).toBe("dev_1");
    const output = lines.join("\n");
    expect(output).not.toContain("super-secret-access-token");
    expect(output).not.toContain("super-secret-refresh-token");
  });

  it("reports token_expired for a past expiry", () => {
    const file = path();
    writeCredentials(file, base);
    writeSession(file, {
      deviceId: "dev_1",
      principal: "operator-1",
      accessToken: "at",
      accessTokenExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      refreshToken: "rt",
      scopes: []
    });
    const report = runStatus({ credentialsPathOverride: file });
    expect(report.connectionState).toBe("token_expired");
  });

  it("logout clears the session but keeps the device identity for a stable future login", () => {
    const file = path();
    writeCredentials(file, base);
    writeSession(file, {
      deviceId: "dev_1",
      principal: "operator-1",
      accessToken: "at",
      accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      refreshToken: "rt",
      scopes: []
    });
    const result = runLogout({ credentialsPathOverride: file, print: () => {} });
    expect(result.hadSession).toBe(true);
    expect(readCredentials(file)?.session).toBeUndefined();
    expect(readCredentials(file)?.devicePublicKeyPem).toBe("PUBLIC");
    expect(runStatus({ credentialsPathOverride: file, print: () => {} }).connectionState).toBe("not_authenticated");
  });

  it("logout is idempotent when already logged out", () => {
    const file = path();
    const result = runLogout({ credentialsPathOverride: file, print: () => {} });
    expect(result.hadSession).toBe(false);
  });
});
