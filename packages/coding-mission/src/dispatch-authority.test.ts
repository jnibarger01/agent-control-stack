import { DatabaseSync } from "node:sqlite";
import { executionPlanSubjectInputHash } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { ACTOR, HUMAN, setupRealGrants } from "./child-work-real-grants-fixture.js";
import { MissionAuthorityLedger } from "./child-work.js";
import { CodingMissionStore } from "./store.js";
import { WorkUnitExecutionLedger, type ExecutorLane } from "./worker-execution.js";

/**
 * Dispatch is where authority stops being a ledger and becomes a gate: beginDispatch is the one place every executor
 * lane passes before a worker runs a unit. These tests use the real grant store (human-issued grant, canonical hash,
 * audit-backed revocation), not an in-memory fake.
 */
type Fixture = ReturnType<typeof setupRealGrants>;

function governed() {
  const f = setupRealGrants();
  f.ledger.grantMissionAuthority({ missionId: f.item.id, grantId: f.grant.grantId });
  expect(f.missions.claimUnit(f.item.id, "root", f.claim)).toMatchObject({ ok: true });
  const dispatcher = new WorkUnitExecutionLedger(f.missions, { authority: f.ledger });
  return { ...f, dispatcher };
}

/** Admit one child through request_child_work and claim it. */
function claimedChild(f: Fixture, unitId = "child-a", token = "tok-child-a") {
  expect(f.ask(unitId)).toMatchObject({ ok: true });
  expect(
    f.missions.claimUnit(f.item.id, unitId, { token, workerId: "child-worker", route: {}, claimedAt: f.iso(600) })
  ).toMatchObject({ ok: true });
  return { unitId, token, workerId: "child-worker" };
}

function dispatchRoot(
  f: ReturnType<typeof governed>,
  over: { lane?: ExecutorLane; authority?: { grantId?: string } } = {}
) {
  return f.dispatcher.beginDispatch({
    missionId: f.item.id,
    unitId: "root",
    claimToken: f.claim.token,
    workerId: f.claim.workerId,
    lane: over.lane ?? "coder",
    ...(over.authority ? { authority: over.authority } : {}),
    now: f.iso(2_000)
  });
}

function dispatchChild(
  f: ReturnType<typeof governed>,
  child: { unitId: string; token: string; workerId: string },
  lane: ExecutorLane = "dc"
) {
  return f.dispatcher.beginDispatch({
    missionId: f.item.id,
    unitId: child.unitId,
    claimToken: child.token,
    workerId: child.workerId,
    lane,
    now: f.iso(2_000)
  });
}

const attempts = (f: Fixture) => {
  const db = new DatabaseSync(f.dbPath);
  try {
    return (db.prepare("SELECT count(*) AS n FROM work_unit_execution_attempts").get() as { n: number }).n;
  } finally {
    db.close();
  }
};
const denials = (f: Fixture) =>
  f.missions
    .events(f.item.id)
    .filter((e) => e.name === "authority.denied" && (e.body as { operation?: string }).operation === "dispatch");

describe("dispatch authority gate", () => {
  it("dispatches a root unit under the mission authority and binds the real grant into the envelope", () => {
    const f = governed();
    const envelope = dispatchRoot(f);
    expect(envelope.authority.grantId).toBe(f.grant.grantId);
    expect(envelope.authority.unitAuthorityHash).toBe(f.ledger.missionAuthority(f.item.id)?.definitionHash);
    expect(attempts(f)).toBe(1);
  });

  it("dispatches an admitted child under its own narrowed authority, not the mission's", () => {
    const f = governed();
    const child = claimedChild(f);
    const envelope = dispatchChild(f, child);
    const unit = f.ledger.unitAuthority(f.item.id, child.unitId)!;
    expect(envelope.authority.unitAuthorityHash).toBe(unit.definitionHash);
    expect(envelope.authority.unitAuthorityHash).not.toBe(f.ledger.missionAuthority(f.item.id)?.definitionHash);
    expect(envelope.authority.grantId).toBe(f.grant.grantId);
  });

  it("fails closed when a governed mission is dispatched with no verifier configured", () => {
    const f = governed();
    const unguarded = new WorkUnitExecutionLedger(f.missions);
    expect(() =>
      unguarded.beginDispatch({
        missionId: f.item.id,
        unitId: "root",
        claimToken: f.claim.token,
        workerId: f.claim.workerId,
        lane: "coder",
        now: f.iso(2_000)
      })
    ).toThrow(expect.objectContaining({ code: "dispatch_authority_denied" }));
    expect(attempts(f)).toBe(0);
    expect(denials(f)[0]?.body).toMatchObject({ reason: "authority_verifier_unavailable" });
  });

  it("leaves a mission with no authority binding exactly as it was", () => {
    const store = new CodingMissionStore(":memory:");
    store.createGeneral({ missionId: "plain", summary: "s", now: "2026-10-09T00:00:00.000Z" });
    store.addWorkUnits("plain", [{ unitId: "u", kind: "coding", title: "u" }], "2026-10-09T00:00:00.000Z");
    store.claimUnit("plain", "u", { token: "t", workerId: "w", route: {}, claimedAt: "2026-10-09T00:00:01.000Z" });
    const envelope = new WorkUnitExecutionLedger(store).beginDispatch({
      missionId: "plain",
      unitId: "u",
      claimToken: "t",
      workerId: "w",
      lane: "coder",
      now: "2026-10-09T00:00:02.000Z"
    });
    expect(envelope.authority).toEqual({});
    store.close();
  });

  it("refuses once the real grant is revoked, and a resumed dispatch is refused too", () => {
    const f = governed();
    dispatchRoot(f);
    f.items.revokeAutonomousAuthority(f.grant.grantId, HUMAN, "stop", { via: "policy_gate", actorId: HUMAN });
    expect(() => dispatchRoot(f)).toThrow(expect.objectContaining({ code: "dispatch_authority_denied" }));
    expect(denials(f)[0]?.body).toMatchObject({ reason: "grant_revoked", unitId: "root" });
    expect(attempts(f)).toBe(1);
  });

  it("refuses a first dispatch after revocation and writes no attempt", () => {
    const f = governed();
    f.items.revokeAutonomousAuthority(f.grant.grantId, HUMAN, "stop", { via: "policy_gate", actorId: HUMAN });
    expect(() => dispatchRoot(f)).toThrow(/grant_revoked/);
    expect(attempts(f)).toBe(0);
  });

  it("refuses a worker that does not resolve to the actor the authority was issued to", () => {
    const f = governed();
    // Same real grant store and subject hash for both, so the ONLY difference is who the worker resolves to.
    const grants = {
      getAutonomousAuthority: (id: string) => f.items.getAutonomousAuthority(id),
      currentSubjectInputHash: (id: string) => {
        const item = f.items.get(id);
        return item ? executionPlanSubjectInputHash(item) : undefined;
      }
    };
    const withActor = (actor: string) =>
      new MissionAuthorityLedger(f.missions, {
        grants,
        verifyOperator: () => false,
        clock: () => f.iso(1_000),
        resolveActor: () => actor
      });
    const stranger = withActor("actor:someone-else");
    const allowed = withActor(ACTOR);
    expect(ACTOR).not.toBe("actor:someone-else");
    const input = {
      missionId: f.item.id,
      unitId: "root",
      claimToken: f.claim.token,
      workerId: f.claim.workerId,
      lane: "coder" as const,
      now: f.iso(2_000)
    };
    expect(() => new WorkUnitExecutionLedger(f.missions, { authority: stranger }).beginDispatch(input)).toThrow(
      /worker_not_authorized_for_authority/
    );
    expect(attempts(f)).toBe(0);
    expect(new WorkUnitExecutionLedger(f.missions, { authority: allowed }).beginDispatch(input).workerId).toBe(
      f.claim.workerId
    );
  });

  it("refuses once the mission's execution inputs no longer match what the grant approved", () => {
    const f = governed();
    // Control first: with the real subject hash the same wiring dispatches.
    const ledgerFor = (subject: (id: string) => string | undefined) =>
      new MissionAuthorityLedger(f.missions, {
        grants: {
          getAutonomousAuthority: (id) => f.items.getAutonomousAuthority(id),
          currentSubjectInputHash: subject
        },
        verifyOperator: () => false,
        clock: () => f.iso(1_000),
        resolveActor: () => ACTOR
      });
    const real = (id: string) => {
      const item = f.items.get(id);
      return item ? executionPlanSubjectInputHash(item) : undefined;
    };
    const input = {
      missionId: f.item.id,
      unitId: "root",
      claimToken: f.claim.token,
      workerId: f.claim.workerId,
      lane: "coder" as const,
      now: f.iso(2_000)
    };
    const changed = new WorkUnitExecutionLedger(f.missions, { authority: ledgerFor(() => "b".repeat(64)) });
    expect(() => changed.beginDispatch(input)).toThrow(/grant_subject_changed/);
    const unavailable = new WorkUnitExecutionLedger(f.missions, { authority: ledgerFor(() => undefined) });
    expect(() => unavailable.beginDispatch(input)).toThrow(/grant_subject_changed/);
    expect(attempts(f)).toBe(0);
    const same = new WorkUnitExecutionLedger(f.missions, { authority: ledgerFor(real) });
    expect(same.beginDispatch(input).unitId).toBe("root");
  });

  it("refuses when the authority has expired on ACS's clock", () => {
    const f = governed();
    f.state.now = f.iso(3_700_000);
    expect(() => dispatchRoot(f)).toThrow(/authority_expired/);
  });

  it("refuses a caller-supplied grant reference that is not the verified one", () => {
    const f = governed();
    expect(() => dispatchRoot(f, { authority: { grantId: "some-other-grant" } })).toThrow(/authority_ref_mismatch/);
    expect(dispatchRoot(f, { authority: { grantId: f.grant.grantId } }).authority.grantId).toBe(f.grant.grantId);
  });

  it("refuses a lane whose tool runtime the authority does not grant", () => {
    const f = governed();
    const child = claimedChild(f);
    expect(() => dispatchChild(f, child, "jc")).toThrow(/lane_not_permitted/);
    expect(dispatchChild(f, child, "dc").lane).toBe("dc");
  });

  it("refuses a child created outside request_child_work instead of letting it inherit the mission", () => {
    const f = governed();
    f.missions.addWorkUnits(
      f.item.id,
      [{ unitId: "rogue", kind: "agent", title: "rogue", parentUnitId: "root", payload: { role: "r", prompt: "p" } }],
      f.iso(700)
    );
    f.missions.claimUnit(f.item.id, "rogue", { token: "tok-rogue", workerId: "w", route: {}, claimedAt: f.iso(800) });
    expect(() => dispatchChild(f, { unitId: "rogue", token: "tok-rogue", workerId: "w" })).toThrow(
      /unit_authority_missing/
    );
    expect(attempts(f)).toBe(0);
  });

  it("refuses a child superseded by a newer parent claim", () => {
    const f = governed();
    const child = claimedChild(f);
    const db = new DatabaseSync(f.dbPath);
    try {
      db.prepare(
        "INSERT INTO work_unit_child_supersessions (mission_id, child_unit_id, parent_unit_id, reason, created_at) VALUES (?, ?, 'root', 'test', ?)"
      ).run(f.item.id, child.unitId, f.iso(900));
    } finally {
      db.close();
    }
    expect(() => dispatchChild(f, child)).toThrow(/unit_superseded/);
  });

  it("enforces the authority's attempt limit on a retried unit", () => {
    const f = governed();
    const child = claimedChild(f);
    expect(dispatchChild(f, child).unitAttempt).toBe(1);
    f.missions.failUnit(f.item.id, child.unitId, child.token, {
      category: "tool_failure",
      retryable: true,
      now: f.iso(1_000)
    });
    f.missions.retryUnit(f.item.id, child.unitId, f.iso(1_100));
    expect(
      f.missions.claimUnit(f.item.id, child.unitId, {
        token: "tok-child-a-2",
        workerId: child.workerId,
        route: {},
        claimedAt: f.iso(1_200)
      })
    ).toMatchObject({ ok: true, attempt: 2 });
    expect(() => dispatchChild(f, { ...child, token: "tok-child-a-2" })).toThrow(/attempt_limit_exceeded/);
  });

  it("refuses a tampered authority record with durable evidence rather than dispatching", () => {
    const f = governed();
    const child = claimedChild(f);
    const db = new DatabaseSync(f.dbPath);
    try {
      db.exec("DROP TRIGGER work_unit_authority_no_update");
      db.prepare(
        "UPDATE work_unit_authority SET envelope_json = replace(envelope_json, 'fs.read', 'fs.write') WHERE unit_id = ?"
      ).run(child.unitId);
    } finally {
      db.close();
    }
    expect(() => dispatchChild(f, child)).toThrow(/authority_integrity_failure/);
    expect(denials(f)).toHaveLength(1);
    expect(attempts(f)).toBe(0);
  });
});
