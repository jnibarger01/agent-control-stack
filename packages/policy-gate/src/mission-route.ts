import { ControlStackError, domainHash } from "@agent-control-stack/shared";
import {
  classifierEvidenceHash,
  classifierEvidenceSchema,
  missionIntakeHash,
  missionIntakeSchema,
  missionRouteEvidenceSchema,
  type MissionRouteEvidence,
  type MissionTaskType
} from "@agent-control-stack/work-items";

export const NATIVE_ROUTE_TABLE_VERSION = "acs.native-route-table.v1" as const;

// VERSIONED CHANGE PATH (ADR 0020): the closed route table is authority-bearing
// evidence. To remap a task type to a different engine (for example coding ->
// codex_swarm), the change must be a deliberate, versioned act:
//   1. bump NATIVE_ROUTE_TABLE_VERSION to a new monotonically named version
//      (e.g. "acs.native-route-table.v2") in the same commit as the route edit;
//   2. NATIVE_ROUTE_TABLE_HASH recomputes automatically from the new version
//      plus routes and MUST NOT be hand-edited;
//   3. update every persisted evidence row produced under the old version at
//      the same time -- requireRoutedMission fails closed with
//      "mission_route_table_mismatch" for any route evidence carrying an old
//      version or hash, so old evidence never silently re-resolves to a new
//      engine. A silent hash edit would leave version and hash inconsistent
//      and fail closed here.

// Closed authority table: neither callers nor advisory classifiers choose an engine.
const ROUTE_TABLE: Readonly<Record<Exclude<MissionTaskType, "unknown">, string>> = Object.freeze({
  coding: "codex",
  research: "claude",
  memory_lookup: "pi",
  browser_scrape: "opencode",
  deal_analysis: "claude",
  system_admin: "codex"
});

export const NATIVE_ROUTE_TABLE_HASH = domainHash("acs:native-route-table:v1", {
  version: NATIVE_ROUTE_TABLE_VERSION,
  routes: ROUTE_TABLE
});

export interface RouteMissionInput {
  intake: unknown;
  classifierEvidence: unknown;
  routeId: string;
  decidedAt: string;
}

export function routeMission(input: RouteMissionInput): MissionRouteEvidence {
  const intake = missionIntakeSchema.parse(input.intake);
  const classifier = classifierEvidenceSchema.parse(input.classifierEvidence);
  const intakeHash = missionIntakeHash(intake);
  if (classifier.subjectIntakeHash !== intakeHash) {
    throw new ControlStackError(
      "mission_classifier_subject_mismatch",
      "classifier evidence is not bound to mission intake"
    );
  }
  const taskType = classifier.taskType.recommendation;
  const engineId = taskType === "unknown" ? undefined : ROUTE_TABLE[taskType];
  return missionRouteEvidenceSchema.parse({
    schemaVersion: "acs.mission-route-evidence.v1",
    routeId: input.routeId,
    routeTableVersion: NATIVE_ROUTE_TABLE_VERSION,
    routeTableHash: NATIVE_ROUTE_TABLE_HASH,
    subjectIntakeHash: intakeHash,
    classifierEvidenceHash: classifierEvidenceHash(classifier),
    taskType,
    // Classification is advisory. A submitted risk claim is an immutable
    // control-plane input and therefore establishes a non-downgrade floor.
    effectiveRisk: maxRisk(intake.submittedClaims?.risk ?? "read_only", classifier.risk.recommendation),
    ...(engineId ? { engineId } : {}),
    decision: engineId ? "routed" : "blocked",
    reasons: engineId ? [] : ["unknown_task_type"],
    decidedAt: input.decidedAt
  });
}

export function requireRoutedMission(input: unknown): MissionRouteEvidence & { engineId: string; decision: "routed" } {
  const route = missionRouteEvidenceSchema.parse(input);
  if (route.routeTableVersion !== NATIVE_ROUTE_TABLE_VERSION || route.routeTableHash !== NATIVE_ROUTE_TABLE_HASH) {
    throw new ControlStackError(
      "mission_route_table_mismatch",
      "route evidence was not produced by the current native route table"
    );
  }
  if (route.decision !== "routed" || !route.engineId) {
    throw new ControlStackError("mission_route_blocked", "mission route is blocked and cannot be dispatched");
  }
  if (route.taskType === "unknown" || route.engineId !== ROUTE_TABLE[route.taskType]) {
    throw new ControlStackError(
      "mission_route_engine_mismatch",
      "route evidence engine is not the engine selected by the native route table"
    );
  }
  return route as MissionRouteEvidence & { engineId: string; decision: "routed" };
}

const RISK_RANK = { read_only: 0, draft: 1, write: 2, destructive: 3, unknown: 4 } as const;

function maxRisk<T extends keyof typeof RISK_RANK>(left: T, right: T): T {
  return RISK_RANK[left] >= RISK_RANK[right] ? left : right;
}
