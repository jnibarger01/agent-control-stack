import { autonomousAuthorityHash, type AutonomousAuthorityGrant } from "@agent-control-stack/work-items";
import type { AutonomousAuthorityDefinition } from "./authority.js";
import { DEFAULT_DELEGATION_BUDGET, type MissionBudget } from "./budget.js";
import { MissionAuthorityLedger, type ChildWorkItem, type GrantReader } from "./child-work.js";
import { CodingMissionStore } from "./store.js";

/**
 * Shared by child-work-race.test.ts and its worker processes. Every process rebuilds the same deterministic grant and
 * clock, so the only thing the racers share is the SQLite file, which is exactly what is being tested.
 */
export const T0 = "2026-10-09T00:00:00.000Z";
export const NOW = "2026-10-09T00:00:01.000Z";
export const MISSION = "race-mission";
export const PARENT_WORKER = "lead-worker";
export const PARENT_TOKEN = "tok-parent-race";

const ROOT: AutonomousAuthorityDefinition = {
  executingActorId: "actor:lead",
  scope: [{ kind: "path", id: "/repo/acme/app", coverage: "descendants" }],
  toolClasses: [{ runtime: "desktop_commander", toolName: "read_file" }],
  maximumPrivileges: ["fs.read", "fs.write"],
  expiresAt: "2026-10-09T02:00:00.000Z",
  limits: { maxOperations: 500, maxRuntimeMs: 600_000, maxParallelOperations: 32, maxAttemptsPerOperation: 3 }
};

function grant(): AutonomousAuthorityGrant {
  const core = {
    schemaVersion: "acs.autonomous-authority.v1" as const,
    grantId: "grant-race",
    missionId: MISSION,
    subjectInputHash: "a".repeat(64),
    issuedByActorId: "human-1",
    requestId: "req-race",
    definition: ROOT,
    reason: "approved by operator",
    createdAt: T0
  };
  return { ...core, grantHash: autonomousAuthorityHash(core), auditEventId: "evt-race" };
}

class FixedGrants implements GrantReader {
  getAutonomousAuthority(grantId: string) {
    return grantId === "grant-race" ? grant() : undefined;
  }
  currentSubjectInputHash() {
    return "a".repeat(64);
  }
}

export function openLedger(dbPath: string): { store: CodingMissionStore; ledger: MissionAuthorityLedger } {
  const store = new CodingMissionStore(dbPath);
  const ledger = new MissionAuthorityLedger(store, {
    grants: new FixedGrants(),
    verifyOperator: () => false,
    clock: () => NOW,
    resolveActor: () => "actor:lead"
  });
  return { store, ledger };
}

export function childItem(unitId: string): ChildWorkItem {
  return {
    unitId,
    workType: "research",
    purpose: `purpose of ${unitId}`,
    payload: { role: "researcher", prompt: "look into it" },
    requestedAuthority: {
      ...ROOT,
      maximumPrivileges: ["fs.read"],
      limits: { maxOperations: 2, maxRuntimeMs: 60_000, maxParallelOperations: 1, maxAttemptsPerOperation: 1 }
    }
  };
}

/** Create the mission, bind its authority, and claim the lead unit. Run once, before any racer starts. */
export function seedMission(dbPath: string, budget: MissionBudget = { ...DEFAULT_DELEGATION_BUDGET }): void {
  const { store, ledger } = openLedger(dbPath);
  try {
    store.createGeneral({ missionId: MISSION, summary: "race", budget, now: T0 });
    store.addWorkUnits(
      MISSION,
      [{ unitId: "root", kind: "agent", title: "root", payload: { role: "lead", prompt: "p" } }],
      T0
    );
    ledger.grantMissionAuthority({ missionId: MISSION, grantId: "grant-race" });
    const claimed = store.claimUnit(MISSION, "root", {
      token: PARENT_TOKEN,
      workerId: PARENT_WORKER,
      route: {},
      claimedAt: T0
    });
    if (!claimed.ok) throw new Error(`seed claim failed: ${JSON.stringify(claimed)}`);
  } finally {
    store.close();
  }
}
