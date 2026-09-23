import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import {
  ACS_ADMIN_APPROVER,
  adminExecutionGate,
  authorizeUnderExecutionMode,
  readExecutionModeValue,
  type ManagedAuthorityObservation
} from "./execution-mode.js";
import { observeManagedAuthority } from "./managed-authority.js";

const healthy: ManagedAuthorityObservation = {
  authorityOwner: "managed:pid:42",
  authoritative: true,
  leaseActive: true,
  leaseAmbiguous: false,
  breakGlassActive: false,
  breakGlassAmbiguous: false,
  multipleAuthoritativeExecutors: false,
  managedRuntime: true,
  detail: "executor lease held by pid 42"
};

describe("execution mode decision", () => {
  it("keeps strict decisions unchanged, including require_approval", () => {
    const result = authorizeUnderExecutionMode(
      { decision: "require_approval", reason: "file writes require approval", matchedRules: ["approval:write"] },
      readExecutionModeValue("strict"),
      { ok: true }
    );
    expect(result.effect).toBe("unchanged");
    expect(result.decision.decision).toBe("require_approval");
  });

  it("auto-authorizes require_approval in admin when authority is valid", () => {
    const result = authorizeUnderExecutionMode(
      { decision: "require_approval", reason: "file writes require approval", matchedRules: ["approval:write"] },
      readExecutionModeValue("admin"),
      adminExecutionGate(healthy, true)
    );
    expect(result.effect).toBe("auto_authorize");
    expect(result.decision.decision).toBe("allow");
    expect(result.decision.matchedRules).toContain("allow:admin-auto-authorization");
  });

  it("does not promote a denial in admin mode", () => {
    const result = authorizeUnderExecutionMode(
      { decision: "deny", reason: "destructive command is denied", matchedRules: ["deny:destructive"] },
      readExecutionModeValue("admin"),
      adminExecutionGate(healthy, true)
    );
    expect(result.effect).toBe("unchanged");
    expect(result.decision.decision).toBe("deny");
  });

  it("fails closed on an invalid lease, break-glass, ambiguity, and a corrupt mode row", () => {
    const invalidLease = adminExecutionGate({ ...healthy, leaseActive: false, authoritative: false }, true);
    const breakGlass = adminExecutionGate({ ...healthy, breakGlassActive: true, authoritative: false }, true);
    const ambiguous = adminExecutionGate({ ...healthy, leaseAmbiguous: true, authoritative: false }, true);
    const unmanaged = adminExecutionGate({ ...healthy, managedRuntime: false }, true);
    const unauthenticated = adminExecutionGate(healthy, false);
    expect(invalidLease.ok).toBe(false);
    expect(breakGlass.ok).toBe(false);
    expect(ambiguous.ok).toBe(false);
    expect(unmanaged.ok).toBe(false);
    expect(unauthenticated.ok).toBe(false);
    if (!invalidLease.ok) expect(invalidLease.code).toBe("executor_lease_invalid");
    if (!breakGlass.ok) expect(breakGlass.code).toBe("break_glass_conflict");
    if (!ambiguous.ok) expect(ambiguous.code).toBe("executor_ambiguous");
    if (!unmanaged.ok) expect(unmanaged.code).toBe("unmanaged_runtime");
    if (!unauthenticated.ok) expect(unauthenticated.code).toBe("authentication_required");
    const corrupt = authorizeUnderExecutionMode(
      { decision: "require_approval", reason: "needs approval", matchedRules: ["approval:write"] },
      readExecutionModeValue("yolo"),
      { ok: true }
    );
    expect(corrupt.effect).toBe("deny");
    expect(corrupt.code).toBe("execution_mode_corrupt");
    expect(readExecutionModeValue(null).state).toBe("missing");
  });
});

describe("managed authority observation", () => {
  const now = 1_000_000;
  const lease = JSON.stringify({ pid: 42, expiresAt: now + 10_000, instanceId: "executor-42" });

  it("accepts one live managed lease and rejects break-glass and a second executor", () => {
    const ok = observeManagedAuthority(
      { leaseExists: true, leaseRaw: lease, breakGlassExists: false, breakGlassRaw: null },
      {
        nowMs: now,
        executionBackend: "desktop_commander",
        launchArgs: ["/home/jacen/projects/desktop-commander/dist/index.js"],
        pidAlive: (pid) => pid === 42,
        managedExecutorPids: [42],
        holderCommand: "/usr/bin/node /home/jacen/projects/desktop-commander/dist/index.js"
      }
    );
    expect(ok.authoritative).toBe(true);
    expect(ok.managedRuntime).toBe(true);
    expect(ok.authorityOwner).toBe("managed:pid:42");

    const holderWithoutBackend = observeManagedAuthority(
      { leaseExists: true, leaseRaw: lease, breakGlassExists: false, breakGlassRaw: null },
      {
        nowMs: now,
        launchArgs: [],
        pidAlive: (pid) => pid === 42,
        managedExecutorPids: [42],
        holderCommand: "/usr/bin/node /home/jacen/projects/desktop-commander/dist/index.js"
      }
    );
    expect(holderWithoutBackend.managedRuntime).toBe(true);
    expect(holderWithoutBackend.authoritative).toBe(true);

    const conflict = observeManagedAuthority(
      {
        leaseExists: true,
        leaseRaw: lease,
        breakGlassExists: true,
        breakGlassRaw: JSON.stringify({ pid: 99 })
      },
      {
        nowMs: now,
        executionBackend: "desktop_commander",
        launchArgs: [],
        pidAlive: () => true,
        managedExecutorPids: [42],
        holderCommand: "node desktop-commander/dist/index.js"
      }
    );
    expect(conflict.breakGlassActive).toBe(true);
    expect(adminExecutionGate(conflict, true).ok).toBe(false);

    const split = observeManagedAuthority(
      { leaseExists: true, leaseRaw: lease, breakGlassExists: false, breakGlassRaw: null },
      {
        nowMs: now,
        executionBackend: "desktop_commander",
        launchArgs: [],
        pidAlive: () => true,
        managedExecutorPids: [42, 77],
        holderCommand: "node desktop-commander/dist/index.js"
      }
    );
    expect(split.multipleAuthoritativeExecutors).toBe(true);
    expect(split.leaseAmbiguous).toBe(true);

    const expiredButAlive = observeManagedAuthority(
      {
        leaseExists: true,
        leaseRaw: JSON.stringify({ pid: 42, expiresAt: now - 1, instanceId: "executor-42", processStartTicks: "100" }),
        breakGlassExists: false,
        breakGlassRaw: null
      },
      {
        nowMs: now,
        executionBackend: "desktop_commander",
        launchArgs: [],
        pidAlive: (pid) => pid === 42,
        processStartTicks: "100",
        managedExecutorPids: [42],
        holderCommand: "node desktop-commander/dist/index.js"
      }
    );
    expect(expiredButAlive.leaseActive).toBe(true);
    expect(expiredButAlive.authoritative).toBe(true);

    const reused = observeManagedAuthority(
      {
        leaseExists: true,
        leaseRaw: JSON.stringify({
          pid: 42,
          expiresAt: now + 10_000,
          instanceId: "executor-42",
          processStartTicks: "100"
        }),
        breakGlassExists: false,
        breakGlassRaw: null
      },
      {
        nowMs: now,
        executionBackend: "desktop_commander",
        launchArgs: [],
        pidAlive: () => true,
        processStartTicks: "200",
        managedExecutorPids: [42],
        holderCommand: "node desktop-commander/dist/index.js"
      }
    );
    expect(reused.leaseActive).toBe(false);
    expect(reused.leaseAmbiguous).toBe(true);
  });
});

describe("execution mode persistence", () => {
  it("defaults to strict, survives reopen, and audits the switch", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-mode-"));
    const dbPath = join(dir, "control.db");
    try {
      const first = new SqliteWorkItemStore(dbPath);
      expect(first.getExecutionMode().mode).toBe("strict");
      first.setExecutionMode({ mode: "admin", updatedBy: "acs-cli", reason: "acs mode admin" });
      first.close();

      const second = new SqliteWorkItemStore(dbPath);
      expect(second.getExecutionMode()).toMatchObject({ mode: "admin", updatedBy: "acs-cli" });
      const events = second.readEvents({ limit: 20 });
      expect(events.some((event) => event.name === "execution_mode.changed")).toBe(true);
      second.setExecutionMode({ mode: "strict", updatedBy: "acs-cli", reason: "acs mode strict" });
      expect(second.getExecutionMode().mode).toBe("strict");
      second.close();

      const db = new DatabaseSync(dbPath);
      expect(db.prepare(`SELECT COUNT(*) AS count FROM execution_mode_state`).get()).toEqual({ count: 1 });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

void ACS_ADMIN_APPROVER;
