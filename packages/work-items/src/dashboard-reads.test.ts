import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DASHBOARD_FINISHED_LIMIT,
  MAX_DASHBOARD_FINISHED_LIMIT,
  SqliteExecutionReadStore,
  SqliteWorkItemStore,
  defaultExecutionPlanForWorkItem
} from "./index.js";

const dirs: string[] = [];
const domain = { via: "domain_service" as const, actorId: "operator" };

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function openStore(): { store: SqliteWorkItemStore; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "acs-dashboard-reads-"));
  dirs.push(dir);
  const dbPath = join(dir, "control.db");
  return { store: new SqliteWorkItemStore(dbPath), dbPath };
}

function create(store: SqliteWorkItemStore, title: string) {
  return store.create({
    title,
    requester: "user",
    intent: `seed ${title}`,
    target: {},
    requestedActions: [{ kind: "manual", description: "seed" }],
    risk: "low"
  });
}

function hex(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

describe("listDashboardWorkItems", () => {
  it("returns every active item, a bounded window of finished items, and exact status counts", () => {
    const { store } = openStore();
    try {
      const active = Array.from({ length: 3 }, (_, index) => create(store, `active ${index}`));
      const finished = Array.from({ length: 7 }, (_, index) => {
        const item = create(store, `finished ${index}`);
        return store.cancelWorkItem(item.id, { actor: "user" }, domain);
      });

      const page = store.listDashboardWorkItems({ finishedLimit: 4 });

      expect(page.active.map((item) => item.id).sort()).toEqual(active.map((item) => item.id).sort());
      expect(page.finished).toHaveLength(4);
      expect(page.finished.every((item) => item.status === "cancelled")).toBe(true);
      // Most recently finished first.
      expect(page.finished.map((item) => item.id)).toEqual(
        [...finished]
          .reverse()
          .slice(0, 4)
          .map((item) => item.id)
      );
      expect(page.finishedTotal).toBe(7);
      expect(page.finishedLimit).toBe(4);
      expect(page.statusCounts.cancelled).toBe(7);
      expect(Object.values(page.statusCounts).reduce((sum, count) => sum + count, 0)).toBe(10);
    } finally {
      store.close();
    }
  });

  it("defaults and clamps the finished window, and rejects invalid limits", () => {
    const { store } = openStore();
    try {
      expect(store.listDashboardWorkItems().finishedLimit).toBe(DEFAULT_DASHBOARD_FINISHED_LIMIT);
      expect(store.listDashboardWorkItems({ finishedLimit: 10_000_000 }).finishedLimit).toBe(
        MAX_DASHBOARD_FINISHED_LIMIT
      );
      expect(store.listDashboardWorkItems({ finishedLimit: 0 }).finished).toEqual([]);
      expect(() => store.listDashboardWorkItems({ finishedLimit: -1 })).toThrow(/non-negative/);
      expect(() => store.listDashboardWorkItems({ finishedLimit: 1.5 })).toThrow(/non-negative/);
    } finally {
      store.close();
    }
  });
});

describe("readEvents beforeSequence", () => {
  it("pages backwards through the audit log without gaps or overlap", () => {
    const { store } = openStore();
    try {
      for (let index = 0; index < 12; index += 1) create(store, `event source ${index}`);
      const all = store.readEvents({ limit: 500 });
      const pages: number[][] = [];
      let before: number | undefined;
      for (;;) {
        const page = store.readEvents({ limit: 5, ...(before === undefined ? {} : { beforeSequence: before }) });
        if (!page.length) break;
        pages.push(page.map((event) => event.sequence));
        before = page[0]!.sequence;
      }
      const seen = pages.flat().sort((left, right) => left - right);
      expect(seen).toEqual(all.map((event) => event.sequence));
      expect(pages.every((page) => page.every((value, index) => index === 0 || value > page[index - 1]!))).toBe(true);
      expect(() => store.readEvents({ beforeSequence: -1 })).toThrow(/beforeSequence/);
      const created = store.readEvents({ name: "work_item.created", limit: 500 });
      expect(created).toHaveLength(12);
      expect(created.every((event) => event.name === "work_item.created")).toBe(true);
      expect(store.readEvents({ name: "no.such.event" })).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe("batched execution reads", () => {
  it("returns the same attempts and leases as the per-item reads, grouped by work item", () => {
    const { store, dbPath } = openStore();
    const withAttempt = create(store, "leased");
    const plain = create(store, "no attempts");
    const plan = store.createExecutionPlan({
      workItemId: withAttempt.id,
      definition: defaultExecutionPlanForWorkItem(withAttempt),
      createdByActorId: "operator"
    });
    const admission = store.admitExecutionPlan(
      {
        workItemId: withAttempt.id,
        planHash: plan.planHash,
        policyVersion: "acs.policy.v1",
        policyDecisionHash: hex("1"),
        requiresApproval: false,
        admittedByActorId: "policy-gate"
      },
      { via: "policy_gate" }
    );
    const attempt = store.createAttempt(
      { workItemId: withAttempt.id, planHash: plan.planHash, inputHash: hex("a") },
      { via: "domain_service" }
    );
    store.leaseAttempt(
      {
        attemptId: attempt.attemptId,
        workItemId: withAttempt.id,
        admissionId: admission.admissionId,
        workerId: "worker-1",
        leaseToken: "lease-token-for-batched-read-test",
        policyVersion: admission.policyVersion,
        policyDecisionHash: admission.policyDecisionHash,
        ttlMs: 60_000
      },
      { via: "domain_service" }
    );
    store.close();

    const reads = new SqliteExecutionReadStore(dbPath);
    try {
      const ids = [withAttempt.id, plain.id, "wrk_unknown", withAttempt.id];
      const attempts = reads.listExecutionAttemptsForWorkItems(ids);
      const leases = reads.listAttemptLeasesForWorkItems(ids);

      expect([...attempts.keys()]).toEqual([withAttempt.id, plain.id, "wrk_unknown"]);
      for (const id of [withAttempt.id, plain.id, "wrk_unknown"]) {
        expect(attempts.get(id)).toEqual(reads.listExecutionAttempts(id));
        expect(leases.get(id)).toEqual(reads.listAttemptLeases(id));
      }
      expect(attempts.get(withAttempt.id)).toHaveLength(1);
      expect(leases.get(withAttempt.id)).toHaveLength(1);

      // More ids than one IN (...) batch still works.
      const many = Array.from({ length: 1_203 }, (_, index) => `wrk_missing_${index}`).concat(withAttempt.id);
      expect(reads.listExecutionAttemptsForWorkItems(many).get(withAttempt.id)).toHaveLength(1);
    } finally {
      reads.close();
    }
  });
});
