import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { SqliteExecutionReadStore, SqliteWorkItemStore, defaultExecutionPlanForWorkItem } from "./index.js";

it("aggregates persisted attempts outside the dashboard page window, excluding future/old outcomes and unstarted latency", () => {
  const dir = mkdtempSync(join(tmpdir(), "acs-telemetry-"));
  const path = join(dir, "test.db");
  const now = new Date("2026-09-30T12:00:00Z");
  const store = new SqliteWorkItemStore(path);
  const db = new DatabaseSync(path);
  try {
    for (const [i, status, created, started, updated] of [
      [1, "succeeded", "2026-09-30T10:00:00.000Z", "2026-09-30T10:00:02.000Z", "2026-09-30T10:00:12.000Z"],
      [2, "failed", "2026-09-30T10:00:00.000Z", "2026-09-30T10:00:04.000Z", "2026-09-30T10:00:24.000Z"],
      [3, "failed", "2026-09-30T10:00:00.000Z", null, "2026-09-30T10:00:24.000Z"],
      [4, "succeeded", "2026-09-28T10:00:00.000Z", "2026-09-28T10:00:02.000Z", "2026-09-28T10:00:12.000Z"],
      [5, "succeeded", "2026-10-01T10:00:00.000Z", "2026-10-01T10:00:02.000Z", "2026-10-01T10:00:12.000Z"],
      [6, "failed", "2026-09-30T11:00:00.000Z", null, "2026-09-30T11:30:00.000Z"],
      [7, "failed", "2026-09-30T11:00:00.000Z", null, "2026-09-30T12:00:00.000Z"]
    ] as const) {
      const item = store.create({
        title: `Run ${i}`,
        requester: "user",
        intent: "read",
        target: {},
        requestedActions: [{ kind: "fs.read", description: "inspect", params: {} }],
        risk: "low"
      });
      const plan = store.createExecutionPlan({
        workItemId: item.id,
        definition: defaultExecutionPlanForWorkItem(item),
        createdByActorId: "operator"
      });
      const attempt = store.createAttempt(
        { workItemId: item.id, planHash: plan.planHash, inputHash: "a".repeat(64), now: new Date(created) },
        { via: "domain_service" }
      );
      // Fixture-only transitions obey the persisted lifecycle and immutable creation time.
      db.prepare(
        "UPDATE execution_attempts SET status='leased', current_fencing_epoch=1, claimed_by_worker_id='fixture-worker' WHERE attempt_id=?"
      ).run(attempt.attemptId);
      db.prepare("UPDATE execution_attempts SET status='running', started_at=? WHERE attempt_id=?").run(
        started ?? created,
        attempt.attemptId
      );
      db.prepare(
        "UPDATE execution_attempts SET status=?, started_at=?, updated_at=?, terminal_at=?, outcome_code='fixture' WHERE attempt_id=?"
      ).run(status, started, updated, updated, attempt.attemptId);
    }
    const reads = new SqliteExecutionReadStore(path);
    try {
      const telemetry = reads.telemetry(now);
      expect(telemetry.succeeded).toBe(1);
      expect(telemetry.failed).toBe(4);
      expect(telemetry.averageRunMs).toBeCloseTo(15000, -1);
      expect(telemetry.averageQueueMs).toBeCloseTo(3000, -1);
      expect(telemetry.throughput).toHaveLength(24);
      expect(telemetry.throughput.reduce((n, r) => n + r.started, 0)).toBe(2);
      expect(telemetry.throughput.reduce((n, r) => n + r.completed, 0)).toBe(1);
      expect(telemetry.throughput.reduce((n, r) => n + r.failed, 0)).toBe(4);
      expect(telemetry.throughput.at(-1)?.failed).toBe(2);
    } finally {
      reads.close();
    }
  } finally {
    db.close();
    store.close();
    rmSync(dir, { recursive: true });
  }
});
describe("empty execution telemetry", () => {
  it("returns zero outcomes and unknown latency rather than synthetic data", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-empty-telemetry-"));
    const path = join(dir, "test.db");
    const store = new SqliteWorkItemStore(path);
    store.close();
    const reads = new SqliteExecutionReadStore(path);
    try {
      expect(reads.telemetry().averageRunMs).toBeNull();
      expect(reads.telemetry().succeeded).toBe(0);
    } finally {
      reads.close();
      rmSync(dir, { recursive: true });
    }
  });
});

it("matches grant latency to the latest preceding approval requirement and retains unmatched grant counts", () => {
  const dir = mkdtempSync(join(tmpdir(), "acs-approval-telemetry-"));
  const path = join(dir, "test.db");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-30T10:00:00Z"));
  const store = new SqliteWorkItemStore(path);
  let reads: SqliteExecutionReadStore | undefined;
  try {
    const item = store.create({
      title: "Approval latency",
      requester: "user",
      intent: "test",
      target: {},
      requestedActions: [],
      risk: "high"
    });
    vi.setSystemTime(new Date("2026-09-30T10:02:00Z"));
    store.recordApproval({ workItemId: item.id, actionHash: "a".repeat(64), approvedBy: "independent-human" });
    const unmatched = store.create({
      title: "Legacy unmatched grant",
      requester: "user",
      intent: "test",
      target: {},
      requestedActions: [],
      risk: "low"
    });
    store.recordApproval({ workItemId: unmatched.id, actionHash: "b".repeat(64), approvedBy: "independent-human" });
    reads = new SqliteExecutionReadStore(path);
    const telemetry = reads.telemetry(new Date("2026-09-30T12:00:00Z"));
    expect(telemetry.approvalsGranted).toBe(2);
    expect(telemetry.averageApprovalMs).toBe(120000);
    expect(reads.telemetry(new Date("2026-10-02T12:00:00Z")).approvalsGranted).toBe(0);
  } finally {
    reads?.close();
    store.close();
    vi.useRealTimers();
    rmSync(dir, { recursive: true });
  }
});
