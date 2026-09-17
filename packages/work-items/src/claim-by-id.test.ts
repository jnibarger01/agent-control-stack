import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteWorkItemStore, executionActionHash } from "./index.js";

const domainTransition = { via: "domain_service" } as const;

function approvedFixture(dir: string) {
  const store = new SqliteWorkItemStore(join(dir, "control.db"));
  const workItem = store.create({
    title: "Exact-id claim target",
    requester: "user",
    intent: "verify claimApprovedWorkItemById",
    target: { cwd: "/repo" },
    requestedActions: [{ kind: "manual", description: "claim by id" }],
    risk: "low"
  });
  store.approveWorkItem(workItem.id, domainTransition);
  return { store, workItem };
}

describe("SqliteWorkItemStore.claimApprovedWorkItemById", () => {
  it("claims the exact approved item when the expected action hash matches", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-claim-by-id-"));
    const { store, workItem } = approvedFixture(dir);

    try {
      const expected = executionActionHash(workItem);
      const claimed = store.claimApprovedWorkItemById(workItem.id, expected, "worker-a", {
        allowLegacyClaimForTests: true
      });

      expect(claimed?.id).toBe(workItem.id);
      expect(claimed?.status).toBe("running");
      expect(claimed?.workerId).toBe("worker-a");
      expect(store.get(workItem.id)?.status).toBe("running");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("denies the claim when the caller's expected action hash does not match current canonical state", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-claim-by-id-mismatch-"));
    const { store, workItem } = approvedFixture(dir);

    try {
      expect(() =>
        store.claimApprovedWorkItemById(workItem.id, "0".repeat(64), "worker-a", {
          allowLegacyClaimForTests: true
        })
      ).toThrowError(expect.objectContaining({ code: "execution_action_hash_mismatch" }));
      expect(store.get(workItem.id)?.status).toBe("approved");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined for a work item that is not approved", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-claim-by-id-not-approved-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      const workItem = store.create({
        title: "Draft item",
        requester: "user",
        intent: "verify non-approved denial",
        requestedActions: [{ kind: "manual", description: "not yet approved" }],
        risk: "low"
      });

      const claimed = store.claimApprovedWorkItemById(workItem.id, executionActionHash(workItem), "worker-a", {
        allowLegacyClaimForTests: true
      });

      expect(claimed).toBeUndefined();
      expect(store.get(workItem.id)?.status).toBe("pending_policy");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined for an unknown work item id", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-claim-by-id-unknown-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      const claimed = store.claimApprovedWorkItemById("wrk_does_not_exist", "0".repeat(64), "worker-a", {
        allowLegacyClaimForTests: true
      });
      expect(claimed).toBeUndefined();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lets exactly one of two competing claims on the same id win", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-claim-by-id-race-"));
    const dbPath = join(dir, "control.db");
    const firstStore = new SqliteWorkItemStore(dbPath);
    const secondStore = new SqliteWorkItemStore(dbPath);

    try {
      const workItem = firstStore.create({
        title: "Contested claim",
        requester: "user",
        intent: "verify exactly one winner",
        requestedActions: [{ kind: "manual", description: "contested" }],
        risk: "low"
      });
      firstStore.approveWorkItem(workItem.id, domainTransition);
      const expected = executionActionHash(workItem);

      const first = firstStore.claimApprovedWorkItemById(workItem.id, expected, "worker-a", {
        allowLegacyClaimForTests: true
      });
      const second = secondStore.claimApprovedWorkItemById(workItem.id, expected, "worker-b", {
        allowLegacyClaimForTests: true
      });

      expect(first?.workerId).toBe("worker-a");
      expect(second).toBeUndefined();
      expect(firstStore.get(workItem.id)?.status).toBe("running");
    } finally {
      firstStore.close();
      secondStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not touch a different approved work item when claiming by id", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-claim-by-id-isolation-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      const target = store.create({
        title: "Target item",
        requester: "user",
        intent: "the item we intend to resume",
        requestedActions: [{ kind: "manual", description: "target" }],
        risk: "low"
      });
      const decoy = store.create({
        title: "Decoy item",
        requester: "user",
        intent: "an older approved item that must not be silently claimed instead",
        requestedActions: [{ kind: "manual", description: "decoy" }],
        risk: "low"
      });
      store.approveWorkItem(decoy.id, domainTransition);
      store.approveWorkItem(target.id, domainTransition);

      const claimed = store.claimApprovedWorkItemById(target.id, executionActionHash(target), "worker-a", {
        allowLegacyClaimForTests: true
      });

      expect(claimed?.id).toBe(target.id);
      expect(store.get(decoy.id)?.status).toBe("approved");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires persisted attempt authority outside of tests", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-claim-by-id-authority-"));
    const { store, workItem } = approvedFixture(dir);

    try {
      expect(() =>
        store.claimApprovedWorkItemById(workItem.id, executionActionHash(workItem), "worker-a")
      ).toThrowError(expect.objectContaining({ code: "attempt_authority_required" }));
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
