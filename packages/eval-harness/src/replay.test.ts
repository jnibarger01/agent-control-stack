import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEvent } from "@agent-control-stack/shared";
import {
  SqliteWorkItemStore,
  WorkItemEvent,
  type WorkItem,
  type WorkItemStatus
} from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { findUnapprovedExecution, replay } from "./index.js";

const domainTransition = { via: "domain_service" } as const;

const baseWorkItem = {
  id: "wrk-replay",
  title: "Replay lifecycle",
  requester: "user",
  status: "pending_policy",
  intent: "Exercise strict replay",
  target: { cwd: "/repo" },
  requestedActions: [{ kind: "read", description: "inspect source", params: {} }],
  risk: "low",
  createdAt: "2026-07-15T00:00:00.000Z",
  updatedAt: "2026-07-15T00:00:00.000Z"
} satisfies WorkItem;

function lifecycleEvent(name: string, status: WorkItemStatus): AuditEvent {
  return {
    id: `evt-${status}`,
    name,
    timeUnixNano: "1",
    attributes: {
      "work_item.id": baseWorkItem.id,
      "work_item.status": status,
      "work_item.risk": baseWorkItem.risk,
      "work_item.requester": baseWorkItem.requester
    },
    body: structuredClone({ ...baseWorkItem, status })
  };
}

describe("deterministic replay", () => {
  it("fails closed for unknown work item lifecycle events", () => {
    const event = {
      id: "evt-unknown",
      name: "work_item.escalated",
      timeUnixNano: "1",
      attributes: {},
      body: {}
    } satisfies AuditEvent;

    expect(() => replay([event])).toThrow(/unknown work item lifecycle event/u);
  });

  it("fails closed for malformed known lifecycle event bodies", () => {
    const event = {
      id: "evt-malformed",
      name: "work_item.created",
      timeUnixNano: "1",
      attributes: { "work_item.id": "wrk-malformed", "work_item.status": "pending_policy" },
      body: { id: "wrk-malformed", status: "pending_policy" }
    } satisfies AuditEvent;

    expect(() => replay([event])).toThrow(/malformed work item lifecycle event/u);
  });

  it("fails closed for lifecycle snapshots that are not strict JSON values", () => {
    const event = lifecycleEvent(WorkItemEvent.Created, "pending_policy");
    const actions = event.body.requestedActions as Array<{ params: Record<string, unknown> }>;
    actions[0]!.params.hidden = undefined;

    expect(() => replay([event])).toThrow(/undefined is unsupported/u);
  });

  it("fails closed for lifecycle events referencing unknown work items", () => {
    expect(() => replay([lifecycleEvent(WorkItemEvent.Approved, "approved")])).toThrow(
      /event for unknown work item wrk-replay/u
    );
  });

  it("fails closed when lifecycle event IDs disagree with their attributes", () => {
    const event = lifecycleEvent(WorkItemEvent.Created, "pending_policy");
    event.attributes["work_item.id"] = "wrk-other";

    expect(() => replay([event])).toThrow(/work item id attribute mismatch/u);
  });

  it("fails closed when lifecycle statuses disagree with their attributes", () => {
    const event = lifecycleEvent(WorkItemEvent.Created, "pending_policy");
    event.attributes["work_item.status"] = "approved";

    expect(() => replay([event])).toThrow(/work item status attribute mismatch/u);
  });

  it("fails closed when lifecycle risk metadata disagrees with the body", () => {
    const event = lifecycleEvent(WorkItemEvent.Created, "pending_policy");
    event.attributes["work_item.risk"] = "critical";

    expect(() => replay([event])).toThrow(/work item risk attribute mismatch/u);
  });

  it("fails closed when lifecycle requester metadata disagrees with the body", () => {
    const event = lifecycleEvent(WorkItemEvent.Created, "pending_policy");
    event.attributes["work_item.requester"] = "agent";

    expect(() => replay([event])).toThrow(/work item requester attribute mismatch/u);
  });

  it("fails closed when requester subject metadata is missing or mismatched", () => {
    const event = lifecycleEvent(WorkItemEvent.Created, "pending_policy");
    event.body.requesterSubject = "user:123";

    expect(() => replay([event])).toThrow(/work item requester subject attribute mismatch/u);
  });

  it("fails closed when lifecycle event names disagree with body status", () => {
    expect(() =>
      replay([
        lifecycleEvent(WorkItemEvent.Created, "pending_policy"),
        lifecycleEvent(WorkItemEvent.Approved, "pending_policy")
      ])
    ).toThrow(/lifecycle event status mismatch/u);
  });

  it("fails closed for out-of-order execution and illegal transitions", () => {
    expect(() =>
      replay([
        lifecycleEvent(WorkItemEvent.Created, "pending_policy"),
        lifecycleEvent(WorkItemEvent.Running, "running")
      ])
    ).toThrow(/cannot transition work item from pending_policy to running/u);
  });

  it("fails closed when lifecycle snapshots rewrite immutable request fields", () => {
    const approved = lifecycleEvent(WorkItemEvent.Approved, "approved");
    approved.body.title = "Rewritten title";

    expect(() => replay([lifecycleEvent(WorkItemEvent.Created, "pending_policy"), approved])).toThrow(
      /work item snapshot mismatch for wrk-replay/u
    );
  });

  it("ignores unrelated mixed audit events for work item strictness", () => {
    const unrelatedWorkItemShapedEvent = {
      ...lifecycleEvent("connector.request", "pending_policy"),
      id: "evt-connector-request",
      name: "connector.request"
    };
    const memoryEvent = {
      id: "evt-memory",
      name: "memory.recorded",
      timeUnixNano: "2",
      attributes: { "memory.source": "eval" },
      body: {
        id: "mem-replay",
        source: "eval",
        content: "mixed streams remain valid",
        validFrom: "2026-07-15T00:00:00.000Z",
        tags: []
      }
    } satisfies AuditEvent;

    expect(replay([unrelatedWorkItemShapedEvent, memoryEvent])).toEqual({
      workItems: [],
      memories: [memoryEvent.body]
    });
  });

  it("fails closed when creation starts in a non-initial state", () => {
    expect(() => replay([lifecycleEvent(WorkItemEvent.Created, "approved")])).toThrow(
      /invalid initial work item status approved/u
    );
  });

  it("fails closed for duplicate work item creation", () => {
    const created = lifecycleEvent(WorkItemEvent.Created, "pending_policy");

    expect(() => replay([created, { ...created, id: "evt-created-again" }])).toThrow(
      /duplicate work item creation wrk-replay/u
    );
  });

  it("replays approved work through SQLite events", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-"));
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath);

    try {
      const workItem = store.create({
        title: "Check policy path",
        requester: "user",
        intent: "Exercise approval and worker lifecycle",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "read", description: "inspect source", params: { paths: ["src/index.ts"] } }],
        risk: "low"
      });

      const approved = store.approveWorkItem(workItem.id, domainTransition);

      expect(approved?.status).toBe("approved");
      const running = store.claimNextApprovedWorkItem("eval-worker", { allowLegacyClaimForTests: true });
      expect(running).toBeDefined();

      store.submitWorkResult({
        workItemId: running!.id,
        leaseId: running!.leaseId,
        workerId: "eval-worker",
        actionHash: running!.actionHash,
        idempotencyKey: "eval-replay-result-1",
        outcome: "succeeded",
        startedAt: running!.startedAt,
        finishedAt: new Date().toISOString(),
        summary: "deterministic replay completed",
        structuredOutput: { output: "ok" },
        simulationMetadata: { executionMode: "dry_run", simulated: true, reason: "eval_replay" }
      });

      expect(store.get(workItem.id)?.status).toBe("succeeded");
      expect(replay(store.readEvents()).workItems[0]?.status).toBe("succeeded");
      expect(findUnapprovedExecution(store.readEvents())).toEqual([]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
