import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { afterEach, describe, expect, it } from "vitest";
import { ACS_ADMIN_APPROVAL_REASON, ACS_ADMIN_APPROVER } from "./execution-mode.js";
import { createPolicyEngine } from "./policy.js";
import { createWorkItemTools } from "./tools.js";

const domainTransition = { via: "domain_service" } as const;

/**
 * Authoritative Nimble routing requires persisted routing evidence for the claiming worker. Admin execution mode is the
 * temporary authority override: while it is active, a claim that consumes an ACS admin approval does not need that
 * evidence. Strict mode keeps full enforcement, and so does every claim that is not an admin-fenced claim.
 */
describe("claim by id: admin execution mode vs authoritative routing", () => {
  const directories: string[] = [];
  const priorEnabled = process.env.ACS_NIMBLE_ROUTING_ENABLED;

  afterEach(() => {
    if (priorEnabled === undefined) delete process.env.ACS_NIMBLE_ROUTING_ENABLED;
    else process.env.ACS_NIMBLE_ROUTING_ENABLED = priorEnabled;
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function fixture(mode: "strict" | "admin") {
    process.env.ACS_NIMBLE_ROUTING_ENABLED = "1";
    const directory = mkdtempSync(join(tmpdir(), "acs-claim-admin-routing-"));
    directories.push(directory);
    const store = new SqliteWorkItemStore(join(directory, "control.db"));
    if (mode === "admin")
      store.setExecutionMode({ mode: "admin", updatedBy: "operator", reason: "admin routing test" });
    const policy = createPolicyEngine();
    const tools = createWorkItemTools(store, policy);
    return { store, policy, tools };
  }

  function approvedItem({ store, policy, tools }: ReturnType<typeof fixture>, approver: string, reason: string) {
    const item = tools.create_work_item({
      title: "Routed claim target",
      requester: "user",
      intent: "claim by id while authoritative routing is enforced",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "fs.write", description: "write", params: { paths: ["src/index.ts"] } }],
      risk: "low"
    });
    const evaluation = policy.evaluateWorkItem(item, approver, "approve")[0]!;
    tools.approve_work_item({ id: item.id, approvedBy: approver, reason, actionHash: evaluation.actionHash });
    expect(store.get(item.id)?.status).toBe("approved");
    return item;
  }

  it("admin mode + admin approval + admin fence claims without routing evidence, and audits the override once", () => {
    const f = fixture("admin");
    try {
      const item = approvedItem(f, ACS_ADMIN_APPROVER, ACS_ADMIN_APPROVAL_REASON);
      const claimed = f.tools.claim_approved_work_item_by_id({
        id: item.id,
        workerId: "any-worker",
        executionModeFence: "admin"
      });
      expect(claimed?.status).toBe("running");
      expect(claimed?.workerId).toBe("any-worker");
      expect(claimed?.fencingEpoch).toBeDefined();
      const overrides = f.store.readEvents().filter((event) => event.name === "execution_mode.routing_override");
      expect(overrides).toHaveLength(1);
    } finally {
      f.store.close();
    }
  });

  it("strict mode keeps routing enforced for the same claim", () => {
    const f = fixture("strict");
    try {
      const item = approvedItem(f, "approver", "human approval");
      expect(
        f.tools.claim_approved_work_item_by_id({ id: item.id, workerId: "any-worker", executionModeFence: "admin" })
      ).toBeUndefined();
      expect(f.tools.claim_approved_work_item_by_id({ id: item.id, workerId: "any-worker" })).toBeUndefined();
      expect(f.store.get(item.id)?.status).toBe("approved");
      expect(f.store.readEvents().some((event) => event.name === "execution_mode.routing_override")).toBe(false);
    } finally {
      f.store.close();
    }
  });

  it("admin mode does not override routing for a claim without the admin fence", () => {
    const f = fixture("admin");
    try {
      const item = approvedItem(f, ACS_ADMIN_APPROVER, ACS_ADMIN_APPROVAL_REASON);
      expect(f.tools.claim_approved_work_item_by_id({ id: item.id, workerId: "any-worker" })).toBeUndefined();
      expect(f.store.get(item.id)?.status).toBe("approved");
    } finally {
      f.store.close();
    }
  });

  it("admin mode does not override routing when the item was only approved by a human, not by ACS admin", () => {
    const f = fixture("admin");
    try {
      const item = approvedItem(f, "approver", "human approval");
      expect(
        f.tools.claim_approved_work_item_by_id({ id: item.id, workerId: "any-worker", executionModeFence: "admin" })
      ).toBeUndefined();
      expect(f.store.get(item.id)?.status).toBe("approved");
    } finally {
      f.store.close();
    }
  });

  it("an expired admin window is strict again and routing is enforced", () => {
    const f = fixture("admin");
    try {
      const item = approvedItem(f, ACS_ADMIN_APPROVER, ACS_ADMIN_APPROVAL_REASON);
      f.store.setExecutionMode({
        mode: "strict",
        updatedBy: "acs:admin-expiry",
        reason: "admin execution mode expired"
      });
      expect(
        f.tools.claim_approved_work_item_by_id({ id: item.id, workerId: "any-worker", executionModeFence: "admin" })
      ).toBeUndefined();
    } finally {
      f.store.close();
    }
  });

  it("admin mode still honours a durable assignment to another worker", () => {
    const f = fixture("admin");
    try {
      const item = approvedItem(f, ACS_ADMIN_APPROVER, ACS_ADMIN_APPROVAL_REASON);
      f.store.assignWorkItem(
        { workItemId: item.id, selectedWorkerId: "worker-b", assignedByActorId: "operator" },
        domainTransition
      );
      expect(() =>
        f.tools.claim_approved_work_item_by_id({ id: item.id, workerId: "worker-a", executionModeFence: "admin" })
      ).toThrow(/assigned to another worker/u);
      expect(f.store.get(item.id)?.status).toBe("approved");
    } finally {
      f.store.close();
    }
  });

  it("an ACS admin approval on only some of the required actions does not unlock the override", () => {
    const f = fixture("admin");
    try {
      const item = f.tools.create_work_item({
        title: "Two required approvals",
        requester: "user",
        intent: "admin approves one required action, a human the other",
        target: { cwd: "/repo" },
        requestedActions: [
          { kind: "fs.write", description: "write one", params: { paths: ["src/one.ts"] } },
          { kind: "fs.write", description: "write two", params: { paths: ["src/two.ts"] } }
        ],
        risk: "high"
      });
      const [first, second] = f.policy.evaluateWorkItem(item, ACS_ADMIN_APPROVER, "approve");
      f.tools.approve_work_item({
        id: item.id,
        approvedBy: ACS_ADMIN_APPROVER,
        reason: ACS_ADMIN_APPROVAL_REASON,
        actionHash: first!.actionHash
      });
      f.tools.approve_work_item({
        id: item.id,
        approvedBy: "approver",
        reason: "human approval",
        actionHash: second!.actionHash
      });
      expect(f.store.get(item.id)?.status).toBe("approved");
      expect(f.store.hasGrantedApprovalBy(item.id, ACS_ADMIN_APPROVER)).toBe(true);
      expect(
        f.tools.claim_approved_work_item_by_id({ id: item.id, workerId: "any-worker", executionModeFence: "admin" })
      ).toBeUndefined();
      expect(f.store.readEvents().some((event) => event.name === "execution_mode.routing_override")).toBe(false);
    } finally {
      f.store.close();
    }
  });

  it("claim_next keeps routing enforced even in admin mode", () => {
    const f = fixture("admin");
    try {
      approvedItem(f, ACS_ADMIN_APPROVER, ACS_ADMIN_APPROVAL_REASON);
      expect(f.tools.claim_next_approved_work_item({ workerId: "any-worker" })).toBeUndefined();
    } finally {
      f.store.close();
    }
  });

  describe("policy-allowed (approval-free) items such as jc_status and jc_doctor", () => {
    function allowedItem({ store, tools }: ReturnType<typeof fixture>) {
      const item = tools.create_work_item({
        title: "Jace Commander capability: jc_status",
        requester: "agent",
        intent: "read-only diagnostic, policy allows it",
        target: {},
        requestedActions: [
          { kind: "jc.integration.read", description: "Jace Commander tool jc_status", params: { write: false } }
        ],
        risk: "low"
      });
      expect(store.get(item.id)?.status).toBe("approved");
      expect(store.hasGrantedApprovalBy(item.id, ACS_ADMIN_APPROVER)).toBe(false);
      return item;
    }

    it("admin mode + admin fence claims without routing evidence or an approval record, and audits the override", () => {
      const f = fixture("admin");
      try {
        const item = allowedItem(f);
        const claimed = f.tools.claim_approved_work_item_by_id({
          id: item.id,
          workerId: "any-worker",
          executionModeFence: "admin"
        });
        expect(claimed?.status).toBe("running");
        expect(claimed?.attemptId).toBeDefined();
        expect(f.store.hasGrantedApprovalBy(item.id, ACS_ADMIN_APPROVER)).toBe(false);
        expect(f.store.readEvents().filter((event) => event.name === "execution_mode.routing_override")).toHaveLength(
          1
        );
      } finally {
        f.store.close();
      }
    });

    it("strict mode keeps routing enforced, with or without the fence", () => {
      const f = fixture("strict");
      try {
        const item = allowedItem(f);
        expect(
          f.tools.claim_approved_work_item_by_id({ id: item.id, workerId: "any-worker", executionModeFence: "admin" })
        ).toBeUndefined();
        expect(f.tools.claim_approved_work_item_by_id({ id: item.id, workerId: "any-worker" })).toBeUndefined();
        expect(f.store.get(item.id)?.status).toBe("approved");
        expect(f.store.readEvents().some((event) => event.name === "execution_mode.routing_override")).toBe(false);
      } finally {
        f.store.close();
      }
    });

    it("admin mode does not override routing for a claim without the admin fence", () => {
      const f = fixture("admin");
      try {
        const item = allowedItem(f);
        expect(f.tools.claim_approved_work_item_by_id({ id: item.id, workerId: "any-worker" })).toBeUndefined();
        expect(f.store.get(item.id)?.status).toBe("approved");
      } finally {
        f.store.close();
      }
    });

    it("an expired admin window is strict again and routing is enforced", () => {
      const f = fixture("admin");
      try {
        const item = allowedItem(f);
        f.store.setExecutionMode({
          mode: "strict",
          updatedBy: "acs:admin-expiry",
          reason: "admin execution mode expired"
        });
        expect(
          f.tools.claim_approved_work_item_by_id({ id: item.id, workerId: "any-worker", executionModeFence: "admin" })
        ).toBeUndefined();
      } finally {
        f.store.close();
      }
    });

    it("admin mode still honours a durable assignment to another worker", () => {
      const f = fixture("admin");
      try {
        const item = allowedItem(f);
        f.store.assignWorkItem(
          { workItemId: item.id, selectedWorkerId: "worker-b", assignedByActorId: "operator" },
          domainTransition
        );
        expect(() =>
          f.tools.claim_approved_work_item_by_id({ id: item.id, workerId: "worker-a", executionModeFence: "admin" })
        ).toThrow(/assigned to another worker/u);
      } finally {
        f.store.close();
      }
    });
  });
});
