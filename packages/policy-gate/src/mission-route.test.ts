import { describe, expect, it } from "vitest";
import {
  classifierEvidenceHash,
  missionIntakeHash,
  missionIntakeSchema,
  missionRouteEvidenceHash
} from "@agent-control-stack/work-items";
import {
  NATIVE_ROUTE_TABLE_HASH,
  NATIVE_ROUTE_TABLE_VERSION,
  requireRoutedMission,
  routeMission
} from "./mission-route.js";

const intake = missionIntakeSchema.parse({
  schemaVersion: "acs.mission-intake.v1",
  requestId: "request-001",
  title: "Fix test",
  goal: "implement a code fix with tests",
  origin: "cli",
  target: { cwd: "/repo", files: ["src/index.ts"] },
  proposedActions: [{ clientActionId: "action-001", kind: "fs.patch", description: "Patch source", params: {} }],
  constraints: { network: "none", maxRuntimeMs: 60_000, successCriteria: ["Tests pass"] }
});

const classifier = {
  schemaVersion: "acs.classifier-evidence.v1",
  evidenceId: "evidence-001",
  classifier: { id: "test", version: "1" },
  subjectIntakeHash: missionIntakeHash(intake),
  generatedAt: "2026-09-04T12:00:00.000Z",
  taskType: { recommendation: "coding", signals: [] },
  risk: { recommendation: "write", signals: [] },
  sensitivity: { categories: [], signals: [] },
  authoritative: false
} as const;

describe("native mission route table", () => {
  it("emits a domain-separated, table-bound golden route vector", () => {
    const route = routeMission({
      intake,
      classifierEvidence: classifier,
      routeId: "route-001",
      decidedAt: "2026-09-04T12:00:01.000Z"
    });
    expect(route).toMatchObject({
      routeTableVersion: NATIVE_ROUTE_TABLE_VERSION,
      routeTableHash: NATIVE_ROUTE_TABLE_HASH,
      taskType: "coding",
      effectiveRisk: "write",
      engineId: "codex",
      decision: "routed"
    });
    expect(route.classifierEvidenceHash).toBe(classifierEvidenceHash(classifier));
    expect(missionRouteEvidenceHash(route)).not.toBe(classifierEvidenceHash(classifier));
    expect(requireRoutedMission(route).engineId).toBe("codex");
  });

  it("blocks unknown tasks durably rather than silently rerouting", () => {
    const route = routeMission({
      intake,
      classifierEvidence: { ...classifier, taskType: { recommendation: "unknown", signals: [] } },
      routeId: "route-002",
      decidedAt: "2026-09-04T12:00:01.000Z"
    });
    expect(route).toMatchObject({ decision: "blocked", reasons: ["unknown_task_type"] });
    expect(route.engineId).toBeUndefined();
    expect(() => requireRoutedMission(route)).toThrowError(expect.objectContaining({ code: "mission_route_blocked" }));
  });

  it("rejects classifier and route-table tampering", () => {
    expect(() =>
      routeMission({
        intake,
        classifierEvidence: { ...classifier, subjectIntakeHash: "a".repeat(64) },
        routeId: "route-003",
        decidedAt: "2026-09-04T12:00:01.000Z"
      })
    ).toThrowError(expect.objectContaining({ code: "mission_classifier_subject_mismatch" }));
    const route = routeMission({
      intake,
      classifierEvidence: classifier,
      routeId: "route-004",
      decidedAt: "2026-09-04T12:00:01.000Z"
    });
    expect(() => requireRoutedMission({ ...route, routeTableHash: "b".repeat(64) })).toThrowError(
      expect.objectContaining({ code: "mission_route_table_mismatch" })
    );
    expect(() => requireRoutedMission({ ...route, engineId: "claude" })).toThrowError(
      expect.objectContaining({ code: "mission_route_engine_mismatch" })
    );
  });

  it("does not allow advisory evidence to downgrade submitted risk", () => {
    const destructiveIntake = { ...intake, submittedClaims: { risk: "destructive" } };
    const route = routeMission({
      intake: destructiveIntake,
      classifierEvidence: {
        ...classifier,
        subjectIntakeHash: missionIntakeHash(destructiveIntake),
        risk: { recommendation: "read_only", signals: [] }
      },
      routeId: "route-005",
      decidedAt: "2026-09-04T12:00:01.000Z"
    });

    expect(route.effectiveRisk).toBe("destructive");
  });
});
