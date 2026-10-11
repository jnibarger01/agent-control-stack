import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autonomousAuthorityHash, type AutonomousAuthorityGrant } from "@agent-control-stack/work-items";
import { afterEach, describe, expect, it } from "vitest";
import type { AutonomousAuthorityDefinition } from "./authority.js";
import { DEFAULT_DELEGATION_BUDGET } from "./budget.js";
import { MissionAuthorityLedger, type ChildWorkItem, type GrantReader, type LedgerOptions } from "./child-work.js";
import { CodingMissionStore } from "./store.js";

const T0 = "2026-10-09T00:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

const ROOT: AutonomousAuthorityDefinition = {
  executingActorId: "actor:lead",
  scope: [
    { kind: "path", id: "/repo/acme/app", coverage: "descendants" },
    { kind: "path", id: "/repo/acme/docs", coverage: "descendants" }
  ],
  toolClasses: [
    { runtime: "desktop_commander", toolName: "read_file" },
    { runtime: "desktop_commander", toolName: "write_file" },
    { runtime: "sandbox", toolName: "code_edit" }
  ],
  maximumPrivileges: ["fs.read", "fs.write"],
  expiresAt: "2026-10-09T02:00:00.000Z",
  limits: { maxOperations: 500, maxRuntimeMs: 600_000, maxParallelOperations: 32, maxAttemptsPerOperation: 3 }
};
const LEAN = { maxOperations: 10, maxRuntimeMs: 600_000, maxParallelOperations: 1, maxAttemptsPerOperation: 3 };
const narrower = (overrides: Partial<AutonomousAuthorityDefinition> = {}): AutonomousAuthorityDefinition => ({
  ...ROOT,
  limits: LEAN,
  ...overrides
});

function makeGrant(missionId: string, grantId: string): AutonomousAuthorityGrant {
  const core = {
    schemaVersion: "acs.autonomous-authority.v1" as const,
    grantId,
    missionId,
    subjectInputHash: "a".repeat(64),
    issuedByActorId: "human-1",
    requestId: "req-1",
    definition: ROOT,
    reason: "approved by operator",
    createdAt: T0
  };
  return { ...core, grantHash: autonomousAuthorityHash(core), auditEventId: "evt-1" };
}

class FakeGrants implements GrantReader {
  readonly grants = new Map<string, AutonomousAuthorityGrant>();
  subject: string | undefined = "a".repeat(64);
  getAutonomousAuthority(grantId: string) {
    return this.grants.get(grantId);
  }
  currentSubjectInputHash() {
    return this.subject;
  }
}

const child = (unitId: string, overrides: Partial<ChildWorkItem> = {}): ChildWorkItem => ({
  unitId,
  workType: "research",
  purpose: `purpose of ${unitId}`,
  payload: { role: "researcher", prompt: "look into it" },
  requestedAuthority: narrower(),
  ...overrides
});

let tokens = 0;

/** mission m1 with root -> {c1, c2} and c1 -> g1, every parent holding a live claim when it delegates. */
function tree(dbPath = ":memory:") {
  const store = new CodingMissionStore(dbPath);
  const clock = { now: at(1000) };
  const grants = new FakeGrants();
  const options: LedgerOptions = {
    grants,
    verifyOperator: (id) => id === "operator-1",
    clock: () => clock.now,
    resolveActor: () => "actor:lead"
  };
  const ledger = new MissionAuthorityLedger(store, options);
  if (!store.get("m1")) {
    store.createGeneral({ missionId: "m1", summary: "s", budget: { ...DEFAULT_DELEGATION_BUDGET }, now: T0 });
    store.addWorkUnits(
      "m1",
      [{ unitId: "root", kind: "agent", title: "root", payload: { role: "lead", prompt: "p" } }],
      T0
    );
  }
  grants.grants.set("grant-1", makeGrant("m1", "grant-1"));
  ledger.grantMissionAuthority({ missionId: "m1", grantId: "grant-1" });
  const claimAndDelegate = (parent: string, children: ChildWorkItem[], ms: number) => {
    store.releaseReadyUnits("m1", at(ms));
    const token = `tok-${(tokens += 1)}`;
    expect(
      store.claimUnit("m1", parent, { token, workerId: `w-${parent}`, route: {}, claimedAt: at(ms) })
    ).toMatchObject({ ok: true });
    clock.now = at(ms);
    const result = ledger.requestChildWork({
      missionId: "m1",
      parentUnitId: parent,
      workerId: `w-${parent}`,
      claimToken: token,
      children
    });
    expect(result).toMatchObject({ ok: true });
  };
  claimAndDelegate("root", [child("c1"), child("c2")], 1000);
  claimAndDelegate("c1", [child("g1")], 2000);
  clock.now = at(3000);
  return { store, ledger, grants, clock, claimAndDelegate };
}

/** Test-only stand-in for the control plane recording an operator revocation of the backing grant. */
function revokeGrant(store: CodingMissionStore, grantId = "grant-1") {
  store.db.exec("PRAGMA foreign_keys = OFF");
  store.db.exec(
    "CREATE TABLE IF NOT EXISTS autonomous_authority_revocations (grant_id TEXT PRIMARY KEY, actor_id TEXT, reason TEXT, audit_event_id TEXT)"
  );
  store.db
    .prepare("INSERT INTO autonomous_authority_revocations VALUES (?, 'human-1', 'compromised', 'evt-9')")
    .run(grantId);
}

const dispatch = (ledger: MissionAuthorityLedger, unitId: string) =>
  ledger.verifyDispatch({ missionId: "m1", unitId, workerId: "any-worker", lane: "coder", attempt: 1 });

let directory: string | undefined;
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("authority graph: cycles", () => {
  it("fails closed, not with a stack overflow, when stored ancestry loops", () => {
    const { store, ledger } = tree();
    expect(dispatch(ledger, "g1")).toMatchObject({ ok: true });
    // An attacker with database write access removes the append-only guard and points c1 at its own child.
    store.db.exec("DROP TRIGGER work_unit_authority_no_update");
    store.db.exec("UPDATE work_unit_authority SET parent_unit_id = 'g1' WHERE unit_id = 'c1'");
    expect(() => ledger.unitAuthority("m1", "g1")).toThrowError(
      expect.objectContaining({ code: "authority_integrity" })
    );
    expect(dispatch(ledger, "g1")).toEqual({ ok: false, reason: "authority_integrity_failure" });
    expect(dispatch(ledger, "c1")).toEqual({ ok: false, reason: "authority_integrity_failure" });
  });

  it("fails closed when a unit names itself as its parent", () => {
    const { store, ledger } = tree();
    store.db.exec("DROP TRIGGER work_unit_authority_no_update");
    store.db.exec("UPDATE work_unit_authority SET parent_unit_id = 'c2' WHERE unit_id = 'c2'");
    expect(dispatch(ledger, "c2")).toEqual({ ok: false, reason: "authority_integrity_failure" });
  });
});

describe("authority graph: revocation propagation", () => {
  it("refuses every unit in the tree at dispatch once the backing grant is revoked, and refuses new delegation", () => {
    const { store, ledger, claimAndDelegate } = tree();
    for (const unit of ["root", "c1", "c2", "g1"]) expect(dispatch(ledger, unit)).toMatchObject({ ok: true });
    revokeGrant(store);
    for (const unit of ["root", "c1", "c2", "g1"]) {
      expect(dispatch(ledger, unit)).toEqual({ ok: false, reason: "grant_revoked" });
    }
    expect(() => claimAndDelegate("c2", [child("late")], 4000)).toThrow();
    expect(store.workUnits("m1").some((unit) => unit.unitId === "late")).toBe(false);
  });

  it("does not let a retry or a re-claim restore authority after revocation", () => {
    const { store, ledger } = tree();
    revokeGrant(store);
    store.releaseReadyUnits("m1", at(5000));
    expect(dispatch(ledger, "g1")).toEqual({ ok: false, reason: "grant_revoked" });
    expect(dispatch(ledger, "g1")).toEqual({ ok: false, reason: "grant_revoked" });
  });

  it("keeps a revocation in force across a process restart", () => {
    directory = mkdtempSync(join(tmpdir(), "acs-authority-graph-"));
    const dbPath = join(directory, "control.db");
    const first = tree(dbPath);
    revokeGrant(first.store);
    first.store.close();
    const reopened = new CodingMissionStore(dbPath);
    const grants = new FakeGrants();
    grants.grants.set("grant-1", makeGrant("m1", "grant-1"));
    const ledger = new MissionAuthorityLedger(reopened, {
      grants,
      verifyOperator: () => false,
      clock: () => at(3000),
      resolveActor: () => "actor:lead"
    });
    for (const unit of ["root", "c1", "c2", "g1"]) {
      expect(dispatch(ledger, unit)).toEqual({ ok: false, reason: "grant_revoked" });
    }
    reopened.close();
  });

  it("does not let revoking an unrelated grant affect the tree", () => {
    const { store, ledger } = tree();
    revokeGrant(store, "some-other-grant");
    expect(dispatch(ledger, "g1")).toMatchObject({ ok: true });
  });
});

describe("authority graph: read model", () => {
  it("shows the delegation tree, how each unit was narrowed, and the grant at the root", () => {
    const { ledger, claimAndDelegate } = tree();
    claimAndDelegate(
      "c2",
      [
        child("g2", {
          requestedAuthority: narrower({
            scope: [{ kind: "path", id: "/repo/acme/app", coverage: "descendants" }],
            toolClasses: [{ runtime: "desktop_commander", toolName: "read_file" }],
            maximumPrivileges: ["fs.read"]
          })
        })
      ],
      3500
    );
    const graph = ledger.authorityGraph("m1");
    expect(graph).toMatchObject({ schemaVersion: "acs.authority-graph.v1", missionId: "m1", integrity: "verified" });
    expect(graph.root).toMatchObject({ grantId: "grant-1", approverId: "human-1", state: "active", revocation: null });
    expect(graph.nodes.map((n) => n.unitId).sort()).toEqual(["c1", "c2", "g1", "g2", "root"]);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        { from: "mission", to: "root" },
        { from: "root", to: "c1" },
        { from: "root", to: "c2" },
        { from: "c1", to: "g1" },
        { from: "c2", to: "g2" }
      ])
    );
    const g2 = graph.nodes.find((n) => n.unitId === "g2")!;
    expect(g2).toMatchObject({ authoritySource: "derived", parentUnitId: "c2", grantId: "grant-1" });
    expect(g2.narrowing!.notInherited).toEqual({
      scope: ["path:/repo/acme/docs:descendants"],
      toolClasses: ["desktop_commander:write_file", "sandbox:code_edit"],
      privileges: ["fs.write"]
    });
    expect(g2.narrowing!.executingActorChanged).toBe(false);
    expect(graph.nodes.find((n) => n.unitId === "root")).toMatchObject({ authoritySource: "mission", narrowing: null });
    expect(graph.counts.active).toBe(5);
  });

  it("reports a revoked grant on every node with who revoked it, and keeps the history", () => {
    const { store, ledger } = tree();
    revokeGrant(store);
    const graph = ledger.authorityGraph("m1");
    expect(graph.root).toMatchObject({ state: "revoked", revocation: { actorId: "human-1", reason: "compromised" } });
    expect(graph.nodes.every((n) => n.effective.state === "revoked")).toBe(true);
    expect(graph.counts.revoked).toBe(4);
    expect(graph.integrity).toBe("verified");
    expect(graph.history.events.map((e) => e.name)).toEqual(
      expect.arrayContaining(["authority.granted", "child.requested"])
    );
  });

  it("never reports a node active that dispatch would refuse", () => {
    const scenarios: Array<{ name: string; arrange: (t: ReturnType<typeof tree>) => void }> = [
      { name: "fresh", arrange: () => undefined },
      { name: "revoked", arrange: (t) => revokeGrant(t.store) },
      { name: "expired", arrange: (t) => (t.clock.now = at(3 * 3600 * 1000)) },
      { name: "subject changed", arrange: (t) => (t.grants.subject = "b".repeat(64)) },
      { name: "subject unavailable", arrange: (t) => (t.grants.subject = undefined) },
      {
        name: "superseded",
        arrange: (t) =>
          t.store.db
            .prepare(
              "INSERT INTO work_unit_child_supersessions (mission_id, child_unit_id, parent_unit_id, reason, created_at) VALUES ('m1', 'c2', 'root', 'test', ?)"
            )
            .run(T0)
      }
    ];
    for (const scenario of scenarios) {
      const t = tree();
      scenario.arrange(t);
      const graph = t.ledger.authorityGraph("m1");
      for (const node of graph.nodes) {
        const verdict = dispatch(t.ledger, node.unitId);
        expect(node.effective.state === "active", `${scenario.name}: ${node.unitId}`).toBe(verdict.ok);
        // The lane view agrees with dispatch lane by lane: a unit never shows a lane that dispatch refuses.
        if (node.effective.state === "active") {
          for (const lane of ["coder", "jc", "dc", "mcp"] as const) {
            const byLane = t.ledger.verifyDispatch({
              missionId: "m1",
              unitId: node.unitId,
              workerId: "any-worker",
              lane,
              attempt: 1
            });
            expect(node.permittedLanes.includes(lane), `${scenario.name}: ${node.unitId} on ${lane}`).toBe(byLane.ok);
          }
        }
      }
    }
  });

  it("reports expiry by ACS's clock", () => {
    const t = tree();
    t.clock.now = at(3 * 3600 * 1000);
    const graph = t.ledger.authorityGraph("m1");
    expect(graph.root).toMatchObject({ state: "expired" });
    expect(graph.counts.expired).toBe(4);
  });

  it("marks a tampered unit and everything derived from it, without throwing", () => {
    const { store, ledger } = tree();
    store.db.exec("DROP TRIGGER work_unit_authority_no_update");
    store.db.exec(
      `UPDATE work_unit_authority SET envelope_json = replace(envelope_json, '/repo/acme/docs', '/etc') WHERE unit_id = 'c1'`
    );
    const graph = ledger.authorityGraph("m1");
    expect(graph.integrity).toBe("failed");
    expect(graph.nodes.find((n) => n.unitId === "c1")!.effective.state).toBe("integrity_failed");
    expect(graph.nodes.find((n) => n.unitId === "g1")!.effective.state).toBe("integrity_failed");
    expect(graph.nodes.find((n) => n.unitId === "c2")!.effective.state).toBe("active");
  });

  it("reports a stored ancestry loop as an integrity failure, not a crash", () => {
    const { store, ledger } = tree();
    store.db.exec("DROP TRIGGER work_unit_authority_no_update");
    store.db.exec("UPDATE work_unit_authority SET parent_unit_id = 'g1' WHERE unit_id = 'c1'");
    const graph = ledger.authorityGraph("m1");
    expect(graph.integrity).toBe("failed");
    expect(graph.nodes.find((n) => n.unitId === "g1")!.effective.state).toBe("integrity_failed");
  });

  it("reports an unbound mission as having no authority and a missing mission as not found", () => {
    const store = new CodingMissionStore(":memory:");
    store.createGeneral({ missionId: "m1", summary: "s", budget: { ...DEFAULT_DELEGATION_BUDGET }, now: T0 });
    store.addWorkUnits(
      "m1",
      [{ unitId: "root", kind: "agent", title: "root", payload: { role: "lead", prompt: "p" } }],
      T0
    );
    const ledger = new MissionAuthorityLedger(store, {
      grants: new FakeGrants(),
      verifyOperator: () => false,
      clock: () => at(1000)
    });
    const graph = ledger.authorityGraph("m1");
    expect(graph.root).toMatchObject({ state: "no_authority" });
    expect(graph.nodes[0]!.effective.state).toBe("no_authority");
    expect(() => ledger.authorityGraph("absent")).toThrowError(
      expect.objectContaining({ code: "coding_mission_not_found" })
    );
  });

  it("records a denied escalation in the history so the attempt stays visible", () => {
    const { ledger, store } = tree();
    store.releaseReadyUnits("m1", at(3600));
    const token = "tok-escalate";
    expect(store.claimUnit("m1", "c2", { token, workerId: "w-c2", route: {}, claimedAt: at(3600) })).toMatchObject({
      ok: true
    });
    const result = ledger.requestChildWork({
      missionId: "m1",
      parentUnitId: "c2",
      workerId: "w-c2",
      claimToken: token,
      children: [
        child("evil", { requestedAuthority: narrower({ maximumPrivileges: ["fs.read", "fs.write", "deploy"] }) })
      ]
    });
    expect(result).toMatchObject({ ok: false, outcome: "denied" });
    const graph = ledger.authorityGraph("m1");
    expect(graph.nodes.some((n) => n.unitId === "evil")).toBe(false);
    expect(graph.history.events.map((e) => e.name)).toContain("child.denied");
  });
});
