import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ControlStackError } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";
import { SqliteWorkItemStore, WorkItemEvent, transitionWorkItem } from "./index.js";

describe("work item state machine", () => {
  it("rejects invalid transitions", () => {
    const draft = {
      id: "wrk_test",
      title: "Draft item",
      requester: "user" as const,
      status: "draft" as const,
      intent: "prove transition enforcement",
      target: {},
      requestedActions: [],
      risk: "low" as const,
      createdAt: "2026-07-05T00:00:00.000Z",
      updatedAt: "2026-07-05T00:00:00.000Z"
    };

    expect(() => transitionWorkItem(draft, "running")).toThrow(ControlStackError);
  });

  it("requires worker claim path before running persisted work", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-running-claim-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      const workItem = store.create({
        title: "Claim-only running item",
        requester: "agent",
        intent: "verify running transition gate",
        requestedActions: [{ kind: "manual", description: "claim" }],
        risk: "low"
      });
      store.approveWorkItem(workItem.id);

      expectControlError(() => store.transition(workItem.id, "running"), "worker_claim_required");
      expect(store.claimNextApprovedWorkItem("worker-a")?.status).toBe("running");
    } finally {
      store.close();
    }
  });

  it("stores work items and blocks execution before approval", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-work-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      const workItem = store.create({
        title: "SQLite backed item",
        requester: "agent",
        intent: "verify table storage",
        requestedActions: [{ kind: "manual", description: "check storage" }],
        risk: "medium"
      });

      expect(store.get(workItem.id)?.status).toBe("pending_policy");
      expect(store.readEvents().map((event) => event.name)).toEqual([WorkItemEvent.Created]);
      expect(() => store.startWorkItem(workItem.id)).toThrow(ControlStackError);
      expect(store.approveWorkItem(workItem.id).status).toBe("approved");
      expect(store.startWorkItem(workItem.id).status).toBe("running");
    } finally {
      store.close();
    }
  });

  it("moves high-risk work to needs_approval", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-risk-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      const workItem = store.create({
        title: "High risk item",
        requester: "user",
        intent: "verify approval trigger",
        requestedActions: [{ kind: "manual", description: "inspect" }],
        risk: "high"
      });

      expect(workItem.status).toBe("needs_approval");
    } finally {
      store.close();
    }
  });

  it("claims approved work once across store connections", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-claim-"));
    const dbPath = join(dir, "control.db");
    const first = new SqliteWorkItemStore(dbPath);
    const second = new SqliteWorkItemStore(dbPath);

    try {
      const workItem = first.create({
        title: "Claim once",
        requester: "agent",
        intent: "verify SQL compare-and-swap",
        requestedActions: [{ kind: "manual", description: "claim" }],
        risk: "low"
      });
      first.approveWorkItem(workItem.id);

      const claimed = first.claimNextApprovedWorkItem("worker-a");
      expect(claimed?.id).toBe(workItem.id);
      expect(claimed?.workerId).toBe("worker-a");
      expect(claimed?.leaseToken).toEqual(expect.any(String));
      expect(claimed?.leaseExpiresAt).toEqual(expect.any(String));
      expect(second.claimNextApprovedWorkItem("worker-b")).toBeUndefined();
      expect(first.readEvents().filter((event) => event.name === WorkItemEvent.Running)).toHaveLength(1);
    } finally {
      first.close();
      second.close();
    }
  });

  it("fails stale running leases", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-lease-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      const workItem = store.create({
        title: "Lease item",
        requester: "agent",
        intent: "verify reaper",
        requestedActions: [{ kind: "manual", description: "lease" }],
        risk: "low"
      });
      store.approveWorkItem(workItem.id);
      store.claimNextApprovedWorkItem("worker-a", { leaseMs: 1 });

      const failed = store.failExpiredLeases(new Date(Date.now() + 1000));

      expect(failed).toHaveLength(1);
      expect(store.get(workItem.id)?.status).toBe("failed");
      expect(store.readEvents().at(-1)?.name).toBe(WorkItemEvent.Failed);
    } finally {
      store.close();
    }
  });

  it("binds result submission to the claimed worker lease", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-result-lease-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      const workItem = store.create({
        title: "Lease-bound result",
        requester: "agent",
        intent: "verify worker lease",
        requestedActions: [{ kind: "manual", description: "result" }],
        risk: "low"
      });
      store.approveWorkItem(workItem.id);
      const claimed = store.claimNextApprovedWorkItem("worker-a");

      expectControlError(
        () =>
          store.submitWorkResult({
            id: workItem.id,
            workerId: "worker-b",
            leaseToken: claimed!.leaseToken,
            status: "succeeded"
          }),
        "worker_lease_mismatch"
      );
      expectControlError(
        () =>
          store.submitWorkResult({
            id: workItem.id,
            workerId: "worker-a",
            leaseToken: "wrong-token",
            status: "succeeded"
          }),
        "worker_lease_mismatch"
      );

      expect(
        store.submitWorkResult({
          id: workItem.id,
          workerId: "worker-a",
          leaseToken: claimed!.leaseToken,
          status: "succeeded",
          result: { output: "ok" }
        }).status
      ).toBe("succeeded");
      expect(JSON.stringify(store.readEvents())).not.toContain(claimed!.leaseToken);
    } finally {
      store.close();
    }
  });

  it("rejects expired lease result submission", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-result-expired-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      const workItem = store.create({
        title: "Expired result",
        requester: "agent",
        intent: "verify expired result gate",
        requestedActions: [{ kind: "manual", description: "result" }],
        risk: "low"
      });
      store.approveWorkItem(workItem.id);
      const claimed = store.claimNextApprovedWorkItem("worker-a", { leaseMs: 1 });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expectControlError(
        () =>
          store.submitWorkResult({
            id: workItem.id,
            workerId: "worker-a",
            leaseToken: claimed!.leaseToken,
            status: "succeeded"
          }),
        "worker_lease_expired"
      );
    } finally {
      store.close();
    }
  });

  it("rejects result submission before running", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-result-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      const workItem = store.create({
        title: "Premature result",
        requester: "agent",
        intent: "verify result gate",
        requestedActions: [{ kind: "manual", description: "result" }],
        risk: "low"
      });

      expectControlError(
        () =>
          store.submitWorkResult({
            id: workItem.id,
            workerId: "worker-a",
            leaseToken: "invalid-token",
            status: "succeeded"
          }),
        "work_item_not_running"
      );
    } finally {
      store.close();
    }
  });

  it("stores approvals by work item and action hash", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-approval-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      const workItem = store.create({
        title: "Approval item",
        requester: "user",
        intent: "verify approval records",
        requestedActions: [{ kind: "edit", description: "write", params: { write: true } }],
        risk: "low"
      });

      const grant = store.recordApproval({
        workItemId: workItem.id,
        actionHash: "hash_test",
        approvedBy: "user",
        reason: "exact action"
      });

      expect(grant.approvalToken).toEqual(expect.any(String));
      expect(grant.requestHash).toEqual(expect.any(String));
      expect(store.hasApproval(workItem.id, "hash_test")).toBe(true);
      expect(store.hasApproval(workItem.id, "other_hash")).toBe(false);
      expect(store.readEvents().at(-1)?.name).toBe("approval.granted");
      expect(store.readEvents().at(-1)?.body).not.toHaveProperty("approvalToken");
      expect(() => store.consumeApproval(workItem.id, "hash_test", { approvalToken: "wrong" })).toThrow(
        ControlStackError
      );
      expect(() => store.consumeApproval(workItem.id, "hash_test", { requestHash: "wrong" })).toThrow(
        ControlStackError
      );
      store.consumeApproval(workItem.id, "hash_test", {
        approvalToken: grant.approvalToken,
        requestHash: grant.requestHash
      });
      expect(store.hasApproval(workItem.id, "hash_test")).toBe(false);
      expect(() => store.consumeApproval(workItem.id, "hash_test")).toThrow(ControlStackError);
    } finally {
      store.close();
    }
  });

  it("rejects expired approval records", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-approval-expired-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      const workItem = store.create({
        title: "Expired approval item",
        requester: "user",
        intent: "verify approval expiry",
        requestedActions: [{ kind: "edit", description: "write", params: { write: true } }],
        risk: "low"
      });

      store.recordApproval({
        workItemId: workItem.id,
        actionHash: "hash_test",
        approvedBy: "user",
        reason: "expired",
        createdAt: "2026-07-05T00:00:00.000Z",
        expiresAt: "2026-07-05T00:00:01.000Z"
      });

      expect(store.hasApproval(workItem.id, "hash_test")).toBe(false);
      expect(() => store.consumeApproval(workItem.id, "hash_test", new Date("2026-07-05T00:00:02.000Z"))).toThrow(
        ControlStackError
      );
    } finally {
      store.close();
    }
  });

  it("detects audit event tampering", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-audit-chain-"));
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath);

    try {
      store.create({
        title: "Audited item",
        requester: "agent",
        intent: "verify tamper evidence",
        requestedActions: [{ kind: "manual", description: "audit" }],
        risk: "low"
      });
      expect(store.verifyAuditChain()).toMatchObject({ ok: true, eventCount: 1 });
      store.close();

      const db = new DatabaseSync(dbPath);
      try {
        db.prepare(`UPDATE audit_events SET body = ? WHERE sequence = 1`).run(JSON.stringify({ tampered: true }));
      } finally {
        db.close();
      }

      const reopened = new SqliteWorkItemStore(dbPath);
      try {
        expect(reopened.verifyAuditChain()).toMatchObject({
          ok: false,
          failure: { sequence: 1, reason: "event_hash_mismatch" }
        });
      } finally {
        reopened.close();
      }
    } finally {
      try {
        store.close();
      } catch {
        // already closed in the tamper path
      }
    }
  });
});

function expectControlError(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ControlStackError);
    expect((error as ControlStackError).code).toBe(code);
    return;
  }
  throw new Error(`expected ControlStackError: ${code}`);
}
