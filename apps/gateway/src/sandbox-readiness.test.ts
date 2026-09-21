import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildGateway } from "./server.js";
import {
  evaluateSandboxReadyzCheck,
  isSandboxReadyzProbeEnabled,
  mergeSandboxReadyzCheck,
  SANDBOX_READYZ_PROBE_ENV
} from "./sandbox-readiness.js";

const testAuth = { token: "t".repeat(32), actor: "user", actorId: "user" } as const;

describe("sandbox readiness helpers", () => {
  afterEach(() => {
    delete process.env[SANDBOX_READYZ_PROBE_ENV];
  });

  it("defaults the probe to disabled", () => {
    expect(isSandboxReadyzProbeEnabled({})).toBe(false);
    expect(evaluateSandboxReadyzCheck({}, {})).toBeUndefined();
  });

  it("enables via ACS_READYZ_SANDBOX_PROBE=1", () => {
    expect(isSandboxReadyzProbeEnabled({ [SANDBOX_READYZ_PROBE_ENV]: "1" })).toBe(true);
  });

  it("merges a failing sandbox check into readiness without dropping other checks", () => {
    const merged = mergeSandboxReadyzCheck(
      {
        ok: true,
        checks: {
          read: { ok: true },
          write: { ok: true },
          integrity: { ok: true },
          foreignKeys: { ok: true },
          migrations: { ok: true },
          auditChain: { ok: true },
          liveness: { ok: true }
        }
      },
      { ok: false, code: "sandbox_backend_missing" }
    );
    expect(merged.ok).toBe(false);
    expect(merged.checks.sandbox).toEqual({ ok: false, code: "sandbox_backend_missing" });
    expect(merged.checks.read).toEqual({ ok: true });
  });
});

describe("optional sandbox /readyz probe", () => {
  it("stays ready when the probe is disabled even if bwrap is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-sandbox-readyz-off-"));
    const dbPath = join(dir, "control.db");
    const app = buildGateway({
      dbPath,
      logger: false,
      auth: testAuth,
      sandboxReadiness: {
        enabled: false,
        prerequisites: {
          platform: "linux",
          bwrapPath: "/definitely/missing/bwrap",
          systemdRunPath: process.execPath,
          systemctlPath: process.execPath,
          cgroupStat: { type: 0x63677270 } as import("node:fs").StatsFs
        }
      }
    });
    try {
      const ready = await app.inject({ method: "GET", url: "/readyz" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json().checks.sandbox).toBeUndefined();
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 503 with sandbox_backend_missing when enabled and bwrap is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-sandbox-readyz-on-"));
    const dbPath = join(dir, "control.db");
    const app = buildGateway({
      dbPath,
      logger: false,
      auth: testAuth,
      sandboxReadiness: {
        enabled: true,
        prerequisites: {
          platform: "linux",
          bwrapPath: "/definitely/missing/bwrap",
          systemdRunPath: process.execPath,
          systemctlPath: process.execPath,
          cgroupStat: { type: 0x63677270 } as import("node:fs").StatsFs
        }
      }
    });
    try {
      const ready = await app.inject({ method: "GET", url: "/readyz" });
      expect(ready.statusCode).toBe(503);
      expect(ready.json()).toMatchObject({
        ok: false,
        checks: {
          sandbox: { ok: false, code: "sandbox_backend_missing" }
        }
      });
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves /livez at 200 when the sandbox probe fails readiness", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-sandbox-readyz-livez-"));
    const dbPath = join(dir, "control.db");
    const app = buildGateway({
      dbPath,
      logger: false,
      auth: testAuth,
      sandboxReadiness: {
        enabled: true,
        check: () => ({ ok: false, code: "sandbox_backend_missing" })
      }
    });
    try {
      const live = await app.inject({ method: "GET", url: "/livez" });
      const ready = await app.inject({ method: "GET", url: "/readyz" });
      expect(live.statusCode).toBe(200);
      expect(live.json()).toEqual({ ok: true, status: "alive" });
      expect(ready.statusCode).toBe(503);
      expect(ready.json().checks.sandbox).toEqual({ ok: false, code: "sandbox_backend_missing" });
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
