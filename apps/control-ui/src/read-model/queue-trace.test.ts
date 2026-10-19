import { describe, expect, it } from "vitest";
import { parseQueueReadModel, parseTraceReadModel } from "@agent-control-stack/mission-control-contract";
import type { ExecutionAttempt, ExecutionPlanAdmission, ExecutionPlanRecord, StoredAuditEvent, WorkItem } from "@agent-control-stack/work-items";
import type { MissionControlAttemptLease, MissionControlViewModel } from "../types.js";
import { toQueueReadModel } from "./queue.js";
import { toTraceReadModel } from "./trace.js";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const hash = "b".repeat(64);

const item = (id: string, status: WorkItem["status"], extra: Partial<WorkItem> = {}): WorkItem =>
  ({
    id, title: `Item ${id}`, requester: "user", status, intent: "intent", risk: "low",
    target: { cwd: "/home/secret/repo", files: ["/etc/passwd"] },
    requestedActions: [{ kind: "fs.read", description: "read", params: { apiKey: `${["sk", "abcdefghijklmnop1234"].join("-")}` } }],
    metadata: { correlationId: "c" }, result: { summary: `done TOKEN=${["hunter2", "value"].join("")}`, stdout: "SECRET-STDOUT", outcome: "succeeded" },
    createdAt: "2026-10-19T11:00:00.000Z", updatedAt: "2026-10-19T11:30:00.000Z", ...extra
  }) as WorkItem;

const plan = {
  planId: "plan-1", workItemId: "w1", planNumber: 2, planHash: hash, subjectInputHash: hash, createdByActorId: "planner", createdAt: "2026-10-19T11:01:00.000Z",
  definition: {
    schemaVersion: "acs.execution-plan.v1", workItemId: "w1", subjectInputHash: hash, objective: `Read files TOKEN=${["plan", "leak123"].join("")}`, target: { cwd: "/home/secret/repo" },
    steps: [{ stepId: "s1", sequence: 1, action: { kind: "fs.read", description: "read it", params: { path: "/etc/shadow" } }, successCriteria: [] }],
    constraints: { executionMode: "dry_run", network: "none", localGitOnly: true, allowPush: false, allowDeployment: false, allowedCommands: [["rm", "-rf", "/"]], maxRuntimeMs: 5000 }
  }
} as unknown as ExecutionPlanRecord;
const admission = { admissionId: "adm-1", workItemId: "w1", planId: "plan-1", planHash: hash, policyVersion: "p1", policyDecisionHash: hash, requiresApproval: true, admittedByActorId: "policy", admittedAt: "2026-10-19T11:02:00.000Z" } as ExecutionPlanAdmission;
const attempt = { attemptId: "att-1", workItemId: "w1", planId: "plan-1", planHash: hash, attemptNumber: 1, protocolVersion: "acs.worker.v2", inputHash: hash, status: "running", currentFencingEpoch: 2, claimedByWorkerId: "agent-a", createdAt: "x", updatedAt: "y" } as unknown as ExecutionAttempt;
const lease = (over: Partial<MissionControlAttemptLease>) => ({ leaseId: "l1", attemptId: "att-1", workItemId: "w1", admissionId: "adm-1", workerId: "agent-a", planHash: hash, inputHash: hash, fencingEpoch: 1, protocolVersion: "acs.worker.v2", policyVersion: "p1", policyDecisionHash: hash, issuedAt: "2026-10-19T11:50:00.000Z", expiresAt: "2026-10-19T12:05:00.000Z", maxExpiresAt: "2026-10-19T13:00:00.000Z", lastRenewedAt: "a", status: "active", tokenHash: "deadbeefdeadbeef", ...over }) as unknown as MissionControlAttemptLease;
const ev = (sequence: number, name: string, attributes: Record<string, string | number | boolean> = {}) => ({ sequence, id: `e${sequence}`, name, timeUnixNano: "1792411200000000000", attributes, body: {}, previousHash: "", eventHash: "" }) as StoredAuditEvent;

describe("toQueueReadModel", () => {
  const base = (over: Partial<MissionControlViewModel> = {}): MissionControlViewModel => ({
    workItems: [item("w1", "running"), item("w2", "needs_approval"), item("w3", "succeeded", { retrySequence: 1, sourceWorkItemId: "w2", rootWorkItemId: "w2", lineageType: "retry" as never })],
    executionPlansByWorkItem: { w1: plan }, executionPlanAdmissionsByWorkItem: { w1: admission },
    executionAttemptsByWorkItem: { w1: [attempt] }, attemptLeasesByWorkItem: { w1: [lease({ fencingEpoch: 1 }), lease({ leaseId: "l2", fencingEpoch: 3 })] },
    statusCounts: { running: 1, needs_approval: 1, succeeded: 20 }, now: NOW, ...over
  }) as MissionControlViewModel;

  it("satisfies the contract and leaks nothing sensitive", () => {
    const out = toQueueReadModel(base());
    expect(parseQueueReadModel(JSON.parse(JSON.stringify(out))).ok).toBe(true);
    const json = JSON.stringify(out);
    for (const bad of ["/home/secret", "/etc/passwd", `${["sk", "abcdefghijklmnop"].join("-")}`, "hunter2", "SECRET-STDOUT", "tokenHash", "deadbeef", "apiKey"]) expect(json, bad).not.toContain(bad);
  });

  it("reports plan state honestly: admitted, drafted, none, unknown", () => {
    const states = Object.fromEntries(toQueueReadModel(base({ executionPlansByWorkItem: { w1: plan, w2: plan }, executionPlanAdmissionsByWorkItem: { w1: admission } })).items.map((i) => [i.id, i.plan.state]));
    expect(states).toEqual({ w1: "admitted", w2: "drafted", w3: "none" });
    expect(toQueueReadModel(base({ executionPlansByWorkItem: undefined })).items.every((i) => i.plan.state === "unknown")).toBe(true);
  });

  it("uses the highest-epoch active lease and carries lineage", () => {
    const out = toQueueReadModel(base());
    expect(out.items.find((i) => i.id === "w1")?.lease?.fencingEpoch).toBe(3);
    expect(out.items.find((i) => i.id === "w3")?.lineage).toMatchObject({ retrySequence: 1, sourceWorkItemId: "w2" });
    expect(out.counts).toEqual({ source: "store", byStatus: { running: 1, needs_approval: 1, succeeded: 20 } });
  });

  it("falls back to window counts when store counts are absent", () => {
    expect(toQueueReadModel(base({ statusCounts: undefined })).counts).toMatchObject({ source: "window", byStatus: { running: 1, needs_approval: 1, succeeded: 1 } });
  });
});

describe("toTraceReadModel", () => {
  const input = (over = {}) => ({ workItem: item("w1", "running"), plan, admission, attempts: [attempt], leases: [lease({ fencingEpoch: 2 })], events: [ev(1, "work_item.created"), ev(2, "policy.decided"), ev(3, "work_item.needs_approval"), ev(4, "approval.granted", { apiToken: "xyz" })], now: NOW, ...over });
  const stageOf = (out: ReturnType<typeof toTraceReadModel>, key: string) => out.stages.find((s) => s.key === key)!;

  it("satisfies the contract and never forwards params, commands, paths, results or secrets", () => {
    const out = toTraceReadModel(input());
    expect(parseTraceReadModel(JSON.parse(JSON.stringify(out))).ok).toBe(true);
    const json = JSON.stringify(out);
    for (const bad of ["/home/secret", "/etc/shadow", "/etc/passwd", "rm", `${["sk", "abcdefghijklmnop"].join("-")}`, "hunter2", `${["plan", "leak123"].join("")}`, "SECRET-STDOUT", "deadbeef", "xyz", "apiKey"]) expect(json, bad).not.toContain(bad);
  });

  it("walks request through result with derived stages flagged", () => {
    const out = toTraceReadModel(input());
    expect(out.stages.map((s) => s.key)).toEqual(["request", "policy", "plan", "admission", "approval", "attempt", "lease", "result"]);
    expect(stageOf(out, "policy")).toMatchObject({ state: "done", derived: true });
    expect(stageOf(out, "approval")).toMatchObject({ state: "done", derived: true });
    expect(stageOf(out, "plan")).toMatchObject({ state: "done", derived: false });
    expect(stageOf(out, "attempt").state).toBe("current");
    expect(stageOf(out, "lease")).toMatchObject({ state: "current" });
    expect(out.approval.state).toBe("granted");
  });

  it("shows 'not admitted' when a plan exists without an admission (never inferred from status)", () => {
    const out = toTraceReadModel(input({ admission: undefined, attempts: [], leases: [], workItem: item("w1", "approved"), events: [] }));
    expect(stageOf(out, "admission")).toMatchObject({ state: "current" });
    expect(stageOf(out, "admission").summary).toContain("not admitted");
    expect(out.admission).toBeNull();
  });

  it("keeps approval required while the work item still awaits approval, even after one action was granted", () => {
    const out = toTraceReadModel(input({ workItem: item("w1", "needs_approval") }));
    expect(out.approval.state).toBe("required");
    expect(stageOf(out, "approval").state).not.toBe("done");
  });

  it("marks approval not applicable when policy did not require it and unavailable when unknowable", () => {
    expect(stageOf(toTraceReadModel(input({ admission: { ...admission, requiresApproval: false }, events: [ev(1, "policy.decided")] })), "approval").state).toBe("not_applicable");
    expect(stageOf(toTraceReadModel(input({ admission: undefined, events: [], workItem: item("w1", "succeeded") })), "approval").state).toBe("unavailable");
  });

  it("does not present policy auto-approval as a human grant", () => {
    const auto = toTraceReadModel(input({ admission: { ...admission, requiresApproval: false }, events: [ev(1, "policy.decided"), ev(2, "work_item.approved")] }));
    expect(auto.approval.state).toBe("not_required");
    expect(stageOf(auto, "approval").state).toBe("not_applicable");
    const human = toTraceReadModel(input({ admission: { ...admission, requiresApproval: true }, events: [ev(1, "work_item.needs_approval"), ev(2, "work_item.approved")] }));
    expect(human.approval.state).toBe("granted");
  });

  it("reports rejection and keeps each attempt's leases ordered by epoch", () => {
    const rejected = toTraceReadModel(input({ workItem: item("w1", "rejected"), events: [ev(1, "work_item.rejected")] }));
    expect(rejected.approval.state).toBe("rejected");
    const multi = toTraceReadModel(input({ leases: [lease({ leaseId: "l9", fencingEpoch: 5 }), lease({ leaseId: "l1", fencingEpoch: 1, status: "expired" })] }));
    expect(multi.attempts[0]?.leases.map((l) => l.fencingEpoch)).toEqual([1, 5]);
  });

  it("is honest with nothing persisted", () => {
    const out = toTraceReadModel({ workItem: item("w9", "draft", { result: undefined }), attempts: [], leases: [], events: [], now: NOW });
    expect(stageOf(out, "plan").state).toBe("pending");
    expect(stageOf(out, "attempt").state).toBe("pending");
    expect(stageOf(out, "result").state).toBe("pending");
    expect(out.plan).toBeNull();
    expect(out.result).toBeNull();
  });
});
