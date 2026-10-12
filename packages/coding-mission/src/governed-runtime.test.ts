import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteWorkItemStore, executionPlanSubjectInputHash } from "@agent-control-stack/work-items";
import { afterEach, describe, expect, it } from "vitest";
import type { AutonomousAuthorityDefinition } from "./authority.js";
import { DEFAULT_DELEGATION_BUDGET } from "./budget.js";
import { createGovernedExecution, type GovernedExecution } from "./governed-runtime.js";
import type { DispatchEnvelope, ResultEnvelope } from "./worker-execution.js";

/**
 * End to end through the composition root only: real grant issue, bind, request_child_work, claim, dispatch, result,
 * revocation and process restart. Nothing here constructs a ledger by hand.
 */
const HUMAN = "human-issuer";
const ACTOR = "actor:lead";
const open: GovernedExecution[] = [];
const dirs: string[] = [];
afterEach(() => {
  while (open.length)
    try {
      open.pop()!.close();
    } catch {
      // already closed
    }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function boot(dbPath: string, state: { now: string }, actors: Record<string, string> = {}) {
  const exec = createGovernedExecution({
    dbPath,
    verifyOperator: () => false,
    resolveActor: (workerId) => actors[workerId],
    clock: () => state.now
  });
  open.push(exec);
  return exec;
}

function world() {
  const root = mkdtempSync(join(tmpdir(), "acs-governed-"));
  dirs.push(root);
  const dbPath = join(root, "control.db");
  const base = Date.now();
  const iso = (ms: number) => new Date(base + ms).toISOString();
  const state = { now: iso(1_000) };
  const actors = { "lead-worker": ACTOR, "child-worker": ACTOR };
  const exec = boot(dbPath, state, actors);
  const item = exec.items.create({
    title: "governed mission",
    intent: "delegate bounded work",
    requester: "agent",
    requesterSubject: "planner",
    target: { cwd: root },
    risk: "low",
    requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: [root] } }]
  });
  const definition: AutonomousAuthorityDefinition = {
    executingActorId: ACTOR,
    scope: [{ kind: "path", id: root, coverage: "descendants" }],
    toolClasses: [{ runtime: "desktop_commander", toolName: "read_file" }],
    maximumPrivileges: ["fs.read", "fs.write"],
    expiresAt: iso(3_600_000),
    limits: { maxOperations: 50, maxRuntimeMs: 600_000, maxParallelOperations: 4, maxAttemptsPerOperation: 3 }
  };
  const grant = exec.items.issueAutonomousAuthority(
    {
      missionId: item.id,
      issuedByActorId: HUMAN,
      requestId: "grant-1",
      expectedSubjectInputHash: executionPlanSubjectInputHash(item),
      definition,
      reason: "bounded mission authority"
    },
    { via: "policy_gate", actorId: HUMAN }
  );
  exec.missions.createGeneral({
    missionId: item.id,
    summary: "m",
    budget: { ...DEFAULT_DELEGATION_BUDGET },
    now: iso(0)
  });
  exec.missions.addWorkUnits(
    item.id,
    [{ unitId: "root", kind: "agent", title: "root", payload: { role: "lead", prompt: "p" } }],
    iso(0)
  );
  exec.authority.grantMissionAuthority({ missionId: item.id, grantId: grant.grantId });
  const rootClaim = { token: "tok-root", workerId: "lead-worker", route: {}, claimedAt: iso(500) };
  expect(exec.missions.claimUnit(item.id, "root", rootClaim)).toMatchObject({ ok: true });
  const child = (unitId: string) => ({
    unitId,
    workType: "research" as const,
    purpose: `purpose of ${unitId}`,
    payload: { role: "researcher", prompt: "look" },
    requestedAuthority: {
      ...definition,
      maximumPrivileges: ["fs.read" as const],
      limits: { maxOperations: 2, maxRuntimeMs: 60_000, maxParallelOperations: 1, maxAttemptsPerOperation: 1 }
    }
  });
  const spawn = (unitId: string, token: string) => {
    const result = exec.authority.requestChildWork({
      missionId: item.id,
      parentUnitId: "root",
      workerId: rootClaim.workerId,
      claimToken: rootClaim.token,
      children: [child(unitId)]
    });
    expect(result).toMatchObject({ ok: true });
    expect(
      exec.missions.claimUnit(item.id, unitId, { token, workerId: "child-worker", route: {}, claimedAt: iso(600) })
    ).toMatchObject({ ok: true });
  };
  const dispatch = (e: GovernedExecution, unitId: string, token: string, workerId = "child-worker") =>
    e.dispatcher.beginDispatch({
      missionId: item.id,
      unitId,
      claimToken: token,
      workerId,
      lane: "dc",
      now: iso(2_000)
    });
  return { root, dbPath, exec, item, grant, state, actors, iso, spawn, dispatch };
}

const succeeded = (d: DispatchEnvelope, finishedAt: string): ResultEnvelope => ({
  schemaVersion: "acs.work-unit-result.v1",
  attemptId: d.attemptId,
  missionId: d.missionId,
  unitId: d.unitId,
  unitAttempt: d.unitAttempt,
  workerId: d.workerId,
  lane: d.lane,
  claimTokenHash: d.claimTokenHash,
  outcome: "succeeded",
  startedAt: d.issuedAt,
  finishedAt,
  receipts: [{ kind: "tool_result", hash: "receipt-1" }],
  result: { resultHash: "result-1", files: [] },
  externalStateUncertain: false
});

describe("governed execution composition root", () => {
  it("runs child work from request through verified dispatch to an applied result, with the audit chain intact", () => {
    const w = world();
    w.spawn("child-a", "tok-a");
    const d = w.dispatch(w.exec, "child-a", "tok-a");
    expect(d.authority).toMatchObject({ grantId: w.grant.grantId });
    expect(d.authority.unitAuthorityHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(w.exec.dispatcher.applyResult({ claimToken: "tok-a", result: succeeded(d, w.iso(3_000)) })).toMatchObject({
      applied: "completed"
    });
    expect(w.exec.items.verifyAuditChain().ok).toBe(true);
  });

  it("refuses a worker the deployment does not map to the authority's actor", () => {
    const w = world();
    w.spawn("child-a", "tok-a");
    delete (w.actors as Record<string, string>)["child-worker"];
    expect(() => w.dispatch(w.exec, "child-a", "tok-a")).toThrow(/worker_not_authorized_for_authority/u);
    expect(w.exec.missions.events(w.item.id).map((e) => e.name)).toContain("authority.denied");
  });

  it("enforces a revocation made after a restart, for new and for resumed dispatches", () => {
    const w = world();
    w.spawn("child-a", "tok-a");
    w.spawn("child-b", "tok-b");
    const first = w.dispatch(w.exec, "child-a", "tok-a");
    w.exec.close();

    // A fresh process: new connections, new ledgers, same database.
    const restarted = boot(w.dbPath, w.state, w.actors);
    const reader = new SqliteWorkItemStore(w.dbPath);
    try {
      reader.revokeAutonomousAuthority(w.grant.grantId, HUMAN, "stop", { via: "policy_gate", actorId: HUMAN });
    } finally {
      reader.close();
    }
    expect(() => w.dispatch(restarted, "child-b", "tok-b")).toThrow(/grant_revoked/u);
    expect(() => w.dispatch(restarted, "child-a", "tok-a")).toThrow(/grant_revoked/u);
    // Revocation stops new and resumed dispatch; it does not rewrite an attempt that was already issued.
    expect(first.authority.grantId).toBe(w.grant.grantId);
  });

  it("stops dispatching once the authoritative work item is terminal, while the mission row is still active", () => {
    const w = world();
    w.spawn("child-a", "tok-a");
    w.exec.items.cancelWorkItem(w.item.id, { actor: "operator" }, { via: "policy_gate", actorId: HUMAN });
    expect(w.exec.missions.require(w.item.id).state).not.toBe("cancelled");
    expect(() => w.dispatch(w.exec, "child-a", "tok-a")).toThrow(/grant_subject_changed/u);
    expect(w.exec.missions.events(w.item.id).map((e) => e.name)).toContain("authority.denied");
  });

  it("refuses dispatch when a separate connection breaks the audit chain", () => {
    const w = world();
    w.spawn("child-a", "tok-a");
    const tamper = new DatabaseSync(w.dbPath);
    try {
      for (const { name } of tamper
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'audit_events'")
        .all() as Array<{ name: string }>) {
        tamper.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
      }
      const first = tamper.prepare("SELECT id FROM audit_events ORDER BY sequence LIMIT 1").get() as { id: string };
      tamper.prepare("DELETE FROM audit_events WHERE id = ?").run(first.id);
    } finally {
      tamper.close();
    }

    expect(() => w.dispatch(w.exec, "child-a", "tok-a")).toThrow(/authority_integrity/u);
    expect(w.exec.items.verifyAuditChain().ok).toBe(false);
  });

  it("refuses a private database, where the two stores would not share revocations", () => {
    for (const dbPath of [":memory:", "", "file::memory:", "file:private?mode=memory&cache=shared"])
      expect(() => boot(dbPath, { now: new Date().toISOString() }), dbPath).toThrow(/shared database file/u);
  });

  it("fails closed when an untyped caller omits the identity callbacks", () => {
    const base = { dbPath: join(mkdtempSync(join(tmpdir(), "acs-governed-")), "control.db") };
    dirs.push(join(base.dbPath, ".."));
    const missingActor = { ...base, verifyOperator: () => false } as never;
    const missingOperator = { ...base, resolveActor: () => undefined } as never;
    expect(() => createGovernedExecution(missingActor)).toThrow(/resolveActor/u);
    expect(() => createGovernedExecution(missingOperator)).toThrow(/verifyOperator/u);
  });

  it("close() releases the control-plane connections", () => {
    const w = world();
    w.exec.close();
    // Both stores must be released, not just the first one closed.
    expect(() => w.exec.missions.workUnits(w.item.id)).toThrow();
    expect(() => w.exec.items.get(w.item.id)).toThrow();
  });
});
