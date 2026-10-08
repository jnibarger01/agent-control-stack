import { ControlStackError, domainHash } from "@agent-control-stack/shared";
import {
  VERIFICATION_POLICIES,
  WORK_UNIT_KINDS,
  parseWorkUnitPayload,
  type VerificationPolicy,
  type WorkUnitKind,
  type WorkUnitPayload
} from "./mission-model.js";

/**
 * Non-authoritative preview of a proposed mission graph. No tool is invoked,
 * approval granted, capability issued, or work unit persisted here.
 * A planner/model is untrusted even when its proposal parses successfully.
 */
export const MISSION_INTELLIGENCE_SCHEMA_VERSION = "acs.mission-intelligence.v1" as const;

export interface MissionIntelligenceUnit {
  unitId: string;
  title: string;
  kind: WorkUnitKind;
  dependsOn: string[];
  payload: WorkUnitPayload;
  verificationPolicy: VerificationPolicy;
  requiredCapabilities: string[];
  requestedPermissions: string[];
  successCriteria: string[];
}

export interface MissionIntelligencePreview {
  schemaVersion: typeof MISSION_INTELLIGENCE_SCHEMA_VERSION;
  objective: string;
  planHash: string;
  units: MissionIntelligenceUnit[];
  stages: Array<{ sequence: number; unitIds: string[] }>;
  authorization: "not_evaluated";
  executionAuthorized: false;
}

const unitKeys = new Set([
  "unitId",
  "title",
  "kind",
  "dependsOn",
  "payload",
  "verificationPolicy",
  "requiredCapabilities",
  "requestedPermissions",
  "successCriteria"
]);
const idPattern = /^[A-Za-z0-9._:-]{1,128}$/u;

function invalid(reason: string): never {
  throw new ControlStackError("mission_intelligence_invalid", reason);
}

function object(value: unknown, keys: ReadonlySet<string>, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(label + " must be an object");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!keys.has(key)) invalid(label + " has unrecognized field " + key);
  return record;
}

function boundedString(value: unknown, label: string, limit: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > limit)
    invalid(label + " must be a non-empty bounded string");
  return value as string;
}

function stringList(value: unknown, label: string, max: number, limit: number): string[] {
  if (!Array.isArray(value) || value.length > max) invalid(label + " must be a bounded list");
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const name = boundedString(item, label + " entry", limit);
    if (seen.has(name)) invalid(label + " has duplicate entry " + name);
    seen.add(name);
    result.push(name);
  }
  return result;
}

/**
 * Parse a planner's proposal and produce deterministic topological stages.
 * It is not a policy decision: the canonical ACS store must validate and admit
 * each unit again under the current operator, policy, budget and lease.
 */
export function previewMissionIntelligence(input: unknown): MissionIntelligencePreview {
  const record = object(input, new Set(["objective", "units"]), "mission proposal");
  const objective = boundedString(record.objective, "objective", 8192);
  if (!Array.isArray(record.units) || record.units.length === 0 || record.units.length > 128)
    invalid("units must contain between 1 and 128 proposed units");

  const units: MissionIntelligenceUnit[] = [];
  const byId = new Map<string, MissionIntelligenceUnit>();
  for (const [index, item] of record.units.entries()) {
    const raw = object(item, unitKeys, "unit " + index);
    const unitId = boundedString(raw.unitId, "unitId", 128);
    if (!idPattern.test(unitId)) invalid("unitId has invalid characters");
    if (byId.has(unitId)) invalid("duplicate unitId " + unitId);
    if (!WORK_UNIT_KINDS.includes(raw.kind as WorkUnitKind)) invalid("unknown work unit kind");
    if (!VERIFICATION_POLICIES.includes(raw.verificationPolicy as VerificationPolicy))
      invalid("unknown verification policy");
    const kind = raw.kind as WorkUnitKind;
    const dependencies = stringList(raw.dependsOn, "dependsOn", 128, 128).sort();
    if (dependencies.some((dep) => !idPattern.test(dep))) invalid("invalid dependency identifier");
    if (dependencies.includes(unitId)) invalid("unit cannot depend on itself");
    const unit: MissionIntelligenceUnit = {
      unitId,
      title: boundedString(raw.title, "title", 256),
      kind,
      dependsOn: dependencies,
      payload: parseWorkUnitPayload(kind, raw.payload),
      verificationPolicy: raw.verificationPolicy as VerificationPolicy,
      requiredCapabilities: stringList(raw.requiredCapabilities, "requiredCapabilities", 32, 128).sort(),
      requestedPermissions: stringList(raw.requestedPermissions, "requestedPermissions", 32, 128).sort(),
      successCriteria: stringList(raw.successCriteria, "successCriteria", 32, 1000)
    };
    // A proposed unit is not a completion contract without at least one check.
    if (unit.successCriteria.length === 0) invalid("unit " + unitId + " has no success criteria");
    byId.set(unitId, unit);
    units.push(unit);
  }

  for (const unit of units) {
    for (const dependency of unit.dependsOn) {
      if (!byId.has(dependency)) invalid("missing dependency " + dependency + " for " + unit.unitId);
    }
    if (unit.kind === "verification") {
      const target = (unit.payload as Extract<WorkUnitPayload, { kind: "verification" }>).targetUnitId;
      if (!byId.has(target) || !unit.dependsOn.includes(target))
        invalid("verification must depend on a proposed target unit");
    }
  }

  // Kahn's algorithm with lexicographic tie-breaks. Input ordering cannot affect output or hash.
  const remaining = new Set(byId.keys());
  const stages: MissionIntelligencePreview["stages"] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((id) => byId.get(id)!.dependsOn.every((dependency) => !remaining.has(dependency)))
      .sort();
    if (ready.length === 0) invalid("mission proposal contains a dependency cycle");
    stages.push({ sequence: stages.length + 1, unitIds: ready });
    for (const id of ready) remaining.delete(id);
  }
  units.sort((left, right) => left.unitId.localeCompare(right.unitId));
  return {
    schemaVersion: MISSION_INTELLIGENCE_SCHEMA_VERSION,
    objective,
    planHash: domainHash(MISSION_INTELLIGENCE_SCHEMA_VERSION, { objective, units }),
    units,
    stages,
    authorization: "not_evaluated",
    executionAuthorized: false
  };
}