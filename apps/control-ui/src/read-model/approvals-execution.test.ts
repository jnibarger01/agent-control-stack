import { describe, expect, it } from "vitest";
import { controlOffered, parseApprovalsReadModel, parseExecutionReadModel, WORK_ITEM_CONTROL_STATUSES } from "@agent-control-stack/mission-control-contract";
import type { ExecutionAttempt, WorkItem } from "@agent-control-stack/work-items";
import { WORK_ITEM_CONTROL_STATUSES as CLASSIC } from "../work-item-controls.js";
import type { MissionControlAttemptLease, MissionControlViewModel } from "../types.js";
import { toApprovalsReadModel } from "./approvals.js";
import { toExecutionReadModel } from "./execution.js";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const hash = "c".repeat(64);
const viewer = { canApprove: true, canWrite: true };
const item = (id: string, status: WorkItem["status"], extra: Partial<WorkItem> = {}): WorkItem =>
  ({ id, title: `Item ${id}`, requester: "user", status, intent: "i", risk: "high", target: { cwd: "/home/secret/repo" }, requestedActions: [{ kind: "fs.write", description: "w", params: { apiKey: "sk-abcdefghijklmnop1234" } }], result: { stdout: "SECRET-STDOUT" }, createdAt: "2026-10-19T10:00:00.000Z", updatedAt: "2026-10-19T11:00:00.000Z", ...extra }) as WorkItem;
const attempt = (over: Record<string, unknown> = {}) => ({ attemptId: "att-1", workItemId: "w1", planId: "p", planHash: hash, attemptNumber: 1, protocolVersion: "acs.worker.v2", inputHash: hash, status: "running", currentFencingEpoch: 2, claimedByWorkerId: "agent-a", startedAt: "2026-10-19T11:00:00.000Z", createdAt: "x", updatedAt: "2026-10-19T11:30:00.000Z", ...over }) as unknown as ExecutionAttempt;
const lease = (over: Partial<MissionControlAttemptLease> = {}) => ({ leaseId: "l1", attemptId: "att-1", workItemId: "w1", admissionId: "a", workerId: "agent-a", planHash: hash, inputHash: hash, fencingEpoch: 2, protocolVersion: "v", policyVersion: "p", policyDecisionHash: hash, issuedAt: "2026-10-19T11:55:00.000Z", lastRenewedAt: "2026-10-19T11:55:00.000Z", expiresAt: "2026-10-19T12:00:30.000Z", maxExpiresAt: "z", status: "active", tokenHash: "deadbeefdeadbeef", ...over }) as unknown as MissionControlAttemptLease;
const base = (over: Record<string, unknown> = {}) => ({ workItems: [item("w1", "running"), item("w2", "needs_approval"), item("w3", "blocked"), item("w4", "succeeded")], now: NOW, ...over }) as unknown as MissionControlViewModel;

describe("toApprovalsReadModel", () => {
  const model = (over = {}) => base({ approvalActionsByWorkItem: { w2: [{ actionHash: hash, kind: "fs.write", description: "write it" }] }, ...over });

  it("lists only work waiting on a human, with its action hashes, and satisfies the contract", () => {
    const out = toApprovalsReadModel(model(), viewer);
    expect(parseApprovalsReadModel(JSON.parse(JSON.stringify(out))).ok).toBe(true);
    expect(out.items.map((i) => [i.id, i.status, i.actions.length])).toEqual([["w2", "needs_approval", 1], ["w3", "blocked", 0]]);
    expect(out.viewer).toEqual(viewer);
  });

  it("flags only needs_approval items older than the SLA", () => {
    const out = toApprovalsReadModel(model({ approvalSlaMs: 10 * 60 * 1000 }), viewer);
    expect(out.items.find((i) => i.id === "w2")?.overSla).toBe(true);
    expect(out.items.find((i) => i.id === "w3")?.overSla).toBe(false);
    expect(toApprovalsReadModel(model({ approvalSlaMs: 6 * 3600 * 1000 }), viewer).items.find((i) => i.id === "w2")?.overSla).toBe(false);
  });

  it("offers no action hashes when the gateway supplied none (never fabricated)", () => {
    expect(toApprovalsReadModel(model({ approvalActionsByWorkItem: undefined }), viewer).items.find((i) => i.id === "w2")?.actions).toEqual([]);
  });

  it("never forwards paths, params or results", () => {
    const json = JSON.stringify(toApprovalsReadModel(model(), viewer));
    for (const bad of ["/home/secret", "sk-abcdefghijklmnop", "SECRET-STDOUT", "apiKey"]) expect(json, bad).not.toContain(bad);
  });
});

describe("toExecutionReadModel", () => {
  const model = (over = {}) => base({ executionAttemptsByWorkItem: { w1: [attempt()], w4: [attempt({ attemptId: "att-4", workItemId: "w4", status: "succeeded", updatedAt: "2026-10-19T11:10:00.000Z" }), attempt({ attemptId: "att-5", workItemId: "w4", attemptNumber: 2, status: "quarantined" })] }, attemptLeasesByWorkItem: { w1: [lease({ fencingEpoch: 1 }), lease({ leaseId: "l2", fencingEpoch: 2 })] }, executionBackend: "dry_run", ...over });

  it("satisfies the contract and never exposes lease token hashes or work-item internals", () => {
    const out = toExecutionReadModel(model(), viewer);
    expect(parseExecutionReadModel(JSON.parse(JSON.stringify(out))).ok).toBe(true);
    const json = JSON.stringify(out);
    for (const bad of ["tokenHash", "deadbeef", "/home/secret", "sk-abcdefghijklmnop", "SECRET-STDOUT"]) expect(json, bad).not.toContain(bad);
  });

  it("summarises attempts honestly and uses the highest-epoch lease", () => {
    const out = toExecutionReadModel(model(), viewer);
    expect(out.summary).toEqual({ running: 1, failed: 0, attention: 1, expiringLeases: 1 });
    const row = out.attempts.find((a) => a.attemptId === "att-1")!;
    expect(row.lease).toMatchObject({ status: "active", expiringSoon: true });
    expect(out.attempts.find((a) => a.attemptId === "att-4")?.durationMs).toBe(10 * 60 * 1000);
    expect(out.dryRun).toBe("yes");
  });

  it("drops attempts whose work item is not in the loaded window instead of inventing a title", () => {
    const out = toExecutionReadModel(model({ executionAttemptsByWorkItem: { ghost: [attempt({ workItemId: "ghost" })] } }), viewer);
    expect(out.attempts).toEqual([]);
  });

  it("reports unknown backend honestly", () => {
    expect(toExecutionReadModel(model({ executionBackend: undefined }), viewer).dryRun).toBe("unknown");
  });
});

describe("control eligibility", () => {
  it("the SPA contract table equals the classic console table (no drift)", () => {
    expect(WORK_ITEM_CONTROL_STATUSES).toEqual(CLASSIC);
    expect(controlOffered("retry", "failed")).toBe(true);
    expect(controlOffered("retry", "running")).toBe(false);
    expect(controlOffered("cancel", "succeeded")).toBe(false);
    expect(controlOffered("clone", "anything")).toBe(true);
  });
});
