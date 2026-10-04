/**
 * Regression coverage for sticky admin execution mode.
 *
 * Admin mode must NOT silently revert to strict after the old one-hour default,
 * because a silent revert reintroduces human approval on the next call with
 * nobody having asked for it. A caller may still opt into a bounded TTL
 * explicitly, and out-of-range values stay rejected.
 *
 * The admin-mode authorization invariants themselves are covered by
 * apps/gateway/src/admin-mode-allow-authority.test.ts (gateway) and
 * packages/policy-gate/src/admin-executor-identity.test.ts (executor identity).
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyControlPlaneMigrations } from "@agent-control-stack/shared";
import {
  SqliteWorkItemStore,
  ADMIN_MODE_NO_EXPIRY,
  LEGACY_ADMIN_MODE_TTL_MS,
  MIN_ADMIN_MODE_TTL_MS,
  MAX_ADMIN_MODE_TTL_MS
} from "./index.js";

function withStore<T>(fn: (store: SqliteWorkItemStore) => T, options: { adminModeTtlMs?: number } = {}): T {
  const dir = mkdtempSync(join(tmpdir(), "acs-adminmode-"));
  const dbPath = join(dir, "control.db");
  try {
    // Apply the control-plane migrations first so the schema (including the
    // sticky_admin marker) matches a real deployment.
    const seed = new DatabaseSync(dbPath);
    try {
      applyControlPlaneMigrations(seed);
    } finally {
      seed.close();
    }
    const store = new SqliteWorkItemStore(dbPath, options);
    try {
      return fn(store);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("admin execution mode is sticky until explicitly disabled", () => {
  it("defaults to no expiry: admin survives far beyond the old one-hour default", () => {
    withStore((store) => {
      store.setExecutionMode({ mode: "admin", updatedBy: "user", reason: "operator enabled admin" });

      // The old DEFAULT_ADMIN_MODE_TTL_MS was 1 hour. Assert well past it.
      const eightHoursLater = new Date(Date.now() + 8 * 60 * 60 * 1000);
      expect(store.getExecutionMode(eightHoursLater).mode).toBe("admin");
      expect(store.getExecutionMode(eightHoursLater).expired).toBe(false);
      expect(store.getExecutionMode(eightHoursLater).expiresAt).toBeNull();
    });
  });

  it("never auto-reverts to strict: expireAdminModeIfDue writes nothing", () => {
    withStore((store) => {
      store.setExecutionMode({ mode: "admin", updatedBy: "user", reason: "operator enabled admin" });
      const eightHoursLater = new Date(Date.now() + 8 * 60 * 60 * 1000);
      expect(store.expireAdminModeIfDue(eightHoursLater)).toBe(false);
      expect(store.getExecutionMode(eightHoursLater).mode).toBe("admin");
    });
  });

  it("still reverts to strict when an operator explicitly disables it", () => {
    withStore((store) => {
      store.setExecutionMode({ mode: "admin", updatedBy: "user", reason: "operator enabled admin" });
      store.setExecutionMode({ mode: "strict", updatedBy: "user", reason: "operator disabled admin" });
      expect(store.getExecutionMode().mode).toBe("strict");
    });
  });

  it("still honors an explicitly requested bounded TTL", () => {
    const ttl = MIN_ADMIN_MODE_TTL_MS;
    withStore(
      (store) => {
        store.setExecutionMode({ mode: "admin", updatedBy: "user", reason: "bounded elevation" });
        expect(store.getExecutionMode().mode).toBe("admin");
        const afterExpiry = new Date(Date.now() + ttl + 5_000);
        expect(store.getExecutionMode(afterExpiry).mode).toBe("strict");
        expect(store.getExecutionMode(afterExpiry).expired).toBe(true);
      },
      { adminModeTtlMs: ttl }
    );
  });

  it("ADMIN_MODE_NO_EXPIRY is accepted explicitly and behaves as sticky", () => {
    withStore(
      (store) => {
        store.setExecutionMode({ mode: "admin", updatedBy: "user", reason: "explicit no-expiry" });
        const later = new Date(Date.now() + 48 * 60 * 60 * 1000);
        expect(store.getExecutionMode(later).mode).toBe("admin");
      },
      { adminModeTtlMs: ADMIN_MODE_NO_EXPIRY }
    );
  });

  it("does not widen a legacy bounded admin row on upgrade", () => {
    // An elevation enabled before the sticky_admin marker existed was authorized
    // while time-boxed. Upgrading must not silently reinterpret it as indefinite.
    withStore((store) => {
      const row = (store as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => void } } }).db;
      row.prepare(
        `UPDATE execution_mode_state
            SET mode = 'admin', updated_at = ?, updated_by = 'user',
                reason = 'legacy bounded elevation', sticky_admin = NULL
          WHERE id = 1`
      ).run(new Date().toISOString());
      // sticky_admin is NULL here: this row predates the marker.
      expect(store.getExecutionMode().mode).toBe("admin");
      const afterLegacyTtl = new Date(Date.now() + LEGACY_ADMIN_MODE_TTL_MS + 5_000);
      expect(store.getExecutionMode(afterLegacyTtl).mode).toBe("strict");
      expect(store.getExecutionMode(afterLegacyTtl).expired).toBe(true);
    });
  });

  it("treats a corrupt admin timestamp as expired even when sticky", () => {
    withStore((store) => {
      const row = (store as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => void } } }).db;
      row.prepare(
        `UPDATE execution_mode_state
            SET mode = 'admin', updated_at = 'not-a-timestamp', updated_by = 'user',
                reason = 'corrupt row', sticky_admin = 1
          WHERE id = 1`
      ).run();
      // Corruption must fail closed to strict, never yield indefinite admin.
      expect(store.getExecutionMode().mode).toBe("strict");
      expect(store.getExecutionMode().expired).toBe(true);
    });
  });

  it("still rejects out-of-range bounded TTLs", () => {
    for (const bad of [MIN_ADMIN_MODE_TTL_MS - 1, MAX_ADMIN_MODE_TTL_MS + 1, 1.5, Number.NaN]) {
      expect(() => withStore(() => undefined, { adminModeTtlMs: bad })).toThrow();
    }
  });
});
