import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteWorkItemStore } from "./index.js";

describe("persisted worker assignments", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function fixture() {
    const directory = mkdtempSync(join(tmpdir(), "acs-worker-assignment-"));
    directories.push(directory);
    const store = new SqliteWorkItemStore(join(directory, "control.db"));
    const workItem = store.create({
      title: "assignment fixture",
      requester: "user",
      requesterSubject: "operator",
      intent: "bind an approved item to the selected worker",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["README.md"] } }],
      risk: "low"
    });
    return { store, workItem };
  }

  it("requires approved work and assignment authority from the same actor", () => {
    const { store, workItem } = fixture();
    try {
      store.registerActor({ id: "operator", actorType: "HUMAN", displayName: "Operator" });
      const input = {
        workItemId: workItem.id,
        selectedWorkerId: "worker-one",
        assignedByActorId: "operator"
      };
      expect(() => store.assignWorkItem(input, { via: "domain_service" })).toThrow(
        "assignment actor must match the authorized caller"
      );
      expect(() => store.assignWorkItem(input, { via: "domain_service", actorId: "operator" })).toThrow(
        "only approved work items can be assigned"
      );
      expect(store.getWorkItemAssignment(workItem.id)).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("checks agent availability and routing consistency before recording an audited assignment", () => {
    const { store, workItem } = fixture();
    try {
      store.registerActor({ id: "operator", actorType: "HUMAN", displayName: "Operator" });
      store.approveWorkItem(workItem.id, { via: "domain_service" });
      for (const id of ["agent-one", "agent-two"]) {
        store.createRegistryAgent({
          id,
          name: id,
          kind: "cli",
          acpRole: "IMPLEMENTATION_AGENT",
          status: "AVAILABLE",
          actorId: "operator"
        });
      }
      const decision = store.recordActorRoutingDecision(
        {
          workItemId: workItem.id,
          selectedActorId: "agent-one",
          eligible: ["agent-one", "agent-two"],
          excluded: {},
          scores: { "agent-one": 91, "agent-two": 87 },
          idempotencyKey: "assignment-route-1"
        },
        { via: "domain_service" }
      );

      const options = { via: "domain_service" as const, actorId: "operator" };
      expect(() =>
        store.assignWorkItem(
          {
            workItemId: workItem.id,
            selectedWorkerId: "worker-one",
            selectedAgentId: "unknown-agent",
            assignedByActorId: "operator"
          },
          options
        )
      ).toThrow("selected agent is not available");
      expect(() =>
        store.assignWorkItem(
          {
            workItemId: workItem.id,
            selectedWorkerId: "worker-one",
            selectedAgentId: "agent-two",
            routingDecisionId: decision.decisionId,
            assignedByActorId: "operator"
          },
          options
        )
      ).toThrow("assignment does not match its routing decision");

      const assignment = store.assignWorkItem(
        {
          workItemId: workItem.id,
          selectedWorkerId: "worker-one",
          selectedAgentId: "agent-one",
          routingDecisionId: decision.decisionId,
          assignedByActorId: "operator"
        },
        options
      );
      expect(assignment).toMatchObject({
        workItemId: workItem.id,
        selectedWorkerId: "worker-one",
        selectedAgentId: "agent-one",
        routingDecisionId: decision.decisionId,
        assignedByActorId: "operator"
      });
      expect(store.getWorkItemAssignment(workItem.id)).toEqual(assignment);
      expect(
        store.readEvents({ workItemId: workItem.id }).filter((event) => event.name === "work_item.assigned")
      ).toHaveLength(1);
      expect(store.verifyAuditChain()).toMatchObject({ ok: true });
    } finally {
      store.close();
    }
  });
});
