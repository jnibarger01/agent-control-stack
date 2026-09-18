import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultExecutionPlanForWorkItem } from "./execution-plan.js";
import { SqliteWorkItemStore } from "./store.js";

let dir: string;
let dbPath: string;
let store: SqliteWorkItemStore;
let workItemId: string;
let authority: { attemptId: string; leaseId: string; workerId: string; fencingEpoch: number };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "acs-exec-audit-"));
  dbPath = join(dir, "control.db");
  store = new SqliteWorkItemStore(dbPath);
  const workItem = store.create({
    title: "audit fixture",
    requester: "user",
    intent: "record execution audit evidence",
    requestedActions: [{ kind: "fs.read", description: "inspect" }],
    risk: "low"
  });
  workItemId = workItem.id;
  const plan = store.createExecutionPlan({
    workItemId,
    definition: defaultExecutionPlanForWorkItem(workItem),
    createdByActorId: "operator-1"
  });
  const admission = store.admitExecutionPlan(
    {
      workItemId,
      planHash: plan.planHash,
      policyVersion: "acs.policy.v1",
      policyDecisionHash: "1".repeat(64),
      requiresApproval: false,
      admittedByActorId: "policy-gate"
    },
    { via: "policy_gate" }
  );
  store.approveWorkItem(workItemId, { via: "domain_service" });
  const claimed = store.claimNextApprovedWorkItem("worker-1", {
    attemptAuthority: {
      planHash: plan.planHash,
      admissionId: admission.admissionId,
      policyVersion: admission.policyVersion,
      policyDecisionHash: admission.policyDecisionHash
    }
  });
  if (!claimed?.attemptId || claimed.fencingEpoch === undefined) throw new Error("expected authoritative claim");
  authority = {
    attemptId: claimed.attemptId,
    leaseId: claimed.leaseId,
    workerId: claimed.workerId,
    fencingEpoch: claimed.fencingEpoch
  };
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("recordExecutionEvent", () => {
  it("appends a namespaced execution event to the canonical hash chain", () => {
    const event = store.recordExecutionEvent({
      name: "desktop_commander.tool_called",
      workItemId,
      ...authority,
      body: { toolName: "read_file", invocationFingerprint: "f".repeat(64) },
      attributes: { "desktop_commander.tool": "read_file" }
    });
    expect(event.name).toBe("desktop_commander.tool_called");
    expect(event.attributes["work_item.id"]).toBe(workItemId);
    expect(event.body.toolName).toBe("read_file");

    const names = store.readEvents({ limit: 100, workItemId }).map((e) => e.name);
    expect(names).toContain("desktop_commander.tool_called");
    expect(store.verifyAuditChain().ok).toBe(true);
  });

  it("fails closed on an event name outside the execution.* / desktop_commander.* namespace", () => {
    expect(() =>
      store.recordExecutionEvent({ name: "work_item.succeeded", workItemId, ...authority, body: {} })
    ).toThrow(/only accepts execution\.\* \/ desktop_commander\.\* events/);
    expect(() => store.recordExecutionEvent({ name: "arbitrary.event", workItemId, ...authority })).toThrow(
      /only accepts/
    );
  });

  it("requires a work item id", () => {
    expect(() =>
      store.recordExecutionEvent({ name: "execution.completed", workItemId: "  ", ...authority })
    ).toThrow();
  });

  it("rejects a stale fencing epoch and does not append the event", () => {
    const before = store.readEvents({ limit: 100 }).length;
    expect(() =>
      store.recordExecutionEvent({
        name: "execution.started",
        workItemId,
        ...authority,
        fencingEpoch: authority.fencingEpoch + 1
      })
    ).toThrowError(expect.objectContaining({ code: "execution_audit_fence_stale" }));
    expect(store.readEvents({ limit: 100 })).toHaveLength(before);
  });

  it("does not let caller-supplied body or attributes override canonical authority", () => {
    const event = store.recordExecutionEvent({
      name: "execution.started",
      workItemId,
      ...authority,
      body: { workItemId: "forged", workerId: "forged" },
      attributes: { "work_item.id": "forged", "worker.id": "forged" }
    });
    expect(event.body).toMatchObject({ workItemId, workerId: authority.workerId });
    expect(event.attributes).toMatchObject({
      "work_item.id": workItemId,
      "worker.id": authority.workerId,
      "attempt.id": authority.attemptId,
      "lease.id": authority.leaseId,
      "lease.fencing_epoch": authority.fencingEpoch
    });
  });
});
