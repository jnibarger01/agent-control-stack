import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { runWorkerOnce } from "./index.js";

const createdAt = "2026-10-02T12:00:00.000Z";

function readOnly(title: string) {
  return {
    title,
    requester: "user" as const,
    intent: "read source",
    target: { cwd: "/repo" },
    requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["README.md"] } }],
    risk: "low" as const
  };
}

function count(dbPath: string, sql: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare(sql).get() as { count: number }).count;
  } finally {
    db.close();
  }
}

describe("nimble authoritative claim path", () => {
  it("selects through Nimble and does not let claim-next choose another approved item", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-nimble-route-"));
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath);
    const tools = createWorkItemTools(store, createPolicyEngine());
    let calls = 0;
    try {
      const older = tools.create_work_item(readOnly("Older read"));
      const newer = tools.create_work_item(readOnly("Newer read"));
      store.close();
      const result = await runWorkerOnce({
        dbPath,
        workerId: "worker-a",
        routing: "nimble",
        now: createdAt,
        decisionModel: {
          id: "nimble",
          version: "test",
          answer: () => {
            calls += 1;
            return { answers: [{ id: "next_operation", choice: newer.id, confidence: 0.96 }] };
          }
        },
        execute: async () => ({ ok: true, executionMode: "dry_run", output: "ok" })
      });
      const check = new SqliteWorkItemStore(dbPath);
      try {
        expect(result.executed).toBe(true);
        expect(result.workItemId).toBe(newer.id);
        expect(calls).toBe(1);
        expect(check.get(newer.id)?.status).toBe("succeeded");
        expect(check.get(older.id)?.status).toBe("approved");
        expect(check.getWorkItemAssignment(older.id)?.selectedWorkerId).toBe("nimble-hold");
        expect(
          createWorkItemTools(check, createPolicyEngine()).claim_next_approved_work_item({ workerId: "worker-b" })
        ).toBeUndefined();
        expect(check.readEvents({ name: "nimble.outcome_attached", limit: 10 })).toHaveLength(1);
        const receipt = check.readEvents({ name: "nimble.decision_receipt", limit: 10 })[0];
        expect(JSON.parse(String(receipt?.body.receiptJson))).toMatchObject({
          authoritativeModel: "nimble",
          selectedId: newer.id
        });
      } finally {
        check.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reuses the stored decision when restart happens before permit issuance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-nimble-before-permit-"));
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath);
    const tools = createWorkItemTools(store, createPolicyEngine());
    let calls = 0;
    try {
      const workItem = tools.create_work_item(readOnly("Receipt before permit"));
      store.close();
      const model = {
        id: "nimble" as const,
        version: "test",
        answer: () => {
          calls += 1;
          return { answers: [{ id: "next_operation", choice: workItem.id, confidence: 0.96 }] };
        }
      };
      await expect(
        runWorkerOnce({
          dbPath,
          workerId: "worker-a",
          routing: "nimble",
          now: createdAt,
          decisionModel: model,
          nimbleStopAfter: "receipt",
          execute: async () => ({ ok: true, executionMode: "dry_run", output: "ok" })
        })
      ).rejects.toThrow("before_permit");
      expect(calls).toBe(1);
      expect(count(dbPath, "SELECT COUNT(*) AS count FROM execution_plan_admissions")).toBe(0);
      expect(count(dbPath, "SELECT COUNT(*) AS count FROM execution_attempts")).toBe(0);

      const resumed = await runWorkerOnce({
        dbPath,
        workerId: "worker-a",
        routing: "nimble",
        now: createdAt,
        decisionModel: model,
        execute: async () => ({ ok: true, executionMode: "dry_run", output: "ok" })
      });
      expect(calls).toBe(1);
      expect(resumed).toMatchObject({ executed: true, workItemId: workItem.id });
      expect(count(dbPath, "SELECT COUNT(*) AS count FROM execution_plan_admissions")).toBe(1);
      expect(count(dbPath, "SELECT COUNT(*) AS count FROM execution_attempts")).toBe(1);
      expect(count(dbPath, "SELECT COUNT(*) AS count FROM audit_events WHERE name = 'nimble.decision_receipt'")).toBe(1);
      expect(count(dbPath, "SELECT COUNT(*) AS count FROM audit_events WHERE name = 'nimble.outcome_attached'")).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not issue a second permit or execute twice when restart happens after the permit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-nimble-before-outcome-"));
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath);
    const tools = createWorkItemTools(store, createPolicyEngine());
    let calls = 0;
    let executions = 0;
    try {
      const workItem = tools.create_work_item(readOnly("Permit before outcome"));
      store.close();
      const model = {
        id: "nimble" as const,
        version: "test",
        answer: () => {
          calls += 1;
          return { answers: [{ id: "next_operation", choice: workItem.id, confidence: 0.96 }] };
        }
      };
      const execute = async () => {
        executions += 1;
        return { ok: true as const, executionMode: "dry_run" as const, output: "ok" };
      };
      await expect(
        runWorkerOnce({
          dbPath,
          workerId: "worker-a",
          routing: "nimble",
          now: createdAt,
          decisionModel: model,
          nimbleStopAfter: "execution_started",
          execute
        })
      ).rejects.toThrow("before_outcome");
      expect(calls).toBe(1);
      expect(executions).toBe(0);
      expect(count(dbPath, "SELECT COUNT(*) AS count FROM execution_plan_admissions")).toBe(1);
      expect(count(dbPath, "SELECT COUNT(*) AS count FROM execution_attempts")).toBe(1);

      const resumed = await runWorkerOnce({
        dbPath,
        workerId: "worker-a",
        routing: "nimble",
        now: createdAt,
        decisionModel: model,
        execute
      });
      expect(resumed).toMatchObject({ executed: false, workItemId: workItem.id, reason: "execution_in_flight" });
      expect(calls).toBe(1);
      expect(executions).toBe(0);
      expect(count(dbPath, "SELECT COUNT(*) AS count FROM execution_plan_admissions")).toBe(1);
      expect(count(dbPath, "SELECT COUNT(*) AS count FROM execution_attempts")).toBe(1);
      expect(count(dbPath, "SELECT COUNT(*) AS count FROM audit_events WHERE name = 'nimble.permit_issued'")).toBe(1);
      const check = new SqliteWorkItemStore(dbPath);
      try {
        expect(check.get(workItem.id)?.status).toBe("running");
        expect(
          createWorkItemTools(check, createPolicyEngine()).claim_next_approved_work_item({ workerId: "worker-b" })
        ).toBeUndefined();
      } finally {
        check.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
