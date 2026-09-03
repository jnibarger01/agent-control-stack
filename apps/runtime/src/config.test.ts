import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "./config.js";

const paths: string[] = [];

afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("runtime configuration", () => {
  it("loads acs.config.yaml topology while preserving environment overrides", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-runtime-config-"));
    paths.push(dir);
    const configPath = join(dir, "acs.config.yaml");
    writeFileSync(
      configPath,
      "runtime:\n  db_path: runtime.db\n  scheduler_interval_ms: 1000\n  worker_interval_ms: 2000\n  reconcile_interval_ms: 3000\n  worker_id: runtime-worker\n  status_port: 3111\ngateway:\n  host: 127.0.0.1\n  port: 3110\n"
    );

    expect(loadRuntimeConfig({ ACS_RUNTIME_CONFIG: configPath, PORT: "3120" })).toEqual({
      dbPath: "runtime.db",
      gatewayHost: "127.0.0.1",
      gatewayPort: 3120,
      schedulerIntervalMs: 1000,
      workerIntervalMs: 2000,
      reconcileIntervalMs: 3000,
      workerId: "runtime-worker",
      statusPort: 3111
    });
  });

  it("uses safe local defaults when no runtime config exists", () => {
    expect(loadRuntimeConfig({ ACS_RUNTIME_CONFIG: join(tmpdir(), "does-not-exist.yaml") })).toMatchObject({
      dbPath: "storage/local.db",
      gatewayHost: "127.0.0.1",
      gatewayPort: 3000,
      statusPort: 3001
    });
  });
});
