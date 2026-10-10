import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteWorkItemStore, executionPlanSubjectInputHash } from "@agent-control-stack/work-items";
import { afterEach, describe, expect, it } from "vitest";
import type { AutonomousAuthorityDefinition } from "./authority.js";
import { DEFAULT_DELEGATION_BUDGET } from "./budget.js";
import { MissionAuthorityLedger, type ChildWorkItem, type GrantReader } from "./child-work.js";
import { CodingMissionStore } from "./store.js";

/**
 * child-work.test.ts drives the ledger with an in-memory FakeGrants, which never throws, never touches the audit chain
 * and cannot be revoked the way production does it. These tests wire the ledger to the real SqliteWorkItemStore grant
 * path (human-issued grant, canonical hash, audit event, audit-backed revocation) to check what a deployment relies on.
 */
const HUMAN = "human-issuer";
const ACTOR = "actor:lead";
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function realGrantReader(items: SqliteWorkItemStore): GrantReader {
  return {
    getAutonomousAuthority: (grantId) => items.getAutonomousAuthority(grantId),
    currentSubjectInputHash: (missionId) => {
      const item = items.get(missionId);
      return item ? executionPlanSubjectInputHash(item) : undefined;
    }
  };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "acs-real-grants-"));
  const dbPath = join(root, "control.db");
  const items = new SqliteWorkItemStore(dbPath);
  const item = items.create({
    title: "real grant mission",
    intent: "delegate bounded work",
    requester: "agent",
    requesterSubject: "planner",
    target: { cwd: root },
    risk: "low",
    requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: [root] } }]
  });
  const base = Date.now();
  const iso = (ms: number) => new Date(base + ms).toISOString();
  const definition: AutonomousAuthorityDefinition = {
    executingActorId: ACTOR,
    scope: [{ kind: "path", id: root, coverage: "descendants" }],
    toolClasses: [{ runtime: "desktop_commander", toolName: "read_file" }],
    maximumPrivileges: ["fs.read", "fs.write"],
    expiresAt: iso(3_600_000),
    limits: { maxOperations: 50, maxRuntimeMs: 600_000, maxParallelOperations: 4, maxAttemptsPerOperation: 3 }
  };
  const grant = items.issueAutonomousAuthority(
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
  const missions = new CodingMissionStore(dbPath);
  missions.createGeneral({
    missionId: item.id,
    summary: "mission",
    budget: { ...DEFAULT_DELEGATION_BUDGET },
    now: iso(0)
  });
  missions.addWorkUnits(
    item.id,
    [{ unitId: "root", kind: "agent", title: "root", payload: { role: "lead", prompt: "p" } }],
    iso(0)
  );
  const state = { now: iso(1_000) };
  const ledger = new MissionAuthorityLedger(missions, {
    grants: realGrantReader(items),
    verifyOperator: () => false,
    clock: () => state.now,
    resolveActor: () => ACTOR
  });
  const claim = { token: "tok-real-grants", workerId: "lead-worker", route: {}, claimedAt: iso(500) };
  cleanups.push(() => {
    for (const close of [() => missions.close(), () => items.close()])
      try {
        close();
      } catch {
        // already closed
      }
    rmSync(root, { recursive: true, force: true });
  });
  const child = (unitId: string): ChildWorkItem => ({
    unitId,
    workType: "research",
    purpose: `purpose of ${unitId}`,
    payload: { role: "researcher", prompt: "look into it" },
    requestedAuthority: {
      ...definition,
      maximumPrivileges: ["fs.read"],
      limits: { maxOperations: 2, maxRuntimeMs: 60_000, maxParallelOperations: 1, maxAttemptsPerOperation: 1 }
    }
  });
  const ask = (unitId: string) =>
    ledger.requestChildWork({
      missionId: item.id,
      parentUnitId: "root",
      workerId: claim.workerId,
      claimToken: claim.token,
      children: [child(unitId)]
    });
  return { root, dbPath, items, item, grant, missions, ledger, claim, state, iso, ask };
}

const eventNames = (f: ReturnType<typeof setup>) => f.missions.events(f.item.id).map((e) => e.name);

describe("child work against the real grant store", () => {
  it("binds a human-issued grant, admits narrowed child work, and leaves the audit chain intact", () => {
    const f = setup();
    const bound = f.ledger.grantMissionAuthority({ missionId: f.item.id, grantId: f.grant.grantId });
    expect(bound).toMatchObject({ grantId: f.grant.grantId, approverId: HUMAN });
    expect(f.missions.claimUnit(f.item.id, "root", f.claim)).toMatchObject({ ok: true });
    const result = f.ask("real-child");
    expect(result).toMatchObject({ ok: true, created: ["real-child"] });
    expect(f.ledger.unitAuthority(f.item.id, "real-child")?.definition.maximumPrivileges).toEqual(["fs.read"]);
    expect(f.items.verifyAuditChain().ok).toBe(true);
  });

  it("refuses new child work as soon as the real grant is revoked, with a durable denial", () => {
    const f = setup();
    f.ledger.grantMissionAuthority({ missionId: f.item.id, grantId: f.grant.grantId });
    f.missions.claimUnit(f.item.id, "root", f.claim);
    expect(f.ask("before-revoke")).toMatchObject({ ok: true });
    f.items.revokeAutonomousAuthority(f.grant.grantId, HUMAN, "stop", { via: "policy_gate", actorId: HUMAN });
    const after = f.ask("after-revoke");
    expect(after).toMatchObject({ ok: false, outcome: "denied" });
    expect(after.ok === false && "reasons" in after && after.reasons).toContain("grant_revoked");
    expect(f.missions.workUnits(f.item.id).map((u) => u.unitId)).not.toContain("after-revoke");
    expect(eventNames(f)).toContain("child.denied");
  });

  it("denies, with durable evidence, when the real grant fails its integrity check instead of throwing", () => {
    const f = setup();
    f.ledger.grantMissionAuthority({ missionId: f.item.id, grantId: f.grant.grantId });
    f.missions.claimUnit(f.item.id, "root", f.claim);
    // Corrupt the audit event the grant is anchored to. The canonical reader rejects the grant.
    const db = new DatabaseSync(f.dbPath);
    try {
      db.prepare("UPDATE audit_events SET body = json_set(body, '$.grantHash', ?) WHERE id = ?").run(
        "f".repeat(64),
        f.grant.auditEventId
      );
    } finally {
      db.close();
    }
    let outcome: unknown;
    let thrown: unknown;
    try {
      outcome = f.ask("tampered");
    } catch (error) {
      thrown = error;
    }
    expect(thrown, `requestChildWork threw instead of denying: ${String(thrown)}`).toBeUndefined();
    expect(outcome).toMatchObject({ ok: false, outcome: "denied" });
    expect(f.missions.workUnits(f.item.id).map((u) => u.unitId)).not.toContain("tampered");
    expect(eventNames(f)).toContain("child.denied");
  });

  it("refuses to bind a tampered real grant with durable evidence", () => {
    const f = setup();
    const db = new DatabaseSync(f.dbPath);
    try {
      db.prepare("UPDATE audit_events SET body = json_set(body, '$.grantHash', ?) WHERE id = ?").run(
        "f".repeat(64),
        f.grant.auditEventId
      );
    } finally {
      db.close();
    }
    let thrown: unknown;
    try {
      f.ledger.grantMissionAuthority({ missionId: f.item.id, grantId: f.grant.grantId });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "mission_authority_unverified" });
    expect(eventNames(f)).toContain("authority.denied");
    expect(f.ledger.missionAuthority(f.item.id)).toBeUndefined();
  });
});

describe("claim liveness", () => {
  it("lets a normal claim lapse, and does not let a future-stamped claim outlive the ttl", () => {
    for (const [claimedAtMs, expected] of [
      [500, "claim_expired"],
      [30 * 24 * 3_600_000, "claim_expired"]
    ] as const) {
      const f = setup();
      f.ledger.grantMissionAuthority({ missionId: f.item.id, grantId: f.grant.grantId });
      expect(f.missions.claimUnit(f.item.id, "root", { ...f.claim, claimedAt: f.iso(claimedAtMs) })).toMatchObject({
        ok: true
      });
      f.state.now = f.iso(30 * 60 * 1000);
      const result = f.ask(`late-${claimedAtMs}`);
      expect(result).toMatchObject({ ok: false, outcome: "denied" });
      expect(result.ok === false && "reasons" in result && result.reasons).toEqual([expected]);
    }
  });

  it("still accepts a claim within the ttl, and one stamped a hair ahead of the clock", () => {
    for (const claimedAtMs of [500, 1_000 + 2_000]) {
      const f = setup();
      f.ledger.grantMissionAuthority({ missionId: f.item.id, grantId: f.grant.grantId });
      f.missions.claimUnit(f.item.id, "root", { ...f.claim, claimedAt: f.iso(claimedAtMs) });
      expect(f.ask(`fresh-${claimedAtMs}`)).toMatchObject({ ok: true });
    }
  });
});
