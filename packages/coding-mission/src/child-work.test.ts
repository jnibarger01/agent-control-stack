import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  SqliteWorkItemStore,
  executionPlanSubjectInputHash,
  type AutonomousAuthorityDefinition
} from "@agent-control-stack/work-items";
import { afterEach, describe, expect, it } from "vitest";
import type { ChildWorkRequest } from "./child-work.js";
import type { MissionBudget } from "./budget.js";
import { CodingMissionStore } from "./store.js";

const BASE = Date.now();
const at = (ms: number) => new Date(BASE + ms).toISOString();
const HOUR = 3_600_000;
const HUMAN = "human-issuer";
const ACTOR_A = "actor-a";
const ACTOR_B = "actor-b";

interface Fixture {
  root: string;
  dbPath: string;
  items: SqliteWorkItemStore;
  missions: CodingMissionStore;
  missionId: string;
  grantId: string;
  parentDefinition: AutonomousAuthorityDefinition;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function setup(options: { budget?: MissionBudget; bindRoot?: boolean; claimRoot?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "acs-child-work-"));
  const dbPath = join(root, "control.db");
  const items = new SqliteWorkItemStore(dbPath);
  const item = items.create({
    title: "child work mission",
    intent: "delegate bounded work",
    requester: "agent",
    requesterSubject: "planner",
    target: { cwd: root },
    risk: "low",
    requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: [root] } }]
  });
  const parentDefinition: AutonomousAuthorityDefinition = {
    executingActorId: ACTOR_A,
    scope: [{ kind: "path", id: root, coverage: "descendants" }],
    toolClasses: [
      { runtime: "desktop_commander", toolName: "write_file" },
      { runtime: "jace_commander", toolName: "git_commit" }
    ],
    maximumPrivileges: ["fs.read", "fs.write", "git.write"],
    expiresAt: at(HOUR),
    limits: { maxOperations: 50, maxRuntimeMs: 600_000, maxParallelOperations: 4, maxAttemptsPerOperation: 3 }
  };
  const grant = items.issueAutonomousAuthority(
    {
      missionId: item.id,
      issuedByActorId: HUMAN,
      requestId: "grant-1",
      expectedSubjectInputHash: executionPlanSubjectInputHash(item),
      definition: parentDefinition,
      reason: "bounded mission authority"
    },
    { via: "policy_gate", actorId: HUMAN }
  );
  const missions = new CodingMissionStore(dbPath);
  missions.createGeneral({
    missionId: item.id,
    summary: "mission",
    initiatorId: "user-1",
    ...(options.budget ? { budget: options.budget } : {}),
    now: at(0)
  });
  const added = missions.addWorkUnits(item.id, [{ unitId: "root", kind: "agent", title: "root" }], at(1));
  expect(added.ok).toBe(true);
  const fixture: Fixture = {
    root,
    dbPath,
    items,
    missions,
    missionId: item.id,
    grantId: grant.grantId,
    parentDefinition
  };
  if (options.bindRoot !== false) {
    const bound = missions.bindRootAuthority({
      missionId: item.id,
      unitId: "root",
      grantId: grant.grantId,
      boundByActorId: HUMAN,
      requestId: "bind-1",
      now: at(2)
    });
    expect(bound.ok).toBe(true);
    if (options.claimRoot !== false) claim(fixture, "root", ACTOR_A, "tok-root");
  }
  cleanups.push(() => {
    for (const close of [() => missions.close(), () => items.close()])
      try {
        close();
      } catch {
        // already closed by the test (restart scenario)
      }
    rmSync(root, { recursive: true, force: true });
  });
  return fixture;
}

function claim(f: Fixture, unitId: string, workerId: string, token: string, claimedAt = at(10)) {
  const result = f.missions.claimUnit(f.missionId, unitId, { token, workerId, route: { workerId }, claimedAt });
  expect(result, `claim ${unitId}`).toMatchObject({ ok: true });
  return result;
}

/** A child definition that is a strict narrowing of the fixture's parent unless overridden. */
function narrow(f: Fixture, overrides: Partial<AutonomousAuthorityDefinition> = {}): AutonomousAuthorityDefinition {
  return {
    executingActorId: ACTOR_A,
    scope: [{ kind: "path", id: join(f.root, "src"), coverage: "descendants" }],
    toolClasses: [{ runtime: "desktop_commander", toolName: "write_file" }],
    maximumPrivileges: ["fs.read", "fs.write"],
    expiresAt: at(HOUR - 600_000),
    limits: { maxOperations: 10, maxRuntimeMs: 300_000, maxParallelOperations: 2, maxAttemptsPerOperation: 2 },
    ...overrides
  };
}

function ask(f: Fixture, overrides: Partial<ChildWorkRequest> = {}): ChildWorkRequest {
  return {
    missionId: f.missionId,
    parentUnitId: "root",
    requestId: "req-1",
    unitId: "child-1",
    title: "investigate",
    purpose: "look at the failing test",
    workType: "research",
    claim: { token: "tok-root", workerId: ACTOR_A, attempt: 1 },
    requestedAuthority: narrow(f),
    now: at(100),
    ...overrides
  };
}

const rowsOf = (f: Fixture, sql: string, ...params: Array<string | number>) => {
  const db = new DatabaseSync(f.dbPath);
  try {
    return db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
};

describe("bindRootAuthority: the only way a root exists", () => {
  it("binds an unclaimed top-level unit to a live human-issued grant", () => {
    const f = setup({ claimRoot: false });
    const rows = rowsOf(
      f,
      "SELECT kind, root_grant_id, bound_by_actor_id, executing_actor_id FROM work_unit_authority"
    );
    expect(rows).toEqual([
      { kind: "root", root_grant_id: f.grantId, bound_by_actor_id: HUMAN, executing_actor_id: ACTOR_A }
    ]);
    expect(f.missions.events(f.missionId).map((e) => e.name)).toContain("authority.granted");
  });

  it("refuses self-binding, a second bind, an unknown unit and an unknown grant", () => {
    const f = setup({ claimRoot: false });
    f.missions.addWorkUnits(f.missionId, [{ unitId: "u2", kind: "agent", title: "second" }], at(3));
    const bind = (over: Partial<Parameters<CodingMissionStore["bindRootAuthority"]>[0]>) =>
      f.missions.bindRootAuthority({
        missionId: f.missionId,
        unitId: "u2",
        grantId: f.grantId,
        boundByActorId: HUMAN,
        requestId: "bind-x",
        now: at(4),
        ...over
      });
    expect(bind({ boundByActorId: ACTOR_A })).toMatchObject({ ok: false, outcome: "self_bind" });
    expect(bind({ unitId: "root" })).toMatchObject({ ok: false, outcome: "root_authority_exists" });
    expect(bind({ unitId: "missing" })).toMatchObject({ ok: false, outcome: "unit_not_bindable" });
    expect(bind({ grantId: "no-such-grant" })).toMatchObject({ ok: false, outcome: "grant_invalid" });
  });

  it("never binds authority retroactively to a unit that was already claimed", () => {
    const f = setup({ bindRoot: false });
    claim(f, "root", ACTOR_A, "tok-root");
    expect(
      f.missions.bindRootAuthority({
        missionId: f.missionId,
        unitId: "root",
        grantId: f.grantId,
        boundByActorId: HUMAN,
        requestId: "bind-late",
        now: at(20)
      })
    ).toMatchObject({ ok: false, outcome: "unit_not_bindable" });
  });

  it("refuses a revoked grant and an expired grant", () => {
    const f = setup({ claimRoot: false });
    f.missions.addWorkUnits(f.missionId, [{ unitId: "u2", kind: "agent", title: "second" }], at(3));
    const bind = (now: string) =>
      f.missions.bindRootAuthority({
        missionId: f.missionId,
        unitId: "u2",
        grantId: f.grantId,
        boundByActorId: HUMAN,
        requestId: "bind-y",
        now
      });
    expect(bind(at(2 * HOUR))).toMatchObject({ ok: false, outcome: "authority_expired" });
    f.items.revokeAutonomousAuthority(f.grantId, HUMAN, "no longer wanted", { via: "policy_gate", actorId: HUMAN });
    expect(bind(at(4))).toMatchObject({ ok: false, outcome: "grant_revoked" });
  });

  it("is append-only and the database refuses a root row on a child unit", () => {
    const f = setup();
    const db = new DatabaseSync(f.dbPath);
    db.exec("PRAGMA foreign_keys = ON");
    try {
      expect(() => db.exec("UPDATE work_unit_authority SET executing_actor_id = 'x'")).toThrow(/immutable/);
      expect(() => db.exec("DELETE FROM work_unit_authority")).toThrow(/immutable/);
      f.missions.requestChildWork(ask(f));
      expect(() =>
        db
          .prepare(
            `INSERT INTO work_unit_authority (authority_id, mission_id, unit_id, kind, root_grant_id, definition_json,
               definition_hash, executing_actor_id, expires_at, request_id, request_hash, bound_by_actor_id, created_at)
             VALUES ('forged', ?, 'child-1', 'root', ?, '{}', ?, ?, ?, 'forged-req', ?, 'someone', ?)`
          )
          .run(f.missionId, f.grantId, "a".repeat(64), ACTOR_A, at(HOUR), "b".repeat(64), at(5))
      ).toThrow();
    } finally {
      db.close();
    }
  });
});

describe("requestChildWork: admission", () => {
  it("creates the child unit and an immutable authority row chained to the parent and root grant", () => {
    const f = setup();
    const result = f.missions.requestChildWork(ask(f));
    expect(result).toMatchObject({ ok: true, unitId: "child-1", replay: false });
    const unit = f.missions.workUnits(f.missionId).find((u) => u.unitId === "child-1")!;
    expect(unit).toMatchObject({ parentUnitId: "root", depth: 1, kind: "agent" });
    const parent = f.missions.workUnitAuthority(f.missionId, "root")!;
    const child = f.missions.workUnitAuthority(f.missionId, "child-1")!;
    expect(child).toMatchObject({
      kind: "child",
      parentAuthorityId: parent.authorityId,
      rootGrantId: f.grantId,
      executingActorId: ACTOR_A,
      requestedByUnitId: "root",
      requestedByWorkerId: ACTOR_A,
      requestedByAttempt: 1
    });
    expect(child.definition.maximumPrivileges).toEqual(["fs.read", "fs.write"]);
    const events = f.missions.events(f.missionId).map((e) => e.name);
    expect(events).toEqual(expect.arrayContaining(["child.requested", "child.admitted"]));
  });

  it("never persists the raw claim token: only its hash", () => {
    const f = setup();
    f.missions.requestChildWork(ask(f));
    const [row] = rowsOf(f, "SELECT * FROM work_unit_authority WHERE unit_id = 'child-1'");
    expect(row!.requested_claim_hash).toBe(createHash("sha256").update("tok-root").digest("hex"));
    const everything = JSON.stringify([
      rowsOf(f, "SELECT * FROM work_unit_authority"),
      rowsOf(f, "SELECT body_json FROM coding_events")
    ]);
    expect(everything).not.toContain("tok-root");
  });

  it("replays an identical retry and refuses a changed request under the same id", () => {
    const f = setup();
    const first = f.missions.requestChildWork(ask(f));
    const again = f.missions.requestChildWork(ask(f, { now: at(200) }));
    expect(again).toMatchObject({ ok: true, replay: true });
    expect(again.ok && first.ok && again.authorityId === first.authorityId).toBe(true);
    expect(f.missions.requestChildWork(ask(f, { purpose: "something else" }))).toMatchObject({
      ok: false,
      outcome: "request_conflict"
    });
    expect(f.missions.workUnits(f.missionId).filter((u) => u.parentUnitId === "root")).toHaveLength(1);
    expect(f.missions.requestChildWork(ask(f, { requestId: "req-2" }))).toMatchObject({
      ok: false,
      outcome: "unit_conflict"
    });
  });

  it("refuses invalid structure without writing anything", () => {
    const f = setup();
    for (const bad of [
      { unitId: "root" },
      { unitId: "has space" },
      { purpose: "" },
      { workType: "deploy" as never },
      { claim: { token: "", workerId: ACTOR_A, attempt: 1 } }
    ])
      expect(f.missions.requestChildWork(ask(f, bad))).toMatchObject({ ok: false, outcome: "invalid_request" });
    expect(rowsOf(f, "SELECT 1 FROM work_unit_authority WHERE kind = 'child'")).toHaveLength(0);
  });
});

describe("requestChildWork: authority escalation fails closed", () => {
  const cases: Array<[string, (f: Fixture) => AutonomousAuthorityDefinition]> = [
    [
      "a tool the parent lacks (privileged_exec)",
      (f) => narrow(f, { toolClasses: [{ runtime: "jace_commander", toolName: "privileged_exec" }] })
    ],
    ["a privilege the parent lacks", (f) => narrow(f, { maximumPrivileges: ["fs.read", "deploy"] })],
    [
      "a path outside the parent scope",
      (f) => narrow(f, { scope: [{ kind: "path", id: "/etc", coverage: "descendants" }] })
    ],
    ["a longer life than the parent", (f) => narrow(f, { expiresAt: at(HOUR + 1) })],
    [
      "higher limits than the parent",
      (f) =>
        narrow(f, {
          limits: { maxOperations: 51, maxRuntimeMs: 1, maxParallelOperations: 1, maxAttemptsPerOperation: 1 }
        })
    ]
  ];
  for (const [name, build] of cases) {
    it(`denies ${name} and writes no unit`, () => {
      const f = setup();
      const result = f.missions.requestChildWork(ask(f, { requestedAuthority: build(f) }));
      expect(result).toMatchObject({ ok: false, outcome: "authority_escalation" });
      expect(f.missions.workUnits(f.missionId).map((u) => u.unitId)).toEqual(["root"]);
      expect(rowsOf(f, "SELECT 1 FROM work_unit_authority WHERE kind = 'child'")).toHaveLength(0);
      const denied = f.missions.events(f.missionId).filter((e) => e.name === "child.denied");
      expect(denied).toHaveLength(1);
      expect(denied[0]!.body).toMatchObject({ reason: "authority_escalation" });
    });
  }

  it("a request cannot create a root: the parent must already hold persisted authority", () => {
    const f = setup({ bindRoot: false });
    // Not governed, root unclaimed-and-unbound: claim it directly (legacy path) and ask for children.
    claim(f, "root", ACTOR_A, "tok-root");
    expect(f.missions.requestChildWork(ask(f))).toMatchObject({ ok: false, outcome: "authority_missing" });
    expect(rowsOf(f, "SELECT 1 FROM work_unit_authority")).toHaveLength(0);
  });
});

describe("requestChildWork: claim and fence", () => {
  it("denies a wrong token, a wrong worker, and a stale attempt", () => {
    const f = setup();
    expect(
      f.missions.requestChildWork(ask(f, { claim: { token: "nope", workerId: ACTOR_A, attempt: 1 } }))
    ).toMatchObject({
      ok: false,
      outcome: "stale_claim"
    });
    expect(
      f.missions.requestChildWork(ask(f, { claim: { token: "tok-root", workerId: ACTOR_B, attempt: 1 } }))
    ).toMatchObject({
      ok: false,
      outcome: "stale_claim"
    });
    expect(
      f.missions.requestChildWork(ask(f, { claim: { token: "tok-root", workerId: ACTOR_A, attempt: 2 } }))
    ).toMatchObject({
      ok: false,
      outcome: "stale_fence"
    });
  });

  it("denies a parent that lost its claim (failed, reset, cancelled) and a terminal mission", () => {
    const f = setup();
    f.missions.failUnit(f.missionId, "root", "tok-root", { category: "timeout", retryable: false, now: at(20) });
    expect(f.missions.requestChildWork(ask(f))).toMatchObject({ ok: false, outcome: "stale_claim" });
    const g = setup();
    g.missions.cancelMission(g.missionId, { reason: "operator stop", now: at(30) });
    expect(g.missions.requestChildWork(ask(g))).toMatchObject({ ok: false, outcome: "mission_not_active" });
  });

  it("denies a reclaimed parent presenting the previous attempt's fence", () => {
    const f = setup();
    f.missions.resetClaim(f.missionId, "root");
    claim(f, "root", ACTOR_A, "tok-root-2");
    expect(f.missions.requestChildWork(ask(f))).toMatchObject({ ok: false, outcome: "stale_claim" });
    expect(
      f.missions.requestChildWork(ask(f, { claim: { token: "tok-root-2", workerId: ACTOR_A, attempt: 1 } }))
    ).toMatchObject({ ok: true });
  });
});

describe("requestChildWork: grants and expiry", () => {
  it("denies once the root grant is revoked, with nothing written", () => {
    const f = setup();
    f.items.revokeAutonomousAuthority(f.grantId, HUMAN, "stop", { via: "policy_gate", actorId: HUMAN });
    expect(f.missions.requestChildWork(ask(f))).toMatchObject({ ok: false, outcome: "grant_revoked" });
    expect(f.missions.workUnits(f.missionId)).toHaveLength(1);
  });

  it("denies after the parent authority expires", () => {
    const f = setup();
    expect(f.missions.requestChildWork(ask(f, { now: at(HOUR + 1) }))).toMatchObject({
      ok: false,
      outcome: "authority_expired"
    });
  });

  it("denies a tampered authority row instead of trusting it", () => {
    const f = setup();
    const db = new DatabaseSync(f.dbPath);
    try {
      db.exec("DROP TRIGGER work_unit_authority_no_update");
      db.exec(
        `UPDATE work_unit_authority SET definition_json = replace(definition_json, '"git.write"', '"deploy"') WHERE kind = 'root'`
      );
    } finally {
      db.close();
    }
    expect(f.missions.requestChildWork(ask(f))).toMatchObject({ ok: false, outcome: "authority_integrity" });
  });

  it("the database refuses a child that outlives its parent even if the application check were bypassed", () => {
    const f = setup();
    const db = new DatabaseSync(f.dbPath);
    db.exec("PRAGMA foreign_keys = ON");
    try {
      db.exec(
        `INSERT INTO coding_operations (mission_id, operation_id, depends_on, title, status, files_json, unit_kind, parent_unit_id, depth)
         VALUES ('${f.missionId}', 'raw-child', '[]', 'raw', 'pending', '[]', 'agent', 'root', 1)`
      );
      const [parent] = rowsOf(f, "SELECT authority_id FROM work_unit_authority WHERE unit_id = 'root'");
      expect(() =>
        db
          .prepare(
            `INSERT INTO work_unit_authority (authority_id, mission_id, unit_id, kind, parent_authority_id, root_grant_id,
               definition_json, definition_hash, executing_actor_id, expires_at, request_id, request_hash, requested_by_unit_id,
               requested_by_worker_id, requested_by_attempt, requested_claim_hash, created_at)
             VALUES ('raw-auth', ?, 'raw-child', 'child', ?, ?, '{}', ?, ?, ?, 'raw-req', ?, 'root', ?, 1, ?, ?)`
          )
          .run(
            f.missionId,
            parent!.authority_id as string,
            f.grantId,
            "a".repeat(64),
            ACTOR_A,
            at(2 * HOUR),
            "b".repeat(64),
            ACTOR_A,
            "c".repeat(64),
            at(5)
          )
      ).toThrow(/outlive/);
    } finally {
      db.close();
    }
  });
});

describe("cross-actor execution requires an explicit, verified assignment", () => {
  const forB = (f: Fixture, over: Partial<AutonomousAuthorityDefinition> = {}) =>
    narrow(f, { executingActorId: ACTOR_B, ...over });

  it("is refused without an assignment and with a mismatched one", () => {
    const f = setup();
    expect(f.missions.requestChildWork(ask(f, { requestedAuthority: forB(f) }))).toMatchObject({
      ok: false,
      outcome: "assignment_required"
    });
    expect(
      f.missions.requestChildWork(ask(f, { requestedAuthority: forB(f), assignedActorId: "actor-c" }))
    ).toMatchObject({ ok: false, outcome: "assignment_required" });
    expect(f.missions.requestChildWork(ask(f, { assignedActorId: ACTOR_B }))).toMatchObject({
      ok: false,
      outcome: "assignment_required"
    });
  });

  it("lets only the assigned actor claim, and never the requester or a stranger", () => {
    const f = setup();
    expect(
      f.missions.requestChildWork(ask(f, { requestedAuthority: forB(f), assignedActorId: ACTOR_B }))
    ).toMatchObject({ ok: true });
    for (const who of [ACTOR_A, "actor-c"])
      expect(
        f.missions.claimUnit(f.missionId, "child-1", {
          token: `t-${who}`,
          workerId: who,
          route: {},
          claimedAt: at(300)
        })
      ).toMatchObject({ ok: false, outcome: "authority_denied", reason: "actor_mismatch" });
    claim(f, "child-1", ACTOR_B, "tok-b", at(300));
  });

  it("claim fails closed once the root grant is revoked or the child's authority expires", () => {
    const revoked = setup();
    revoked.missions.requestChildWork(ask(revoked, { requestedAuthority: forB(revoked), assignedActorId: ACTOR_B }));
    revoked.items.revokeAutonomousAuthority(revoked.grantId, HUMAN, "stop", { via: "policy_gate", actorId: HUMAN });
    expect(
      revoked.missions.claimUnit(revoked.missionId, "child-1", {
        token: "t",
        workerId: ACTOR_B,
        route: {},
        claimedAt: at(300)
      })
    ).toMatchObject({ ok: false, outcome: "authority_denied", reason: "grant_revoked" });

    const expired = setup();
    expired.missions.requestChildWork(ask(expired, { requestedAuthority: forB(expired), assignedActorId: ACTOR_B }));
    expect(
      expired.missions.claimUnit(expired.missionId, "child-1", {
        token: "t",
        workerId: ACTOR_B,
        route: {},
        claimedAt: at(HOUR)
      })
    ).toMatchObject({ ok: false, outcome: "authority_denied", reason: "authority_expired" });
  });

  it("the executing actor gets the child's persisted authority, never the parent's", () => {
    const f = setup();
    f.missions.requestChildWork(ask(f, { requestedAuthority: forB(f), assignedActorId: ACTOR_B }));
    claim(f, "child-1", ACTOR_B, "tok-b", at(300));
    // Within the PARENT's authority (git.write) but beyond the child's persisted authority (fs.read, fs.write only).
    const grandchild = f.missions.requestChildWork({
      ...ask(f),
      parentUnitId: "child-1",
      requestId: "req-gc",
      unitId: "grandchild-1",
      claim: { token: "tok-b", workerId: ACTOR_B, attempt: 1 },
      requestedAuthority: forB(f, { maximumPrivileges: ["fs.read", "git.write"] }),
      assignedActorId: undefined,
      now: at(400)
    });
    expect(grandchild).toMatchObject({ ok: false, outcome: "authority_escalation" });
    // And the requester of a cross-actor child cannot use its own claim to act as the child's parent.
    expect(
      f.missions.requestChildWork({
        ...ask(f),
        parentUnitId: "child-1",
        requestId: "req-gc2",
        unitId: "grandchild-2",
        claim: { token: "tok-b", workerId: ACTOR_A, attempt: 1 },
        now: at(401)
      })
    ).toMatchObject({ ok: false, outcome: "stale_claim" });
  });
});

describe("caps are durable and enforced transactionally", () => {
  /** Request `n` children, each claimable by actor A. Returns the results. */
  const spawnChildren = (f: Fixture, n: number, from = 1) =>
    Array.from({ length: n }, (_, i) =>
      f.missions.requestChildWork(
        ask(f, { requestId: `req-${from + i}`, unitId: `child-${from + i}`, now: at(100 + i) })
      )
    );

  it("caps parallel children (fallback cap 4) and frees a slot when one finishes", () => {
    const f = setup();
    const results = spawnChildren(f, 4);
    expect(results.every((r) => r.ok)).toBe(true);
    const fifth = spawnChildren(f, 1, 5)[0]!;
    expect(fifth).toMatchObject({ ok: false, outcome: "budget_exhausted" });
    expect(fifth.ok === false && "decision" in fifth && fifth.decision.exhausted.map((e) => e.metric)).toEqual([
      "parallel_work_units"
    ]);
    claim(f, "child-1", ACTOR_A, "tok-c1", at(200));
    f.missions.completeOperation(f.missionId, "child-1", "tok-c1", { resultHash: "h", files: [] }, at(210));
    expect(spawnChildren(f, 1, 5)[0]).toMatchObject({ ok: true });
  });

  it("caps total children (fallback cap 8) even when parallel slots are free", () => {
    const f = setup();
    for (let i = 1; i <= 8; i += 1) {
      expect(spawnChildren(f, 1, i)[0]).toMatchObject({ ok: true });
      claim(f, `child-${i}`, ACTOR_A, `tok-c${i}`, at(200 + i));
      f.missions.completeOperation(f.missionId, `child-${i}`, `tok-c${i}`, { resultHash: "h", files: [] }, at(300 + i));
    }
    const ninth = spawnChildren(f, 1, 9)[0]!;
    expect(ninth).toMatchObject({ ok: false, outcome: "budget_exhausted" });
    expect(ninth.ok === false && "decision" in ninth && ninth.decision.exhausted[0]?.metric).toBe("child_work_units");
  });

  it("caps delegation depth (fallback depth 2)", () => {
    const f = setup();
    let parent = "root";
    let token = "tok-root";
    for (let depth = 1; depth <= 2; depth += 1) {
      const id = `d${depth}`;
      expect(
        f.missions.requestChildWork(
          ask(f, {
            parentUnitId: parent,
            requestId: `req-${id}`,
            unitId: id,
            claim: { token, workerId: ACTOR_A, attempt: 1 },
            now: at(100 + depth)
          })
        )
      ).toMatchObject({ ok: true });
      token = `tok-${id}`;
      claim(f, id, ACTOR_A, token, at(200 + depth));
      parent = id;
    }
    const tooDeep = f.missions.requestChildWork(
      ask(f, {
        parentUnitId: parent,
        requestId: "req-d3",
        unitId: "d3",
        claim: { token, workerId: ACTOR_A, attempt: 1 },
        now: at(400)
      })
    );
    expect(tooDeep).toMatchObject({ ok: false, outcome: "budget_exhausted" });
    expect(tooDeep.ok === false && "decision" in tooDeep && tooDeep.decision.exhausted[0]?.metric).toBe("child_depth");
  });

  it("honours an explicit mission budget over the fallbacks", () => {
    const f = setup({ budget: { maxParallelWorkUnits: 2, maxChildWorkUnits: 3, maxChildDepth: 1 } });
    expect(spawnChildren(f, 2).every((r) => r.ok)).toBe(true);
    expect(spawnChildren(f, 1, 3)[0]).toMatchObject({ ok: false, outcome: "budget_exhausted" });
  });

  it("survives a restart: caps, replay and authority all come from durable rows", () => {
    const f = setup();
    expect(spawnChildren(f, 4).every((r) => r.ok)).toBe(true);
    f.missions.close();
    const reopened = new CodingMissionStore(f.dbPath);
    cleanups.push(() => reopened.close());
    const fifth = reopened.requestChildWork(ask(f, { requestId: "req-5", unitId: "child-5", now: at(500) }));
    expect(fifth).toMatchObject({ ok: false, outcome: "budget_exhausted" });
    expect(reopened.requestChildWork(ask(f, { requestId: "req-1", unitId: "child-1", now: at(501) }))).toMatchObject({
      ok: true,
      replay: true
    });
    expect(reopened.verifyUnitAuthority(f.missionId, "child-2", ACTOR_A, at(502))).toMatchObject({ ok: true });
    expect(
      reopened.claimUnit(f.missionId, "child-2", { token: "t2", workerId: ACTOR_A, route: {}, claimedAt: at(503) })
    ).toMatchObject({
      ok: true
    });
  });
});

describe("governed missions only accept children through requestChildWork", () => {
  it("refuses a direct addWorkUnits child in a governed mission but keeps legacy missions working", () => {
    const f = setup();
    expect(() =>
      f.missions.addWorkUnits(
        f.missionId,
        [{ unitId: "sneaky", kind: "agent", title: "x", parentUnitId: "root" }],
        at(50)
      )
    ).toThrow(/requestChildWork/);

    const legacy = new CodingMissionStore(":memory:");
    legacy.createGeneral({ missionId: "legacy", summary: "s", initiatorId: "u", now: at(0) });
    legacy.addWorkUnits("legacy", [{ unitId: "p", kind: "agent", title: "p" }], at(1));
    expect(
      legacy.addWorkUnits("legacy", [{ unitId: "c", kind: "agent", title: "c", parentUnitId: "p" }], at(2))
    ).toMatchObject({ ok: true });
    expect(
      legacy.claimUnit("legacy", "c", { token: "t", workerId: "anyone", route: {}, claimedAt: at(3) })
    ).toMatchObject({
      ok: true
    });
    legacy.close();
  });

  it("refuses to claim a unit with no persisted authority in a governed mission", () => {
    const f = setup();
    const db = new DatabaseSync(f.dbPath);
    try {
      db.exec(
        `INSERT INTO coding_operations (mission_id, operation_id, depends_on, title, status, files_json, unit_kind, parent_unit_id, depth)
         VALUES ('${f.missionId}', 'orphan', '[]', 'orphan', 'pending', '[]', 'agent', 'root', 1)`
      );
    } finally {
      db.close();
    }
    expect(
      f.missions.claimUnit(f.missionId, "orphan", { token: "t", workerId: ACTOR_A, route: {}, claimedAt: at(60) })
    ).toMatchObject({ ok: false, outcome: "authority_denied", reason: "authority_missing" });
  });
});

describe("admin mode never participates in child authority", () => {
  it("child-work source and the authority methods do not reference execution or admin mode", () => {
    const here = new URL(".", import.meta.url);
    const childWork = readFileSync(new URL("child-work.ts", here), "utf8");
    const store = readFileSync(new URL("store.ts", here), "utf8");
    const start = store.indexOf("Work-unit authority (migration 060)");
    const end = store.indexOf("private event(missionId");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const text of [childWork, store.slice(start, end)])
      expect(code(text)).not.toMatch(/execution[-_ ]?mode|admin/i);
  });
});

describe("concurrency", () => {
  it("a second connection cannot interleave with an open write transaction (serialized by BEGIN IMMEDIATE)", () => {
    const f = setup();
    const other = new CodingMissionStore(f.dbPath);
    cleanups.push(() => other.close());
    other.db.exec("PRAGMA busy_timeout = 0");
    f.missions.db.exec("BEGIN IMMEDIATE");
    try {
      expect(() => other.requestChildWork(ask(f))).toThrow(/locked|busy/i);
    } finally {
      f.missions.db.exec("ROLLBACK");
    }
    expect(other.requestChildWork(ask(f))).toMatchObject({ ok: true });
  });

  /** Spawn real OS processes against the same database file, release them together, and collect their results. */
  async function race(f: Fixture, requests: ChildWorkRequest[]): Promise<Array<Record<string, unknown>>> {
    const worker = new URL("child-work-race-worker.ts", import.meta.url).pathname;
    const children = requests.map((request) => {
      const child = spawn(process.execPath, ["--import", "tsx", worker, f.dbPath, JSON.stringify(request)], {
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      const ready = new Promise<void>((resolve, reject) => {
        const poll = setInterval(() => {
          if (stdout.includes("ready\n")) {
            clearInterval(poll);
            resolve();
          }
        }, 10);
        child.once("error", reject);
        child.once("exit", (code) => {
          if (!stdout.includes("ready\n")) {
            clearInterval(poll);
            reject(new Error(`worker exited ${code} before ready: ${stderr.slice(0, 500)}`));
          }
        });
      });
      const done = new Promise<Record<string, unknown>>((resolve, reject) => {
        child.once("exit", () => {
          const line = stdout
            .split("\n")
            .filter((l) => l.startsWith("{"))
            .pop();
          if (line) resolve(JSON.parse(line));
          else reject(new Error(`no result: ${stderr.slice(0, 500)}`));
        });
      });
      return { child, ready, done };
    });
    await Promise.all(children.map((c) => c.ready));
    for (const { child } of children) child.stdin.write("go\n");
    return Promise.all(children.map((c) => c.done));
  }

  it("distinct requests racing for the last slots: exactly the cap is admitted, across processes", async () => {
    const f = setup({ budget: { maxParallelWorkUnits: 3, maxChildWorkUnits: 8, maxChildDepth: 2 } });
    const results = await race(
      f,
      Array.from({ length: 6 }, (_, i) =>
        ask(f, { requestId: `race-${i}`, unitId: `race-child-${i}`, now: at(100 + i) })
      )
    );
    expect(results.filter((r) => r.ok === true)).toHaveLength(3);
    expect(results.filter((r) => r.outcome === "budget_exhausted")).toHaveLength(3);
    expect(results.filter((r) => "threw" in r)).toHaveLength(0);
    const verify = new CodingMissionStore(f.dbPath);
    cleanups.push(() => verify.close());
    expect(verify.workUnits(f.missionId).filter((u) => u.parentUnitId === "root")).toHaveLength(3);
    expect(rowsOf(f, "SELECT 1 FROM work_unit_authority WHERE kind = 'child'")).toHaveLength(3);
  }, 60_000);

  it("the same request racing with itself admits once and replays the rest", async () => {
    const f = setup();
    const results = await race(
      f,
      Array.from({ length: 4 }, () => ask(f))
    );
    expect(results.filter((r) => r.ok === true && r.replay === false)).toHaveLength(1);
    expect(results.filter((r) => r.ok === true && r.replay === true)).toHaveLength(3);
    expect(rowsOf(f, "SELECT 1 FROM work_unit_authority WHERE kind = 'child'")).toHaveLength(1);
  }, 60_000);
});
