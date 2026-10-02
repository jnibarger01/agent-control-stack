import { ControlStackError, domainHash } from "@agent-control-stack/shared";
import type { MissionSnapshot } from "./types.js";

export function evidenceSealHash(snapshot: MissionSnapshot): string {
  const head = snapshot.changeSets.find((changeSet) => changeSet.changeSetId === snapshot.mission.changeSetId);
  return domainHash("acs:mission-evidence:v1", {
    missionId: snapshot.mission.missionId,
    planHash: snapshot.mission.planHash,
    operations: snapshot.operations.map((operation) => ({
      operationId: operation.operationId,
      status: operation.status,
      executionId: operation.executionId ?? null,
      resultHash: operation.resultHash ?? null,
      selectedActor: operation.routeDecision?.selected ?? null
    })),
    verifications: snapshot.verifications.map((verification) => ({
      operationId: verification.operationId,
      stage: verification.stage,
      kind: verification.kind,
      outcome: verification.outcome,
      expected: verification.expectedCondition
    })),
    changeSetHash: head?.changeSetHash ?? null,
    approvals: snapshot.approvals.map((approval) => ({
      changeSetHash: approval.changeSetHash,
      decision: approval.decision
    })),
    application: snapshot.application
      ? {
          status: snapshot.application.status,
          changeSetHash: snapshot.application.changeSetHash,
          observedRevision: snapshot.application.observedRevision ?? null
        }
      : null,
    deployment: snapshot.deployment
      ? {
          status: snapshot.deployment.status,
          observedVersion: snapshot.deployment.observedVersion ?? null,
          healthStatus: snapshot.deployment.healthStatus ?? null,
          restartStatus: snapshot.deployment.restartStatus ?? null
        }
      : null
  });
}

export function completionRejection(snapshot: MissionSnapshot): { code: string; reason: string } | undefined {
  const mission = snapshot.mission;
  if (snapshot.operations.length === 0) return { code: "missing_evidence", reason: "mission has no operations" };
  if (snapshot.operations.some((operation) => operation.status === "UNKNOWN")) {
    return { code: "reconciliation_required", reason: "an operation has an unknown outcome" };
  }
  if (snapshot.operations.some((operation) => operation.status !== "SUCCEEDED")) {
    return { code: "operations_incomplete", reason: "required operations are not terminal-success" };
  }
  for (const operation of snapshot.operations) {
    if (!operation.resultHash || !operation.executionId || !operation.routeDecision) {
      return {
        code: "missing_evidence",
        reason: `operation ${operation.operationId} is missing route, execution, or result evidence`
      };
    }
    for (const requirement of operation.verification) {
      const record = snapshot.verifications.find(
        (verification) =>
          verification.operationId === operation.operationId &&
          verification.stage === "operation" &&
          verification.kind === requirement.kind
      );
      if (!record || record.outcome !== "passed") {
        return {
          code: "verification_failure",
          reason: `operation ${operation.operationId} verification ${requirement.kind} did not pass`
        };
      }
    }
  }
  const names = new Set(snapshot.events.map((event) => event.name));
  const requiredEvents = [
    "mission.created",
    "route.chosen",
    "admission.granted",
    "operation.dispatched",
    "result.received"
  ];
  if (snapshot.operations.some((operation) => operation.verification.length > 0))
    requiredEvents.push("verification.completed");
  for (const required of requiredEvents) {
    if (!names.has(required)) return { code: "missing_evidence", reason: `missing durable event ${required}` };
  }
  if (mission.requiresMutation) {
    const head = snapshot.changeSets.find((changeSet) => changeSet.changeSetId === mission.changeSetId);
    if (!head) return { code: "missing_evidence", reason: "mutation mission has no change set" };
    const approval = snapshot.approvals.find(
      (item) => item.changeSetHash === head.changeSetHash && item.decision === "approved"
    );
    if (!approval) return { code: "approval_required", reason: "change set has no matching approval" };
    if (
      !snapshot.application ||
      snapshot.application.status !== "succeeded" ||
      snapshot.application.changeSetHash !== head.changeSetHash
    ) {
      return { code: "mutation_not_applied", reason: "approved change set is not applied" };
    }
    if (!names.has("change_set.created") || !names.has("approval.recorded") || !names.has("apply.completed")) {
      return { code: "missing_evidence", reason: "mutation evidence events are incomplete" };
    }
  }
  if (mission.requiresDeployment) {
    if (
      !snapshot.deployment ||
      snapshot.deployment.status !== "succeeded" ||
      snapshot.deployment.healthStatus !== "pass"
    ) {
      return { code: "deployment_failure", reason: "required deployment has not passed its health check" };
    }
    if (!names.has("deployment.completed"))
      return { code: "missing_evidence", reason: "deployment evidence is missing" };
  }
  if (mission.requiresProductionVerification) {
    for (const requirement of mission.productionVerification) {
      const record = snapshot.verifications.find(
        (verification) =>
          verification.stage === "production" &&
          verification.kind === requirement.kind &&
          verification.operationId === ""
      );
      if (!record || record.outcome !== "passed") {
        return {
          code: "production_verification_failure",
          reason: `production verification ${requirement.kind} did not pass`
        };
      }
    }
    if (!names.has("production.verification"))
      return { code: "missing_evidence", reason: "production verification event is missing" };
  }
  return undefined;
}

export function assertReadyToComplete(snapshot: MissionSnapshot): string {
  const rejection = completionRejection(snapshot);
  if (rejection) throw new ControlStackError(rejection.code, rejection.reason);
  return evidenceSealHash(snapshot);
}
