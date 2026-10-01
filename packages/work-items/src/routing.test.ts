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

  it("stores JEV routing comparison as append-only audit evidence without changing the route", () => {
    const f = fixture();
    directory = f.directory;
    const decision = f.store.recordActorRoutingDecision(
      {
        workItemId: f.workItem.id,
        selectedActorId: "codex-cli",
        eligible: ["codex-cli", "claude-code"],
        excluded: {},
        scores: { "codex-cli": 91, "claude-code": 87 },
        idempotencyKey: "route-shadow-1"
      },
      { via: "domain_service" }
    );

    const observation = f.store.recordActorRoutingShadowObservation(
      {
        workItemId: f.workItem.id,
        routingDecisionId: decision.decisionId,
        deterministicSelectedActorId: "codex-cli",
        eligible: ["codex-cli", "claude-code"],
        semanticSelectedActorId: "claude-code",
        semanticConfidence: 0.84,
        semanticProbabilities: { "codex-cli": 0.16, "claude-code": 0.84 },
        questionSetVersion: "jev-actor-routing@1",
        classifierVersion: "jev-advisory-v2",
        model: "jev-test",
        degraded: false,
        latencyMs: 12
      },
      { via: "domain_service" }
    );

    expect(observation.semanticSelectedActorId).toBe("claude-code");
    expect(f.store.getActorRoutingDecision(decision.decisionId)?.selectedActorId).toBe("codex-cli");
    expect(f.store.readEvents().filter((event) => event.name === "actor.routing_shadow.observed")).toHaveLength(1);
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
