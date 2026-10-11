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
    { runtime: "desktop_commander", toolName: "write_file" }
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
