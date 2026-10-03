import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ControlStackError } from "@agent-control-stack/shared";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteWorkItemStore } from "./index.js";
import type { RecordAuthoritativeRoutingEvidenceInput } from "./routing.js";

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

const via = { via: "domain_service" } as const;
const now = new Date("2026-10-02T12:00:00.000Z");

function evidenceInput(
  workItemId: string,
  overrides: Partial<RecordAuthoritativeRoutingEvidenceInput> = {}
): RecordAuthoritativeRoutingEvidenceInput {
  return {
    workItemId,
    decision: "route",
    source: "nimble",
    reasonCode: "selected",
    routerVersion: "router-1",
    promptVersion: "prompt-1",
    eligible: ["codex-cli"],
    excluded: { "grok-cli": ["missing capability: repository_write"] },
    scores: { "codex-cli": 91 },
    candidates: ["codex-cli", "claude-code"],
    constraints: { risk: "low" },
    normalizedDecision: { selectedActorId: "codex-cli" },
    now,
    ...overrides
  };
}

function storeDb(store: SqliteWorkItemStore): {
  prepare: (sql: string) => { run: (...args: unknown[]) => unknown; get: (...args: unknown[]) => unknown };
} {
  return (
    store as unknown as {
      db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown; get: (...args: unknown[]) => unknown } };
    }
  ).db;
}

describe("authoritative routing persistence", () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("records evidence, lists it, and replays an outcome for the same decision", () => {
    const f = fixture();
    directory = f.directory;
    expect(f.store.getWorkItemRoutingSnapshot("missing-work-item")).toBeUndefined();
    expect(f.store.getWorkItemRoutingSnapshot(f.workItem.id)).toEqual({
      workItemId: f.workItem.id,
      status: f.workItem.status,
      hasExecutionResult: false,
      activeAttempt: false
    });
    expect(f.store.listAuthoritativeRoutingEvidence(f.workItem.id)).toEqual([]);
    expect(f.store.getLatestAuthoritativeRoutingEvidence(f.workItem.id)).toBeUndefined();

    const first = f.store.recordAuthoritativeRoutingEvidence(evidenceInput(f.workItem.id), via);
    expect(first).toMatchObject({
      workItemId: f.workItem.id,
      operationId: f.workItem.id,
      decision: "route",
      source: "nimble",
      idempotencyKey: `route.${f.workItem.id}.0`,
      createdAt: now.toISOString()
    });
    expect(first.missionId).toBeUndefined();
    expect(first.model).toBeUndefined();

    const second = f.store.recordAuthoritativeRoutingEvidence(
      evidenceInput(f.workItem.id, {
        missionId: "mission-1",
        operationId: "operation-1",
        attemptId: "attempt-1",
        selectedActorId: "codex-cli",
        decision: "fallback",
        source: "deterministic_fallback",
        reasonCode: "nimble_timeout",
        fallbackReason: "timeout",
        confidence: 0.2,
        model: "nimble:latest",
        lane: "dc",
        supersedesDecisionId: first.decisionId,
        candidates: ["claude-code"],
        normalizedDecision: { selectedActorId: "claude-code" }
      }),
      via
    );
    expect(second.idempotencyKey).toBe(`route.${f.workItem.id}.1`);
    expect(f.store.listAuthoritativeRoutingEvidence(f.workItem.id)).toEqual([first, second]);
    expect(f.store.getLatestAuthoritativeRoutingEvidence(f.workItem.id)).toEqual(second);
    expect(f.store.readEvents().filter((event) => event.name === "actor.routing_decision.recorded")).toHaveLength(2);

    const outcome = f.store.recordRoutingExecutionOutcome(
      {
        decisionId: second.decisionId,
        executorId: "codex-cli",
        model: "nimble:latest",
        latencyMs: 40,
        success: true,
        timedOut: false,
        verificationResult: "passed",
        testsResult: "passed",
        retryCount: 0,
        idempotencyKey: "outcome-1",
        now
      },
      via
    );
    const replay = f.store.recordRoutingExecutionOutcome(
      {
        decisionId: second.decisionId,
        executorId: "codex-cli",
        model: "nimble:latest",
        latencyMs: 40,
        success: true,
        timedOut: false,
        verificationResult: "passed",
        testsResult: "passed",
        retryCount: 0,
        idempotencyKey: "outcome-1",
        now
      },
      via
    );
    expect(replay).toEqual(outcome);
    const failed = f.store.recordRoutingExecutionOutcome(
      {
        decisionId: first.decisionId,
        executorId: "claude-code",
        latencyMs: 5,
        success: false,
        timedOut: true,
        retryCount: 1,
        idempotencyKey: "outcome-2"
      },
      via
    );
    expect(failed.model).toBeUndefined();
    expect(f.store.listRoutingExecutionOutcomes(second.decisionId)).toEqual([outcome]);
    expect(f.store.listRoutingExecutionOutcomes(first.decisionId)).toEqual([failed]);
    expect(f.store.readEvents().filter((event) => event.name === "actor.routing_outcome.recorded")).toHaveLength(2);

    expect(() =>
      f.store.recordRoutingExecutionOutcome(
        {
          decisionId: "missing-decision",
          executorId: "codex-cli",
          latencyMs: 1,
          success: false,
          timedOut: false,
          retryCount: 0,
          idempotencyKey: "outcome-missing"
        },
        via
      )
    ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "routing_decision_not_found" }));
  });

  it("replays authoritative evidence when the generated key already has a row", () => {
    const f = fixture();
    directory = f.directory;
    const seeded = f.store.recordActorRoutingDecision(
      {
        workItemId: f.workItem.id,
        selectedActorId: "codex-cli",
        eligible: ["codex-cli"],
        excluded: {},
        scores: { "codex-cli": 1 },
        idempotencyKey: `route.${f.workItem.id}.1`
      },
      via
    );
    storeDb(f.store)
      .prepare(
        `INSERT INTO actor_routing_evidence
          (decision_id, mission_id, operation_id, decision, source, reason_code, fallback_reason, confidence, model, lane,
           router_version, prompt_version, candidate_json, constraints_json, normalized_decision_json, supersedes_decision_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        seeded.decisionId,
        "mission-1",
        "operation-1",
        "reject",
        "deterministic_fallback",
        "not_ready",
        "status",
        0,
        "nimble:latest",
        "jc",
        "router-1",
        "prompt-1",
        JSON.stringify(["codex-cli"]),
        JSON.stringify({ risk: "low" }),
        JSON.stringify({ status: f.workItem.status }),
        null,
        now.toISOString()
      );

    const replay = f.store.recordAuthoritativeRoutingEvidence(
      evidenceInput(f.workItem.id, { decision: "reject" }),
      via
    );
    expect(replay.decisionId).toBe(seeded.decisionId);
    expect(replay).toMatchObject({
      missionId: "mission-1",
      operationId: "operation-1",
      selectedActorId: "codex-cli",
      decision: "reject",
      source: "deterministic_fallback",
      reasonCode: "not_ready",
      fallbackReason: "status",
      confidence: 0,
      model: "nimble:latest",
      lane: "jc",
      idempotencyKey: `route.${f.workItem.id}.1`
    });
    expect(f.store.readEvents().filter((event) => event.name === "actor.routing_decision.recorded")).toHaveLength(1);
  });

  it("fails closed when the generated key points at a decision with no evidence", () => {
    const f = fixture();
    directory = f.directory;
    f.store.recordActorRoutingDecision(
      {
        workItemId: f.workItem.id,
        eligible: ["codex-cli"],
        excluded: {},
        scores: { "codex-cli": 1 },
        idempotencyKey: `route.${f.workItem.id}.1`
      },
      via
    );
    expect(() => f.store.recordAuthoritativeRoutingEvidence(evidenceInput(f.workItem.id), via)).toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "routing_evidence_missing" })
    );
  });

  it("requires the privileged transition before writing evidence or outcomes", () => {
    const f = fixture();
    directory = f.directory;
    expect(() =>
      f.store.recordAuthoritativeRoutingEvidence(evidenceInput(f.workItem.id), undefined as never)
    ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "policy_gate_required" }));
    expect(() =>
      f.store.recordRoutingExecutionOutcome(
        {
          decisionId: "missing-decision",
          executorId: "codex-cli",
          latencyMs: 1,
          success: false,
          timedOut: false,
          retryCount: 0,
          idempotencyKey: "outcome-unprivileged"
        },
        undefined as never
      )
    ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "policy_gate_required" }));
  });
});
