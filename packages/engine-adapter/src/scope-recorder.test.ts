import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteWorkItemStore, defaultExecutionPlanForWorkItem } from "@agent-control-stack/work-items";
import { afterEach, describe, expect, it } from "vitest";
import { storeBackedScopeRecorder } from "./command-broker.js";

/**
 * Slice B1-wire: the store-backed scope recorder writes the real retry-fence scope row, bound to the attempt's
 * current lease and fencing epoch, and fails (so the sandbox refuses to launch) when the binding is stale.
 */

const hex = (seed: string) => seed.repeat(64).slice(0, 64);
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function claimedAttempt() {
  const directory = mkdtempSync(join(tmpdir(), "acs-scope-recorder-"));
  directories.push(directory);
  const dbPath = join(directory, "control.db");
  const store = new SqliteWorkItemStore(dbPath);
  const workItem = store.create({
    title: "Scope recorder fixture",
    requester: "user",
    requesterSubject: "actor-user",
    intent: "record the execution unit before launch",
    target: { cwd: "/repo", files: ["src/index.ts"] },
    requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["src/index.ts"], write: false } }],
    risk: "low"
  });
  const plan = store.createExecutionPlan({
    workItemId: workItem.id,
    definition: defaultExecutionPlanForWorkItem(workItem),
    createdByActorId: "actor-user"
  });
  const admission = store.admitExecutionPlan(
    {
      workItemId: workItem.id,
      planHash: plan.planHash,
      policyVersion: "acs.policy.v1",
      policyDecisionHash: hex("1"),
      requiresApproval: false,
      admittedByActorId: "policy-gate"
    },
    { via: "policy_gate" }
  );
  store.approveWorkItem(workItem.id, { via: "domain_service" });
  const claimed = store.claimNextApprovedWorkItem("worker-1", {
    leaseMs: 60_000,
    attemptAuthority: {
      planHash: plan.planHash,
      admissionId: admission.admissionId,
      policyVersion: "acs.policy.v1",
      policyDecisionHash: hex("1")
    }
  });
  if (!claimed?.attemptId || !claimed.leaseId || claimed.fencingEpoch === undefined) {
    throw new Error("expected an attempt-authority claim");
  }
  return {
    dbPath,
    store,
    binding: {
      workItemId: workItem.id,
      attemptId: claimed.attemptId,
      leaseId: claimed.leaseId,
      fencingToken: claimed.fencingEpoch,
      unitName: "acs-sandbox-attempt-0a1b2c3d.scope"
    }
  };
}

function scopeRows(dbPath: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare("SELECT attempt_id, work_item_id, lease_id, fencing_epoch, unit_name FROM attempt_execution_scopes")
      .all();
  } finally {
    db.close();
  }
}

describe("store-backed scope recorder (slice B1-wire)", () => {
  it("is absent for a store that cannot record scopes", () => {
    expect(storeBackedScopeRecorder({})).toBeUndefined();
  });

  it("writes the scope row bound to the current lease and fencing epoch", async () => {
    const { dbPath, store, binding } = claimedAttempt();
    try {
      await storeBackedScopeRecorder(store)!.record(binding);
      expect(scopeRows(dbPath)).toEqual([
        {
          attempt_id: binding.attemptId,
          work_item_id: binding.workItemId,
          lease_id: binding.leaseId,
          fencing_epoch: binding.fencingToken,
          unit_name: binding.unitName
        }
      ]);
      // Recording the same unit again is idempotent.
      await storeBackedScopeRecorder(store)!.record(binding);
      expect(scopeRows(dbPath)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it.each([
    ["a stale fencing token", { fencingToken: 99 }, "execution_scope_binding_mismatch"],
    ["a lease of another attempt", { leaseId: "lease_other" }, "execution_scope_binding_mismatch"]
  ])("fails on %s, so the sandbox refuses to launch", async (_label, change, code) => {
    const { dbPath, store, binding } = claimedAttempt();
    try {
      let caught: unknown;
      try {
        await storeBackedScopeRecorder(store)!.record({ ...binding, ...change });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code });
      expect(scopeRows(dbPath)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("refuses a second, different unit for the same attempt", async () => {
    const { store, binding } = claimedAttempt();
    try {
      await storeBackedScopeRecorder(store)!.record(binding);
      let caught: unknown;
      try {
        await storeBackedScopeRecorder(store)!.record({ ...binding, unitName: "acs-sandbox-attempt-ffffffff.scope" });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "execution_scope_contradiction" });
    } finally {
      store.close();
    }
  });
});
