import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStackError } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";
import { loadMachineControllerConfig } from "./config.js";
import {
  connectorActionRegistry,
  getRegisteredCommand,
  getRegisteredConfigTarget,
  getRegisteredService,
  resolveRegisteredCommand,
  resolveRegisteredRoot
} from "./registry.js";

describe("ACS connector registry", () => {
  it("publishes stable action ids and versions for every connector seam", () => {
    const ids = connectorActionRegistry.map((entry) => entry.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(connectorActionRegistry).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "acs.command.preview", version: "1.0" }),
        expect.objectContaining({ id: "acs.command.run", version: "1.0" }),
        expect.objectContaining({ id: "acs.filesystem.read_text", version: "1.0" }),
        expect.objectContaining({ id: "acs.agent.codex.run", version: "1.0" }),
        expect.objectContaining({ id: "acs.service.restart", version: "1.0" }),
        expect.objectContaining({ id: "acs.config.change", version: "1.0" })
      ])
    );
  });

  it("resolves only registered command ids and fixed invocations", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-registry-command-"));
    const allowed = join(dir, "allowed");
    mkdirSync(allowed);
    const config = writeConfig(dir, allowed);

    try {
      const resolved = resolveRegisteredCommand(config, { commandId: "os.metadata" });
      expect(resolved).toMatchObject({ commandId: "os.metadata", command: "uname", args: ["-a"] });
      expect(() => resolveRegisteredCommand(config, { commandId: "os.metadata", command: "sh" })).toThrow(
        ControlStackError
      );
      expect(() => resolveRegisteredCommand(config, { commandId: "not-registered" })).toThrow(ControlStackError);
      expect(getRegisteredCommand("os.metadata")).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maps named roots without accepting arbitrary filesystem roots", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-registry-root-"));
    const allowed = join(dir, "allowed");
    mkdirSync(allowed);
    const config = writeConfig(dir, allowed);

    try {
      expect(resolveRegisteredRoot(config, "acs-repo")).toBe(allowed);
      expect(() => resolveRegisteredRoot(config, "home")).toThrow(ControlStackError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("limits restart and config targets to ACS-owned registrations", () => {
    expect(getRegisteredService("acs-gateway")).toMatchObject({ unit: "acs-gateway.service" });
    expect(getRegisteredService("openclaw")).toBeUndefined();
    expect(() => getRegisteredService("openclaw") ?? (() => { throw new ControlStackError("unknown", "unknown"); })()).toThrow(
      ControlStackError
    );

    expect(getRegisteredConfigTarget("acs-connector-settings")).toMatchObject({ format: "json" });
    expect(getRegisteredConfigTarget("etc-hosts")).toBeUndefined();
  });
});

function writeConfig(dir: string, allowed: string) {
  const configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      paths: { allow: [allowed], deny: [] },
      commands: { allow_readonly: ["uname"], deny: [] },
      audit: { log_path: join(dir, "audit.jsonl") }
    })
  );
  return loadMachineControllerConfig(configPath);
}
