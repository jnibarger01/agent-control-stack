import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ControlStackError } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";
import { SqliteWorkItemStore } from "./index.js";

function withStore(run: (store: SqliteWorkItemStore, dbPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "acs-execution-mode-"));
  const dbPath = join(dir, "control.db");
  const store = new SqliteWorkItemStore(dbPath);
  try {
    run(store, dbPath);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("canonical execution mode store", () => {
  it("defaults to strict from migration 027", () => {
    withStore((store) => {
      expect(store.getExecutionMode()).toEqual({
        mode: "strict",
        raw: "strict",
        updatedAt: "1970-01-01T00:00:00.000Z",
        updatedBy: "system",
        reason: "default strict"
      });
    });
  });

  it("sets admin and back to strict, auditing each change", () => {
    withStore((store) => {
      const admin = store.setExecutionMode({ mode: "admin", updatedBy: "operator", reason: "maintenance window" });
      expect(admin).toMatchObject({ mode: "admin", updatedBy: "operator", reason: "maintenance window" });
      expect(store.getExecutionMode()).toMatchObject({ mode: "admin", raw: "admin", updatedBy: "operator" });
      const changed = store.readEvents().at(-1);
      expect(changed?.name).toBe("execution_mode.changed");
      expect(changed?.body).toEqual({ mode: "admin", updatedBy: "operator", reason: "maintenance window" });

      store.setExecutionMode({ mode: "strict", updatedBy: "operator", reason: "window closed" });
      expect(store.getExecutionMode()).toMatchObject({ mode: "strict", reason: "window closed" });
    });
  });

  it("rejects invalid input without changing the canonical mode", () => {
    withStore((store) => {
      const bad = [
        { mode: "yolo" as "admin", updatedBy: "operator", reason: "r" },
        { mode: "admin" as const, updatedBy: "", reason: "r" },
        { mode: "admin" as const, updatedBy: "operator", reason: "" }
      ];
      for (const input of bad) {
        expect(() => store.setExecutionMode(input)).toThrow(ControlStackError);
      }
      expect(store.getExecutionMode().mode).toBe("strict");
      expect(store.readEvents().some((event) => event.name === "execution_mode.changed")).toBe(false);
    });
  });

  it("reports a missing canonical row as no mode (fail closed), never a default", () => {
    withStore((store, dbPath) => {
      const db = new DatabaseSync(dbPath);
      try {
        db.exec("DELETE FROM execution_mode_state");
      } finally {
        db.close();
      }
      expect(store.getExecutionMode()).toEqual({
        mode: null,
        raw: null,
        updatedAt: null,
        updatedBy: null,
        reason: null
      });
    });
  });

  it("finds granted approvals only for the exact approver, and not once consumed", () => {
    withStore((store) => {
      const workItem = store.create({
        title: "Approver lookup",
        requester: "user",
        intent: "verify hasGrantedApprovalBy",
        requestedActions: [{ kind: "edit", description: "write", params: { write: true } }],
        risk: "low"
      });
      expect(store.hasGrantedApprovalBy(workItem.id, "acs-admin")).toBe(false);
      const grant = store.recordApproval({
        workItemId: workItem.id,
        actionHash: "hash_admin",
        approvedBy: "acs-admin",
        reason: "auto"
      });
      expect(store.hasGrantedApprovalBy(workItem.id, "acs-admin")).toBe(true);
      expect(store.hasGrantedApprovalBy(workItem.id, "user")).toBe(false);
      expect(store.hasGrantedApprovalBy("wrk_other", "acs-admin")).toBe(false);
      store.consumeApproval(workItem.id, "hash_admin", { requestHash: grant.requestHash });
      expect(store.hasGrantedApprovalBy(workItem.id, "acs-admin")).toBe(false);
    });
  });
});
