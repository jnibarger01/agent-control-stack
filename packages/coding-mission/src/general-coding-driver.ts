import { parseGeneralCodingTask } from "./general-coding.js";
import { TERMINAL_MISSION_STATES } from "./mission-model.js";
import type { CodingMissionStore } from "./store.js";
import type { GovernedUnitRunner, RunUnitResult } from "./unit-runner.js";

export interface GeneralCodingDriverOptions {
  workerId: string;
  /** Hard cap on units started in one pass. Default 1, never more than `MAX_UNITS_PER_PASS`. */
  maxUnits?: number;
  /** How many of the most recently updated missions one pass looks at. Default 50. */
  missionScanLimit?: number;
  /**
   * Optional wall-clock bound for the whole pass, in ms. No new unit starts once it has elapsed (a unit already running is
   * bounded by its own `maxRuntimeMs`). A value that is not a finite non-negative number starts nothing.
   */
  maxWallMs?: number;
  /** Clock for `maxWallMs`, in epoch ms. Default `Date.now`. */
  nowMs?: () => number;
}

export type GeneralCodingDriverResult = (RunUnitResult | { status: "skipped"; reason: string }) & {
  missionId: string;
  unitId: string;
};

export interface GeneralCodingDriverSummary {
  missionsConsidered: number;
  results: GeneralCodingDriverResult[];
}

const DEFAULT_MAX_UNITS = 1;
/** Ceiling on a caller-supplied `maxUnits`, so a misconfigured deployment cannot turn one pass into an unbounded loop. */
export const MAX_UNITS_PER_PASS = 10;
const DEFAULT_SCAN_LIMIT = 50;

/**
 * One bounded, sequential pass over active governed `general` missions: hand each eligible coding unit to the runner, on
 * the coder lane, until `maxUnits` have been started. It never touches `coding` missions (those belong to
 * `CodingMissionController`) and never a mission with no authority binding.
 *
 * Eligibility here is only a pre-filter. A unit without a complete typed task contract is reported as skipped and is not
 * claimed, so a malformed unit cannot burn a claim or an attempt. `claimUnit` rechecks dependencies and budgets, the
 * dispatch gate rechecks authority, and the adapter re-verifies claim, authority, scope and runtime where the work runs,
 * so a stale view here can waste a call but never run a unit that should not run. A failure on one unit does not stop
 * the pass.
 */
export async function runGeneralCodingUnits(
  runner: GovernedUnitRunner,
  missions: CodingMissionStore,
  options: GeneralCodingDriverOptions
): Promise<GeneralCodingDriverSummary> {
  const maxUnits = boundedMaxUnits(options.maxUnits);
  const summary: GeneralCodingDriverSummary = { missionsConsidered: 0, results: [] };
  const nowMs = options.nowMs ?? Date.now;
  const startedAt = nowMs();
  const wallValid = options.maxWallMs === undefined || (Number.isFinite(options.maxWallMs) && options.maxWallMs >= 0);
  const outOfTime = () => !wallValid || (options.maxWallMs !== undefined && nowMs() - startedAt >= options.maxWallMs);
  const started = () => summary.results.filter((result) => result.status !== "skipped").length;
  if (maxUnits === 0 || outOfTime()) return summary;

  const candidates = missions
    .listRecent(options.missionScanLimit ?? DEFAULT_SCAN_LIMIT)
    .filter((mission) => mission.kind === "general" && !TERMINAL_MISSION_STATES.has(mission.state))
    .sort((left, right) => left.missionId.localeCompare(right.missionId));

  for (const mission of candidates) {
    if (started() >= maxUnits || outOfTime()) break;
    if (!hasAuthorityBinding(missions, mission.missionId)) continue;
    summary.missionsConsidered += 1;
    const units = missions.workUnits(mission.missionId);
    const succeeded = new Set(units.filter((unit) => unit.status === "succeeded").map((unit) => unit.unitId));
    const eligible = units
      .filter(
        (unit) =>
          (unit.status === "pending" || unit.status === "ready") &&
          unit.kind === "coding" &&
          unit.dependsOn.every((dependency) => succeeded.has(dependency))
      )
      .sort((left, right) => left.unitId.localeCompare(right.unitId));
    for (const unit of eligible) {
      if (started() >= maxUnits || outOfTime()) break;
      const base = { missionId: mission.missionId, unitId: unit.unitId };
      try {
        parseGeneralCodingTask(unit.payload);
      } catch {
        summary.results.push({ ...base, status: "skipped", reason: "task_contract_invalid" });
        continue;
      }
      const result = await runner.runUnit({ ...base, workerId: options.workerId, lane: "coder" });
      summary.results.push({ ...result, ...base });
    }
  }
  return summary;
}

/**
 * The step cap, fail-closed: an omitted value takes the default; anything that is not a finite non-negative integer
 * (NaN, Infinity, a negative or fractional number, a non-number) starts nothing; the rest is clamped to the ceiling.
 */
function boundedMaxUnits(value: unknown): number {
  if (value === undefined) return DEFAULT_MAX_UNITS;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) return 0;
  return Math.min(MAX_UNITS_PER_PASS, value);
}

function hasAuthorityBinding(missions: CodingMissionStore, missionId: string): boolean {
  return (
    missions.db.prepare("SELECT 1 AS present FROM mission_authority WHERE mission_id = ?").get(missionId) !== undefined
  );
}
