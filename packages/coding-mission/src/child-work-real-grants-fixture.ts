import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteWorkItemStore, executionPlanSubjectInputHash } from "@agent-control-stack/work-items";
import { afterEach } from "vitest";
import type { AutonomousAuthorityDefinition } from "./authority.js";
import { DEFAULT_DELEGATION_BUDGET } from "./budget.js";
import { MissionAuthorityLedger, type ChildWorkItem, type GrantReader } from "./child-work.js";
import { CodingMissionStore } from "./store.js";

/**
 * Shared by the real-grant tests. child-work.test.ts drives the ledger with an in-memory FakeGrants, which never throws, never touches the audit chain
 * and cannot be revoked the way production does it. These tests wire the ledger to the real SqliteWorkItemStore grant
 * path (human-issued grant, canonical hash, audit event, audit-backed revocation) to check what a deployment relies on.
 */
export const HUMAN = "human-issuer";
export const ACTOR = "actor:lead";
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

export function setupRealGrants() {
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
