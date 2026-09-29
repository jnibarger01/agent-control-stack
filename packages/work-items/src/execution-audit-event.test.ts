import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultExecutionPlanForWorkItem } from "./execution-plan.js";
import { SqliteWorkItemStore } from "./store.js";
import type { CanonicalTraceEvent } from "./trace-event.js";

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

function traceRows(): CanonicalTraceEvent[] {
  const db = new DatabaseSync(dbPath);
  try {
    return (
      db
        .prepare("SELECT canonical_json FROM trace_outbox WHERE work_item_id = ? ORDER BY seq")
        .all(workItemId) as Array<{ canonical_json: string }>
    ).map((row) => JSON.parse(row.canonical_json) as CanonicalTraceEvent);
  } finally {
    db.close();
  }
}

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
      body: {
        toolName: "read_file",
        invocationFingerprint: "f".repeat(64),
        argumentsDigest: "d".repeat(64),
        argumentCount: 1
      },
      attributes: {
        "desktop_commander.tool": "read_file",
        "desktop_commander.invocation_hash": "f".repeat(64),
        "action.hash": "a".repeat(64)
      }
    });
    expect(event.name).toBe("desktop_commander.tool_called");
    expect(event.attributes["work_item.id"]).toBe(workItemId);
    expect(event.body.toolName).toBe("read_file");

    const names = store.readEvents({ limit: 100, workItemId }).map((e) => e.name);
    expect(names).toContain("desktop_commander.tool_called");
    expect(store.verifyAuditChain().ok).toBe(true);
  });

  it("projects execution start and tool boundaries into bounded canonical trace evidence", () => {
    const invocationHash = "a".repeat(64);
    const actionHash = "b".repeat(64);
    const resultHash = "c".repeat(64);

    store.recordExecutionEvent({
      name: "execution.started",
      workItemId,
      ...authority,
      body: { toolName: "read_file" },
      attributes: {
        "desktop_commander.tool": "read_file",
        "desktop_commander.invocation_hash": invocationHash,
        "action.hash": actionHash
      }
    });
    store.recordExecutionEvent({
      name: "desktop_commander.tool_called",
      workItemId,
      ...authority,
      body: {
        toolName: "read_file",
        invocationFingerprint: invocationHash,
        argumentsDigest: "d".repeat(64),
        argumentCount: 2,
        arguments: { token: "must-never-enter-trace" }
      },
      attributes: {
        "desktop_commander.tool": "read_file",
        "desktop_commander.invocation_hash": invocationHash,
        "action.hash": actionHash
      }
    });
    store.recordExecutionEvent({
      name: "desktop_commander.tool_succeeded",
      workItemId,
      ...authority,
      body: {
        toolName: "read_file",
        invocationFingerprint: invocationHash,
        durationMs: 12,
        resultHash,
        truncated: false,
        isError: false,
        outcome: "succeeded"
      },
      attributes: {
        "desktop_commander.tool": "read_file",
        "desktop_commander.invocation_hash": invocationHash,
        "action.hash": actionHash,
        "execution.result_hash": resultHash
      }
    });

    const boundary = traceRows().filter((event) =>
      ["executor.started", "tool.call.started", "tool.call.finished"].includes(event.kind)
    );
    expect(boundary.map((event) => event.kind)).toEqual([
      "executor.started",
      "tool.call.started",
      "tool.call.finished"
    ]);
    expect(boundary[0]).toMatchObject({
      source: { system: "acs", component: "execution" },
      actor: { id: authority.workerId, type: "agent" },
      subject: { work_item_id: workItemId },
      payload: {
        executor: "desktop_commander",
        tool: "read_file",
        attempt_id: authority.attemptId,
        lease_id: authority.leaseId,
        lease_epoch: authority.fencingEpoch,
        action_hash: actionHash,
        invocation_hash: invocationHash
      }
    });
    expect(boundary[1]?.payload).toMatchObject({
      tool: "read_file",
      arguments_digest: "d".repeat(64),
      argument_count: 2
    });
    expect(boundary[2]?.payload).toMatchObject({
      tool: "read_file",
      status: "succeeded",
      duration_ms: 12,
      result_hash: resultHash,
      truncated: false,
      is_error: false,
      outcome: "succeeded"
    });
    expect(JSON.stringify(boundary)).not.toContain("must-never-enter-trace");
  });

  it("records failed tool completion without inventing a result hash", () => {
    store.recordExecutionEvent({
      name: "desktop_commander.tool_failed",
      workItemId,
      ...authority,
      body: {
        toolName: "read_file",
        durationMs: 8,
        resultHash: "",
        truncated: false,
        isError: true,
        outcome: "timeout",
        errorCode: "desktop_commander_timeout"
      },
      attributes: {
        "desktop_commander.tool": "read_file",
        "desktop_commander.invocation_hash": "f".repeat(64),
        "action.hash": "a".repeat(64),
        "execution.result_hash": ""
      }
    });

    const finished = traceRows().find((event) => event.kind === "tool.call.finished");
    expect(finished?.payload).toMatchObject({
      tool: "read_file",
      status: "failed",
      duration_ms: 8,
      result_hash: "",
      truncated: false,
      is_error: true,
      outcome: "timeout",
      error_code: "desktop_commander_timeout"
    });
  });

  it("keeps execution audit authority committed when execution trace persistence fails", () => {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`CREATE TRIGGER execution_trace_boom BEFORE INSERT ON trace_outbox
               BEGIN SELECT RAISE(ABORT, 'trace unavailable'); END`);
    } finally {
      db.close();
    }

    const beforeFailures = store.getTraceEnqueueFailureCount();
    const event = store.recordExecutionEvent({
      name: "execution.started",
      workItemId,
      ...authority,
      body: { toolName: "read_file" },
      attributes: {
        "desktop_commander.tool": "read_file",
        "desktop_commander.invocation_hash": "a".repeat(64),
        "action.hash": "b".repeat(64)
      }
    });

    expect(event.name).toBe("execution.started");
    expect(store.readEvents({ limit: 100, workItemId }).map((entry) => entry.name)).toContain("execution.started");
    expect(store.getTraceEnqueueFailureCount()).toBe(beforeFailures + 1);
    expect(traceRows().some((entry) => entry.kind === "executor.started")).toBe(false);
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
    expect(() => store.recordExecutionEvent({ name: "execution.completed", workItemId: "  ", ...authority })).toThrow();
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
      body: { workItemId: "forged", workerId: "forged", toolName: "read_file" },
      attributes: {
        "work_item.id": "forged",
        "worker.id": "forged",
        "desktop_commander.tool": "read_file",
        "desktop_commander.invocation_hash": "f".repeat(64),
        "action.hash": "a".repeat(64)
      }
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
