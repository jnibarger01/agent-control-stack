import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { desktopCommanderAdapterConfigFromEnv } from "./config.js";

let root: string;
const privateKey = generateKeyPairSync("ed25519")
  .privateKey.export({ format: "der", type: "pkcs8" })
  .toString("base64url");

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "dc-config-"));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function managedEnv(args: string[] = []): NodeJS.ProcessEnv {
  return {
    ACS_EXECUTION_BACKEND: "desktop_commander",
    ACS_DESKTOP_COMMANDER_COMMAND: process.execPath,
    ACS_DESKTOP_COMMANDER_ARGS_JSON: JSON.stringify(args),
    ACS_DESKTOP_COMMANDER_ALLOWED_ROOTS: root,
    ACS_DESKTOP_COMMANDER_RUNTIME_ID: "runtime_config_test",
    ACS_DESKTOP_COMMANDER_RUNTIME_IDENTITY_CONFIG_FINGERPRINT: "f".repeat(64),
    ACS_DESKTOP_COMMANDER_RUNTIME_SCOPES_JSON: JSON.stringify(["fs.read"]),
    ACS_DESKTOP_COMMANDER_CAPABILITY_KEY_ID: "config-test-key",
    ACS_DESKTOP_COMMANDER_CAPABILITY_PRIVATE_KEY: privateKey
  };
}

describe("managed Desktop Commander configuration", () => {
  it("binds capability storage to the worker's explicit authoritative database", () => {
    const databasePath = join(root, "control.db");
    const config = desktopCommanderAdapterConfigFromEnv(managedEnv(), databasePath);
    expect(config?.capability?.databasePath).toBe(databasePath);
  });

  it("fails closed instead of silently choosing a second database", () => {
    expect(() => desktopCommanderAdapterConfigFromEnv(managedEnv())).toThrow(/authoritative database path/);
  });

  it("rejects the standalone downgrade flag", () => {
    expect(() => desktopCommanderAdapterConfigFromEnv(managedEnv(["--standalone"]), join(root, "control.db"))).toThrow(
      /must not be launched with --standalone/
    );
  });
});
