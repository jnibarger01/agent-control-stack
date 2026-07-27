import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stableHash } from "@agent-control-stack/shared";
import { SqliteWorkItemStore } from "./store.js";
import { describe, expect, it } from "vitest";

function completeReadItem(store: SqliteWorkItemStore) {
  const item = store.create({
    title: "Immutable source",
    requester: "user",
    intent: "inspect source",
    target: { cwd: "/repo" },
    requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["src/index.ts"] } }],
    risk: "low"
  });
  store.approveWorkItem(item.id, { via: "domain_service" });
  const claimed = store.claimNextApprovedWorkItem("worker-a", { allowLegacyClaimForTests: true });
  if (!claimed) throw new Error("expected source claim");
  store.submitWorkResult({
    workItemId: claimed.id,
    leaseId: claimed.leaseId,
    workerId: claimed.workerId,
    actionHash: claimed.actionHash,
    idempotencyKey: stableHash({ source: claimed.id, lease: claimed.leaseId }),
    outcome: "succeeded",
    startedAt: claimed.startedAt,
    finishedAt: new Date(Date.parse(claimed.startedAt) + 10).toISOString(),
    exitCode: 0,
    summary: "source completed in dry-run",
    structuredOutput: { simulated: true },
    artifacts: [],
    simulationMetadata: { executionMode: "dry_run", simulated: true }
  });
  return { item, sourceSnapshot: store.get(item.id)!, sourceActionHash: claimed.actionHash };
}

describe("immutable retry and clone lineage", () => {
  it("creates a fresh retry and leaves the terminal source unchanged", () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-retry-"));
    const store = new SqliteWorkItemStore(join(directory, "control.db"));
    try {
      const { item, sourceSnapshot } = completeReadItem(store);
      const retried = store.retryWorkItem(item.id, { actor: "user", reason: "verify again" });

      expect(retried.id).not.toBe(item.id);
      expect(retried.sourceWorkItemId).toBe(item.id);
      expect(retried.lineageType).toBe("retry");
      expect(retried.retryReason).toBe("verify again");
      expect(retried.retrySequence).toBe(1);
      expect(retried.rootWorkItemId).toBe(item.id);
      expect(retried.result).toBeUndefined();
      expect(store.get(item.id)).toEqual(sourceSnapshot);

      store.approveWorkItem(retried.id, { via: "domain_service" });
      const retryClaim = store.claimNextApprovedWorkItem("worker-a", { allowLegacyClaimForTests: true });
      if (!retryClaim) throw new Error("expected retry claim");
      store.submitWorkResult({
        workItemId: retryClaim.id,
        leaseId: retryClaim.leaseId,
        workerId: retryClaim.workerId,
        actionHash: retryClaim.actionHash,
        idempotencyKey: stableHash({ retry: retryClaim.id, lease: retryClaim.leaseId }),
        outcome: "succeeded",
        startedAt: retryClaim.startedAt,
        finishedAt: new Date(Date.parse(retryClaim.startedAt) + 10).toISOString(),
        exitCode: 0,
        summary: "retry completed in dry-run",
        structuredOutput: { simulated: true },
        artifacts: [],
        simulationMetadata: { executionMode: "dry_run", simulated: true }
      });
      const retryAgain = store.retryWorkItem(retried.id, { actor: "user", reason: "one more time" });
      expect(retryAgain.sourceWorkItemId).toBe(retried.id);
      expect(retryAgain.rootWorkItemId).toBe(item.id);
      expect(retryAgain.retrySequence).toBe(2);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("clones safe request fields with a new identity and fresh action hash", () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-clone-"));
    const dbPath = join(directory, "control.db");
    const store = new SqliteWorkItemStore(dbPath);
    try {
      const { item, sourceSnapshot, sourceActionHash } = completeReadItem(store);
      const cloned = store.cloneWorkItem(item.id, {
        actor: "user",
        title: "Cloned inspection",
        intent: "inspect a second path",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.read", description: "inspect other", params: { paths: ["src/other.ts"] } }]
      });
      store.approveWorkItem(cloned.id, { via: "domain_service" });

      expect(cloned.id).not.toBe(item.id);
      expect(cloned.sourceWorkItemId).toBe(item.id);
      expect(cloned.lineageType).toBe("clone");
      expect(cloned.title).toBe("Cloned inspection");
      expect(cloned.intent).toBe("inspect a second path");
      expect(store.get(item.id)).toEqual(sourceSnapshot);

      const cloneClaim = store.claimNextApprovedWorkItem("worker-a", { allowLegacyClaimForTests: true });
      expect(cloneClaim?.id).toBe(cloned.id);
      expect(cloneClaim?.actionHash).toMatch(/^[a-f0-9]{64}$/);
      expect(cloneClaim?.actionHash).not.toBe(sourceActionHash);
      expect(store.claimNextApprovedWorkItem("worker-b")).toBeUndefined();

      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const approvals = db
          .prepare(`SELECT COUNT(*) AS count FROM approval_records WHERE work_item_id = ?`)
          .get(cloned.id) as { count: number };
        expect(approvals.count).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects retry and clone of a nonterminal source", () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-lineage-state-"));
    const store = new SqliteWorkItemStore(join(directory, "control.db"));
    try {
      const item = store.create({
        title: "Running source",
        requester: "agent",
        intent: "remain active",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.read", description: "inspect" }],
        risk: "low"
      });
      store.approveWorkItem(item.id, { via: "domain_service" });
      store.claimNextApprovedWorkItem("worker-a", { allowLegacyClaimForTests: true });

      expect(() => store.retryWorkItem(item.id, { actor: "user", reason: "not safe yet" })).toThrow("terminal source");
      expect(() => store.cloneWorkItem(item.id, { actor: "user" })).toThrow("terminal source");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
