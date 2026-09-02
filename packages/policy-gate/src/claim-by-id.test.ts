import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { createPolicyEngine } from "./policy.js";
import { createWorkItemTools } from "./tools.js";

const domainTransition = { via: "domain_service" } as const;

describe("gateWorkerClaimById (claim_approved_work_item_by_id)", () => {
  it("claims a specific approved item and consumes its approval exactly once", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-claim-by-id-tools-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));
    const policy = createPolicyEngine();
    const tools = createWorkItemTools(store, policy);

    try {
      const workItem = tools.create_work_item({
        title: "Claim by id target",
        requester: "user",
        intent: "verify exact-id claim consumes approval once",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.write", description: "write", params: { paths: ["src/index.ts"] } }],
        risk: "low"
      });
      const evaluation = policy.evaluateWorkItem(workItem, "approver", "approve")[0];
      tools.approve_work_item({
        id: workItem.id,
        approvedBy: "approver",
        reason: "approve exact write",
        actionHash: evaluation!.actionHash
      });

      const claimed = tools.claim_approved_work_item_by_id({ id: workItem.id, workerId: "worker-a" });

      expect(claimed?.id).toBe(workItem.id);
      expect(claimed?.status).toBe("running");
      const events = store.readEvents();
      expect(events.filter((event) => event.name === "approval.consumed")).toHaveLength(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("claims only the requested item and leaves an older approved item untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-claim-by-id-tools-isolation-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));
    const tools = createWorkItemTools(store, createPolicyEngine());

    try {
      const decoy = tools.create_work_item({
        title: "Decoy read",
        requester: "user",
        intent: "an older approved item that must stay approved",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.read", description: "read", params: { paths: ["src/decoy.ts"] } }],
        risk: "low"
      });
      const target = tools.create_work_item({
        title: "Target read",
        requester: "user",
        intent: "the specific item to resume",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.read", description: "read", params: { paths: ["src/target.ts"] } }],
        risk: "low"
      });

      expect(decoy.status).toBe("approved");
      expect(target.status).toBe("approved");

      const claimed = tools.claim_approved_work_item_by_id({ id: target.id, workerId: "worker-a" });

      expect(claimed?.id).toBe(target.id);
      expect(store.get(decoy.id)?.status).toBe("approved");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-evaluates policy at claim time and blocks instead of claiming when approval is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-claim-by-id-tools-blocked-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));
    const tools = createWorkItemTools(store, createPolicyEngine());

    try {
      const workItem = store.create({
        title: "Approved without action approval",
        requester: "user",
        intent: "verify claim-time policy re-evaluation blocks an unapproved action",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.write", description: "write", params: { paths: ["src/index.ts"] } }],
        risk: "low"
      });
      store.approveWorkItem(workItem.id, domainTransition);

      const claimed = tools.claim_approved_work_item_by_id({ id: workItem.id, workerId: "worker-a" });

      expect(claimed?.status).toBe("blocked");
      expect(store.get(workItem.id)?.status).toBe("blocked");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined for a work item that is not approved", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-claim-by-id-tools-not-approved-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));
    const tools = createWorkItemTools(store, createPolicyEngine());

    try {
      const workItem = store.create({
        title: "Not approved",
        requester: "user",
        intent: "verify non-approved denial through the tool surface",
        requestedActions: [{ kind: "manual", description: "not approved" }],
        risk: "low"
      });

      expect(tools.claim_approved_work_item_by_id({ id: workItem.id, workerId: "worker-a" })).toBeUndefined();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lets exactly one of two competing claims on the same item win across store connections", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-claim-by-id-tools-race-"));
    const dbPath = join(dir, "control.db");
    const firstStore = new SqliteWorkItemStore(dbPath);
    const secondStore = new SqliteWorkItemStore(dbPath);
    const policy = createPolicyEngine();
    const firstTools = createWorkItemTools(firstStore, policy);
    const secondTools = createWorkItemTools(secondStore, policy);

    try {
      const workItem = firstTools.create_work_item({
        title: "Contested exact-id claim",
        requester: "user",
        intent: "verify exactly one winner across connections",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.read", description: "read", params: { paths: ["src/index.ts"] } }],
        risk: "low"
      });

      const claims = [
        firstTools.claim_approved_work_item_by_id({ id: workItem.id, workerId: "worker-a" }),
        secondTools.claim_approved_work_item_by_id({ id: workItem.id, workerId: "worker-b" })
      ];
      const claimed = claims.filter((candidate) => candidate !== undefined);

      expect(claimed).toHaveLength(1);
      expect(claimed[0]?.id).toBe(workItem.id);
    } finally {
      firstStore.close();
      secondStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cannot replay a consumed approval by claiming the same item a second time", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-claim-by-id-tools-replay-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));
    const policy = createPolicyEngine();
    const tools = createWorkItemTools(store, policy);

    try {
      const workItem = tools.create_work_item({
        title: "Replay target",
        requester: "user",
        intent: "verify a consumed approval cannot authorize a second claim",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.write", description: "write", params: { paths: ["src/index.ts"] } }],
        risk: "low"
      });
      const evaluation = policy.evaluateWorkItem(workItem, "approver", "approve")[0];
      tools.approve_work_item({
        id: workItem.id,
        approvedBy: "approver",
        reason: "approve exact write",
        actionHash: evaluation!.actionHash
      });

      const first = tools.claim_approved_work_item_by_id({ id: workItem.id, workerId: "worker-a" });
      expect(first?.status).toBe("running");

      // The item is now "running", not "approved" -- a second attempt to claim
      // the same id must not re-consume the approval or re-run the item.
      const second = tools.claim_approved_work_item_by_id({ id: workItem.id, workerId: "worker-b" });
      expect(second).toBeUndefined();

      const events = store.readEvents();
      expect(events.filter((event) => event.name === "approval.consumed")).toHaveLength(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
