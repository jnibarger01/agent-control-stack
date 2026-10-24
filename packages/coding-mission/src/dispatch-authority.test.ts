import { DatabaseSync } from "node:sqlite";
import { executionPlanSubjectInputHash } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { ACTOR, HUMAN, setupRealGrants, type RealGrantOptions } from "./child-work-real-grants-fixture.js";
import { MissionAuthorityLedger } from "./child-work.js";
import { CodingMissionStore } from "./store.js";
import {
  WorkUnitExecutionLedger,
  type DispatchEnvelope,
  type ExecutorLane,
  type ResultEnvelope
} from "./worker-execution.js";

/**
 * Dispatch is where authority stops being a ledger and becomes a gate: beginDispatch is the one place every executor
 * lane passes before a worker runs a unit. These tests use the real grant store (human-issued grant, canonical hash,
 * audit-backed revocation), not an in-memory fake.
 */
type Fixture = ReturnType<typeof setupRealGrants>;

function governed(options: RealGrantOptions = {}) {
  const f = setupRealGrants(options);
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

describe("dispatch deadline and lane authorization", () => {
  /** A root-level tool unit: it runs under the mission authority, so it goes through the same gate. */
  function toolUnit(f: ReturnType<typeof governed>, unitId: string, toolName: string) {
    f.missions.addWorkUnits(
      f.item.id,
      [{ unitId, kind: "tool", title: unitId, payload: { kind: "tool", toolName } }],
      f.iso(0)
    );
    const claim = { token: `tok-${unitId}`, workerId: "lead-worker", route: {}, claimedAt: f.iso(600) };
    expect(f.missions.claimUnit(f.item.id, unitId, claim)).toMatchObject({ ok: true });
    return claim;
  }
  const begin = (f: ReturnType<typeof governed>, unitId: string, token: string, lane: ExecutorLane) =>
    f.dispatcher.beginDispatch({
      missionId: f.item.id,
      unitId,
      claimToken: token,
      workerId: "lead-worker",
      lane,
      now: f.iso(2_000)
    });

  it("sets the deadline from the authority's runtime limit, and ignores one the caller supplies", () => {
    const f = governed();
    const envelope = f.dispatcher.beginDispatch({
      missionId: f.item.id,
      unitId: "root",
      claimToken: f.claim.token,
      workerId: f.claim.workerId,
      lane: "coder",
      authority: { deadlineAt: "2099-01-01T00:00:00.000Z" },
      now: f.iso(2_000)
    });
    // The fixture authority allows 600,000 ms and expires after 3,600,000 ms.
    expect(envelope.authority.deadlineAt).toBe(f.iso(2_000 + 600_000));
  });

  it("uses a child's own, narrower runtime limit", () => {
    const f = governed();
    const child = claimedChild(f);
    expect(dispatchChild(f, child, "coder").authority.deadlineAt).toBe(f.iso(2_000 + 60_000));
  });

  it("caps the deadline at the authority's expiry", () => {
    const f = governed();
    const dispatcher = new WorkUnitExecutionLedger(f.missions, { authority: f.ledger });
    // 3,599,000 ms in, the 600,000 ms limit would run past the 3,600,000 ms expiry.
    const envelope = dispatcher.beginDispatch({
      missionId: f.item.id,
      unitId: "root",
      claimToken: f.claim.token,
      workerId: f.claim.workerId,
      lane: "coder",
      now: f.iso(3_599_000)
    });
    expect(envelope.authority.deadlineAt).toBe(f.iso(3_600_000));
  });

  describe("results against the deadline, on ACS's clock", () => {
    function resultFor(dispatch: DispatchEnvelope, finishedAt: string): ResultEnvelope {
      return {
        schemaVersion: "acs.work-unit-result.v1",
        attemptId: dispatch.attemptId,
        missionId: dispatch.missionId,
        unitId: dispatch.unitId,
        unitAttempt: dispatch.unitAttempt,
        workerId: dispatch.workerId,
        lane: dispatch.lane,
        claimTokenHash: dispatch.claimTokenHash,
        outcome: "succeeded",
        startedAt: dispatch.issuedAt,
        finishedAt,
        receipts: [{ kind: "coder_result", hash: "r1" }],
        result: { resultHash: "result-1", files: ["a.ts"] },
        externalStateUncertain: false
      };
    }
    const timed = (f: ReturnType<typeof governed>, clock: { at: string }) =>
      new WorkUnitExecutionLedger(f.missions, { authority: f.ledger, clock: () => clock.at });

    it("accepts a result that arrives in time", () => {
      const f = governed();
      const clock = { at: f.iso(2_500) };
      const dispatcher = timed(f, clock);
      const dispatch = dispatcher.beginDispatch({
        missionId: f.item.id,
        unitId: "root",
        claimToken: f.claim.token,
        workerId: f.claim.workerId,
        lane: "coder",
        now: f.iso(2_000)
      });
      expect(dispatcher.applyResult({ claimToken: f.claim.token, result: resultFor(dispatch, f.iso(2_400)) })).toEqual({
        applied: "completed"
      });
    });

    it("records a result that arrives after the deadline as uncertain, even if the worker says it finished in time", () => {
      const f = governed();
      const clock = { at: f.iso(2_500) };
      const dispatcher = timed(f, clock);
      const dispatch = dispatcher.beginDispatch({
        missionId: f.item.id,
        unitId: "root",
        claimToken: f.claim.token,
        workerId: f.claim.workerId,
        lane: "coder",
        now: f.iso(2_000)
      });
      clock.at = f.iso(2_000 + 600_000 + 1);
      // The worker-reported finish time is inside the deadline, but ACS received it late: the report is not trusted.
      expect(dispatcher.applyResult({ claimToken: f.claim.token, result: resultFor(dispatch, f.iso(2_400)) })).toEqual({
        applied: "unknown"
      });
      expect(f.missions.workUnits(f.item.id).find((u) => u.unitId === "root")).toMatchObject({ status: "unknown" });
      const names = f.missions.events(f.item.id).map((e) => e.name);
      expect(names).toContain("work_unit.deadline_exceeded");
      expect(names).not.toContain("work_unit.completed");
    });

    it("treats an unreadable clock as late rather than on time", () => {
      const f = governed();
      const clock = { at: f.iso(2_500) };
      const dispatcher = timed(f, clock);
      const dispatch = dispatcher.beginDispatch({
        missionId: f.item.id,
        unitId: "root",
        claimToken: f.claim.token,
        workerId: f.claim.workerId,
        lane: "coder",
        now: f.iso(2_000)
      });
      clock.at = "not a time";
      expect(dispatcher.applyResult({ claimToken: f.claim.token, result: resultFor(dispatch, f.iso(2_400)) })).toEqual({
        applied: "unknown"
      });
    });
  });

  it("denies the cua lane when the grant has no browser runtime: lane_not_permitted", () => {
    const f = governed();
    expect(
      f.ledger.verifyDispatch({
        missionId: f.item.id,
        unitId: "root",
        workerId: f.claim.workerId,
        lane: "cua",
        attempt: 1
      })
    ).toEqual({ ok: false, reason: "lane_not_permitted" });
    expect(() => dispatchRoot(f, { lane: "cua" })).toThrow(/lane_not_permitted/u);
    expect(attempts(f)).toBe(0);
  });

  it("refuses cua in an ungoverned mission before any attempt is recorded", () => {
    const missions = new CodingMissionStore(":memory:");
    missions.createGeneral({ missionId: "m1", summary: "cua", now: "2026-10-10T00:00:00.000Z" });
    missions.addWorkUnits(
      "m1",
      [{ unitId: "u1", kind: "cua", title: "browse", payload: { kind: "cua", objective: "inspect" } }],
      "2026-10-10T00:00:00.000Z"
    );
    missions.releaseReadyUnits("m1", "2026-10-10T00:00:00.000Z");
    const claim = { token: "tok", workerId: "w1", route: {}, claimedAt: "2026-10-10T00:00:01.000Z" };
    expect(missions.claimUnit("m1", "u1", claim)).toMatchObject({ ok: true });
    const dispatcher = new WorkUnitExecutionLedger(missions);
    expect(() =>
      dispatcher.beginDispatch({
        missionId: "m1",
        unitId: "u1",
        claimToken: "tok",
        workerId: "w1",
        lane: "cua",
        now: "2026-10-10T00:00:02.000Z"
      })
    ).toThrow(/cua_requires_governed_mission/u);
    expect(missions.db.prepare("SELECT count(*) AS n FROM work_unit_execution_attempts").get()).toEqual({ n: 0 });
    expect(
      missions
        .events("m1")
        .filter((e) => e.name === "authority.denied")
        .map((e) => (e.body as { reason: string }).reason)
    ).toEqual(["cua_requires_governed_mission"]);
  });

  it("never authorizes the mcp lane: no grant can express it", () => {
    const f = governed();
    expect(() => dispatchRoot(f, { lane: "mcp" })).toThrow(/lane_not_permitted/u);
    expect(denials(f).map((e) => (e.body as { reason: string }).reason)).toContain("lane_not_permitted");
    expect(attempts(f)).toBe(0);
  });

  it("authorizes a named tool only by its exact runtime and tool", () => {
    const f = governed();
    const allowed = toolUnit(f, "tool-read", "read_file");
    const notListed = toolUnit(f, "tool-write", "write_file");
    // desktop_commander:read_file is granted; desktop_commander:write_file is not, though the runtime is.
    expect(begin(f, "tool-read", allowed.token, "dc")).toMatchObject({ lane: "dc", unitId: "tool-read" });
    expect(() => begin(f, "tool-write", notListed.token, "dc")).toThrow(/tool_not_permitted/u);
    expect(attempts(f)).toBe(1);
  });

  it("does not let a tool granted under one runtime be run on another lane", () => {
    const f = governed();
    const claim = toolUnit(f, "tool-read-jc", "read_file");
    expect(() => begin(f, "tool-read-jc", claim.token, "jc")).toThrow(/lane_not_permitted/u);
  });
});

describe("R2: browser runtime grant for the cua lane", () => {
  const APP = "browser";
  const ORIGIN = "https://app.example";
  const cuaRoot = (over: { origins?: string[]; applications?: string[] } = {}) => ({
    kind: "cua" as const,
    objective: "inspect",
    allowedApplications: over.applications ?? [APP],
    allowedOrigins: over.origins ?? [ORIGIN],
    actions: [{ type: "navigate", url: `${ORIGIN}/` }]
  });
  const browserGrant = (origins = [ORIGIN], applications = [APP]) => ({
    runtime: "browser" as const,
    toolName: "cua" as const,
    allowedOrigins: origins,
    allowedApplications: applications
  });
  const verify = (f: ReturnType<typeof governed>, lane: ExecutorLane = "cua") =>
    f.ledger.verifyDispatch({ missionId: f.item.id, unitId: "root", workerId: f.claim.workerId, lane, attempt: 1 });

  it("denies a governed cua dispatch with no browser grant", () => {
    const f = governed({ cuaRootPayload: cuaRoot() });
    expect(verify(f)).toEqual({ ok: false, reason: "lane_not_permitted" });
    expect(() => dispatchRoot(f, { lane: "cua" })).toThrow(/lane_not_permitted/u);
    expect(attempts(f)).toBe(0);
  });

  it("denies cua when the grant covers only jc and dc runtimes", () => {
    const f = governed({
      cuaRootPayload: cuaRoot(),
      toolClasses: [
        { runtime: "jace_commander", toolName: "read_file" },
        { runtime: "desktop_commander", toolName: "read_file" }
      ]
    });
    expect(verify(f)).toEqual({ ok: false, reason: "lane_not_permitted" });
    expect(() => dispatchRoot(f, { lane: "cua" })).toThrow(/lane_not_permitted/u);
    expect(attempts(f)).toBe(0);
  });

  it("allows cua under an explicit browser grant that covers its origins and application", () => {
    const f = governed({ cuaRootPayload: cuaRoot(), extraToolClasses: [browserGrant()] });
    expect(verify(f)).toMatchObject({ ok: true, grantId: f.grant.grantId });
    const envelope = dispatchRoot(f, { lane: "cua" });
    expect(envelope.lane).toBe("cua");
    expect(envelope.authority.grantId).toBe(f.grant.grantId);
    expect(attempts(f)).toBe(1);
  });

  it("denies a cua unit whose origins or application exceed the browser grant", () => {
    for (const payload of [
      cuaRoot({ origins: [ORIGIN, "https://evil.example"] }),
      cuaRoot({ applications: [APP, "other-app"] }),
      cuaRoot({ origins: [] }),
      cuaRoot({ applications: [] })
    ]) {
      const f = governed({ cuaRootPayload: payload, extraToolClasses: [browserGrant()] });
      expect(verify(f)).toEqual({ ok: false, reason: "browser_scope_not_permitted" });
      expect(() => dispatchRoot(f, { lane: "cua" })).toThrow(/browser_scope_not_permitted/u);
      expect(attempts(f)).toBe(0);
    }
  });

  it("does not let a browser grant authorize a non-cua unit on the cua lane", () => {
    const f = governed({ extraToolClasses: [browserGrant()] });
    expect(verify(f)).toEqual({ ok: false, reason: "browser_scope_not_permitted" });
  });

  it("does not let a browser grant authorize jc, dc or the unmapped mcp lane", () => {
    const f = governed({ cuaRootPayload: cuaRoot(), toolClasses: [browserGrant()] });
    expect(verify(f, "jc")).toEqual({ ok: false, reason: "lane_not_permitted" });
    expect(verify(f, "dc")).toEqual({ ok: false, reason: "lane_not_permitted" });
    expect(verify(f, "mcp")).toEqual({ ok: false, reason: "lane_not_permitted" });
    expect(verify(f, "cua")).toMatchObject({ ok: true });
  });

  it("ignores a caller-supplied authority when deciding the browser scope", () => {
    const f = governed({
      cuaRootPayload: cuaRoot({ origins: ["https://evil.example"] }),
      extraToolClasses: [browserGrant()]
    });
    expect(() => dispatchRoot(f, { lane: "cua", authority: { grantId: "forged-grant" } })).toThrow(
      /browser_scope_not_permitted|dispatch_authority/u
    );
    expect(attempts(f)).toBe(0);
  });
});
