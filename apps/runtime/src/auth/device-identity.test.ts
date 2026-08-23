import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCredentials } from "./credential-store.js";
import { loadOrCreateDeviceIdentity } from "./device-identity.js";

describe("loadOrCreateDeviceIdentity", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function path(): string {
    dir = mkdtempSync(join(tmpdir(), "acs-device-identity-"));
    return join(dir, "credentials.json");
  }

  it("generates a new Ed25519 keypair and persists it on first use", () => {
    const file = path();
    const identity = loadOrCreateDeviceIdentity("https://acs.example.com", "acs-cli", {
      credentialsPathOverride: file
    });
    expect(identity.devicePrivateKeyPem).toContain("PRIVATE KEY");
    expect(identity.devicePublicKeyPem).toContain("PUBLIC KEY");
    expect(readCredentials(file)?.devicePublicKeyPem).toBe(identity.devicePublicKeyPem);
  });

  it("reuses the same keypair across calls for the same acsUrl/clientId (stable device identity)", () => {
    const file = path();
    const first = loadOrCreateDeviceIdentity("https://acs.example.com", "acs-cli", { credentialsPathOverride: file });
    const second = loadOrCreateDeviceIdentity("https://acs.example.com", "acs-cli", { credentialsPathOverride: file });
    expect(second.devicePublicKeyPem).toBe(first.devicePublicKeyPem);
  });

  it("generates a fresh keypair when switching to a different acsUrl", () => {
    const file = path();
    const first = loadOrCreateDeviceIdentity("https://acs.example.com", "acs-cli", { credentialsPathOverride: file });
    const second = loadOrCreateDeviceIdentity("https://other-acs.example.com", "acs-cli", {
      credentialsPathOverride: file
    });
    expect(second.devicePublicKeyPem).not.toBe(first.devicePublicKeyPem);
  });
});
