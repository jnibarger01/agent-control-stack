import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteWorkItemStore } from "./index.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "acs-routing-"));
  const store = new SqliteWorkItemStore(join(directory, "control.db"));
  const workItem = store.create({
    title: "routing fixture",
    requester: "user",
    requesterSubject: "actor-user",
    intent: "route this task",
    target: { cwd: "/repo" },
    requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["README.md"], write: false } }],
    risk: "low"
  });
  return { directory, store, workItem };
}

describe("actor routing persistence", () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("persists an explainable decision idempotently", () => {
    const f = fixture();
    directory = f.directory;
    const input = {
      workItemId: f.workItem.id,
      selectedActorId: "codex-cli",
      eligible: ["codex-cli", "claude-code"],
      excluded: { "grok-cli": ["missing capability: repository_write"] },
      scores: { "codex-cli": 91, "claude-code": 87 },
      idempotencyKey: "route-work-1"
    };
    const first = f.store.recordActorRoutingDecision(input, { via: "domain_service" });
    const replay = f.store.recordActorRoutingDecision(input, { via: "domain_service" });
    expect(replay).toEqual(first);
    expect(f.store.getActorRoutingDecisionForWorkItem(f.workItem.id)).toEqual(first);
    expect(f.store.readEvents().filter((event) => event.name === "actor.routing_decision.recorded")).toHaveLength(1);
  });

  it("commits one immutable worker assignment against the persisted routing winner", () => {
    const f = fixture();
    directory = f.directory;
    f.store.registerActor({ id: "user", actorType: "HUMAN", displayName: "Operator" });
    const approved = f.store.approveWorkItem(f.workItem.id, { via: "domain_service", actorId: "user" });
    f.store.createRegistryAgent({
      id: "nimble-agent",
      name: "Nimble Agent",
      kind: "coding",
      acpRole: "IMPLEMENTATION_AGENT",
      status: "AVAILABLE",
      actorId: "user"
    });
    const decision = f.store.recordActorRoutingDecision(
      {
        workItemId: approved.id,
        selectedActorId: "nimble-agent",
        eligible: ["nimble-agent"],
        excluded: {},
        scores: { "nimble-agent": 9600 },
        idempotencyKey: `nimble-route:${approved.id}:1`
      },
      { via: "domain_service", actorId: "user" }
    );
    const assignment = f.store.assignWorkItem(
      {
        workItemId: approved.id,
        selectedAgentId: "nimble-agent",
        selectedWorkerId: "worker-1",
        routingDecisionId: decision.decisionId,
        assignedByActorId: "user"
      },
      { via: "domain_service", actorId: "user" }
    );

    expect(assignment).toMatchObject({
      workItemId: approved.id,
      selectedAgentId: "nimble-agent",
      selectedWorkerId: "worker-1"
    });
    expect(f.store.countActiveAssignmentsForWorker("worker-1")).toBe(1);
    expect(() =>
      f.store.assignWorkItem(
        {
          workItemId: approved.id,
          selectedAgentId: "nimble-agent",
          selectedWorkerId: "worker-2",
          routingDecisionId: decision.decisionId,
          assignedByActorId: "user"
        },
        { via: "domain_service", actorId: "user" }
      )
    ).toThrow(/already has an authoritative assignment/u);
    expect(f.store.getWorkItemAssignment(approved.id)).toEqual(assignment);
  });

  it("increments reliability counters through the audited store boundary", () => {
    const f = fixture();
    directory = f.directory;
    f.store.recordActorReliability({ actorId: "codex-cli", outcome: "success" }, { via: "domain_service" });
    const result = f.store.recordActorReliability(
      { actorId: "codex-cli", outcome: "failure" },
      { via: "domain_service" }
    );
    expect(result).toMatchObject({ actorId: "codex-cli", successCount: 1, failureCount: 1 });
    expect(f.store.getActorReliability("codex-cli")).toEqual(result);
  });
});
