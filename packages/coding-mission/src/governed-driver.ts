import { TERMINAL_MISSION_STATES, type WorkUnitKind } from "./mission-model.js";
import type { CodingMissionStore } from "./store.js";
import type { GovernedUnitRunner, RunUnitResult } from "./unit-runner.js";
import type { ExecutorLane } from "./worker-execution.js";

export interface GovernedDriverOptions {
  workerId: string;
  lane: ExecutorLane;
  /** Only units of these kinds are handed to the runner, so a coder deployment never picks up a desktop unit. */
  unitKinds: readonly WorkUnitKind[];
  /** Hard cap on units started in one pass. Default 1. */
  maxUnits?: number;
  /** How many of the most recently updated missions one pass looks at. Default 50. */
  missionScanLimit?: number;
  /**
   * Skip missions with no persisted authority binding. Default true: this driver exists to run governed work, and an
   * ungoverned `general` mission has no other driver, so enabling one must be an explicit choice.
   */
  requireGovernance?: boolean;
}

export interface GovernedDriverSummary {
  missionsConsidered: number;
  results: Array<RunUnitResult & { missionId: string; unitId: string }>;
}

const DEFAULT_MAX_UNITS = 1;
const DEFAULT_SCAN_LIMIT = 50;

/**
 * One bounded, sequential pass over active `general` missions: hand each eligible unit to the runner until `maxUnits`
 * have been started. Eligibility here is only a pre-filter. `claimUnit` rechecks dependencies and budgets in its own
 * transaction, and the dispatch gate rechecks authority, so a stale view here can waste a call but never run a unit that
 * should not run. A refusal or failure on one unit does not stop the pass.
 */
export async function runGovernedUnits(
  runner: GovernedUnitRunner,
  missions: CodingMissionStore,
  options: GovernedDriverOptions
): Promise<GovernedDriverSummary> {
  const maxUnits = Math.max(0, Math.floor(options.maxUnits ?? DEFAULT_MAX_UNITS));
  const requireGovernance = options.requireGovernance ?? true;
  const kinds = new Set<WorkUnitKind>(options.unitKinds);
  const summary: GovernedDriverSummary = { missionsConsidered: 0, results: [] };

  const candidates = missions
    .listRecent(options.missionScanLimit ?? DEFAULT_SCAN_LIMIT)
    .filter((mission) => mission.kind === "general" && !TERMINAL_MISSION_STATES.has(mission.state))
    .sort((left, right) => left.missionId.localeCompare(right.missionId));

  for (const mission of candidates) {
    if (summary.results.length >= maxUnits) break;
    if (requireGovernance && !hasAuthorityBinding(missions, mission.missionId)) continue;
    summary.missionsConsidered += 1;
    const units = missions.workUnits(mission.missionId);
    const succeeded = new Set(units.filter((unit) => unit.status === "succeeded").map((unit) => unit.unitId));
    const eligible = units
      .filter(
        (unit) =>
          (unit.status === "pending" || unit.status === "ready") &&
          kinds.has(unit.kind) &&
          unit.dependsOn.every((dependency) => succeeded.has(dependency))
      )
      .sort((left, right) => left.unitId.localeCompare(right.unitId));
    for (const unit of eligible) {
      if (summary.results.length >= maxUnits) break;
      const result = await runner.runUnit({
        missionId: mission.missionId,
        unitId: unit.unitId,
        workerId: options.workerId,
        lane: options.lane
      });
      summary.results.push({ ...result, missionId: mission.missionId, unitId: unit.unitId });
    }
  }
  return summary;
}

function hasAuthorityBinding(missions: CodingMissionStore, missionId: string): boolean {
  return (
    missions.db.prepare("SELECT 1 AS present FROM mission_authority WHERE mission_id = ?").get(missionId) !== undefined
  );
}
