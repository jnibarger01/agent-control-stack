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
  afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined; });

  it("persists an explainable decision idempotently", () => {
    const f = fixture(); directory = f.directory;
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

  it("increments reliability counters through the audited store boundary", () => {
    const f = fixture(); directory = f.directory;
    f.store.recordActorReliability({ actorId: "codex-cli", outcome: "success" }, { via: "domain_service" });
    const result = f.store.recordActorReliability({ actorId: "codex-cli", outcome: "failure" }, { via: "domain_service" });
    expect(result).toMatchObject({ actorId: "codex-cli", successCount: 1, failureCount: 1 });
    expect(f.store.getActorReliability("codex-cli")).toEqual(result);
  });

  it("persists worker assignments and prevents a different worker from claiming", () => {
    const f = fixture(); directory = f.directory;
    f.store.createRegistryAgent({
      id: "agent-b",
      name: "Agent B",
      kind: "coding",
      acpRole: "IMPLEMENTATION_AGENT",
      status: "AVAILABLE",
      actorId: "actor_system_bootstrap"
    });
    f.store.approveWorkItem(f.workItem.id, { via: "domain_service" });
    const assignment = f.store.assignWorkItem({
      workItemId: f.workItem.id,
      selectedWorkerId: "worker-b",
      selectedAgentId: "agent-b",
      assignedByActorId: "router"
    }, { via: "domain_service", actorId: "router" });

    expect(f.store.getWorkItemAssignment(f.workItem.id)).toEqual(assignment);
    expect(f.store.findNextApprovedWorkItemForWorker("worker-a")).toBeUndefined();
    expect(f.store.findNextApprovedWorkItemForWorker("worker-b")?.id).toBe(f.workItem.id);
    expect(f.store.claimApprovedWorkItemById(f.workItem.id, "invalid-hash", "worker-a", {
      allowLegacyClaimForTests: true
    })).toBeUndefined();
    expect(f.store.get(f.workItem.id)?.status).toBe("approved");
    expect(f.store.readEvents().filter((event) => event.name === "work_item.assigned")).toHaveLength(1);
  });
});
