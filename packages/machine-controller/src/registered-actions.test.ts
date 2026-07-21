import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStackError } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";
import { loadMachineControllerConfig } from "./config.js";
import {
  applyRegisteredConfigChange,
  previewRegisteredConfigChange,
  previewRegisteredServiceRestart,
  executeRegisteredServiceRestart,
  systemdUserCommandEnvironment,
  type ServiceCommandResult
} from "./registered-actions.js";

describe("worker-bound registered mutations", () => {
  it("keeps the user systemd bus address when building the restricted runner environment", () => {
    const environment = systemdUserCommandEnvironment();
    const uid = process.getuid?.() ?? 1000;

    expect(environment).toMatchObject({
      PATH: "/usr/local/bin:/usr/bin:/bin",
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`,
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=/run/user/${uid}/bus`
    });
  });

  it("previews a restart without invoking systemd and rejects non-ACS services", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-service-preview-"));
    const config = writeConfig(dir, join(dir, "allowed"));

    try {
      const preview = previewRegisteredServiceRestart(config, { serviceId: "acs-connector-test" });
      expect(preview).toMatchObject({ serviceId: "acs-connector-test", unit: "acs-connector-test.service", approvalRequired: true });
      expect(() => previewRegisteredServiceRestart(config, { serviceId: "openclaw" })).toThrow(ControlStackError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("executes only the fixed user-systemd target and fails closed after an unhealthy post-check", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-service-execute-"));
    const config = writeConfig(dir, join(dir, "allowed"));
    const calls: string[][] = [];
    let health = true;
    const run = async (args: string[]): Promise<ServiceCommandResult> => {
      calls.push(args);
      if (args.includes("is-active")) {
        return { exitCode: health ? 0 : 3, stdout: health ? "active\n" : "failed\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    try {
      const healthy = await executeRegisteredServiceRestart(config, { serviceId: "acs-connector-test" }, { run });
      expect(healthy.ok).toBe(true);
      expect(calls).toEqual([
        ["--user", "is-active", "--quiet", "acs-connector-test.service"],
        ["--user", "restart", "acs-connector-test.service"],
        ["--user", "is-active", "--quiet", "acs-connector-test.service"]
      ]);

      calls.length = 0;
      health = false;
      const failed = await executeRegisteredServiceRestart(config, { serviceId: "acs-connector-test" }, { run });
      expect(failed.ok).toBe(false);
      expect(failed.rollbackAttempted).toBe(true);
      expect(calls.at(-1)).toEqual(["--user", "restart", "acs-connector-test.service"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("previews and atomically applies only allowed structured config keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-config-change-"));
    const allowed = join(dir, "allowed");
    const storage = join(allowed, "storage");
    mkdirSync(storage, { recursive: true });
    const configPath = join(storage, "acs-connector-settings.json");
    writeFileSync(configPath, JSON.stringify({ worker_poll_interval_ms: 5000, max_evidence_bytes: 5000 }, null, 2));
    const config = writeConfig(dir, allowed);

    try {
      const patch = [{ op: "replace" as const, path: "/max_evidence_bytes", value: 8000 }];
      const preview = previewRegisteredConfigChange(config, { targetId: "acs-connector-settings", patch });
      expect(preview).toMatchObject({ targetId: "acs-connector-settings", changed: true, currentHash: expect.any(String) });
      expect(JSON.parse(readFileSync(configPath, "utf8")).max_evidence_bytes).toBe(5000);

      const changed = applyRegisteredConfigChange(config, {
        targetId: "acs-connector-settings",
        patch,
        expectedCurrentHash: preview.currentHash
      });
      expect(changed).toMatchObject({ changed: true, backupPath: expect.stringContaining("acs-connector-settings.json.bak-") });
      expect(JSON.parse(readFileSync(configPath, "utf8")).max_evidence_bytes).toBe(8000);
      expect(() =>
        applyRegisteredConfigChange(config, {
          targetId: "acs-connector-settings",
          patch: [{ op: "replace", path: "/not_allowed", value: true }]
        })
      ).toThrow(ControlStackError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function writeConfig(dir: string, allowed: string) {
  mkdirSync(allowed, { recursive: true });
  const configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      paths: { allow: [allowed], deny: [] },
      commands: { allow_readonly: ["systemctl"], deny: [] },
      audit: { log_path: join(dir, "audit.jsonl") }
    })
  );
  return loadMachineControllerConfig(configPath);
}
