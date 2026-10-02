import type { MissionSnapshot, OperationRecord } from "./types.js";

export interface MissionProgress {
  missionId: string;
  status: MissionSnapshot["mission"]["status"];
  complete: string[];
  ready: string[];
  running: string[];
  reconciliation: string[];
  failed: string[];
  blocked: string[];
  pending: string[];
  readyForChangeSet: boolean;
  failureCode?: string;
  failureReason?: string;
}

const RUNNING_OPERATION = new Set(["ROUTED", "ADMITTED", "CLAIMED", "DISPATCHED", "VERIFYING"]);

export function dependencyReady(operation: OperationRecord, byId: Map<string, OperationRecord>): boolean {
  if (operation.resultHash || operation.status === "SUCCEEDED") return false;
  if (["FAILED", "BLOCKED", "CANCELLED", "UNKNOWN", "DISPATCHED", "CLAIMED", "VERIFYING"].includes(operation.status)) {
    return false;
  }
  return operation.dependencies.every((dependencyId) => byId.get(dependencyId)?.status === "SUCCEEDED");
}

/** Canonical progress. Callers must not keep a second in-memory notion of readiness. */
export function deriveMissionProgress(snapshot: MissionSnapshot): MissionProgress {
  const byId = new Map(snapshot.operations.map((operation) => [operation.operationId, operation]));
  const complete: string[] = [];
  const ready: string[] = [];
  const running: string[] = [];
  const reconciliation: string[] = [];
  const failed: string[] = [];
  const blocked: string[] = [];
  const pending: string[] = [];

  for (const operation of snapshot.operations) {
    if (operation.status === "SUCCEEDED") complete.push(operation.operationId);
    else if (operation.status === "UNKNOWN") reconciliation.push(operation.operationId);
    else if (operation.status === "FAILED") failed.push(operation.operationId);
    else if (operation.status === "BLOCKED") blocked.push(operation.operationId);
    else if (RUNNING_OPERATION.has(operation.status)) running.push(operation.operationId);
    else if (dependencyReady(operation, byId) || operation.status === "READY") ready.push(operation.operationId);
    else pending.push(operation.operationId);
  }

  const executionDone =
    snapshot.operations.length > 0 && snapshot.operations.every((operation) => operation.status === "SUCCEEDED");
  const head = snapshot.changeSets.find((changeSet) => changeSet.changeSetId === snapshot.mission.changeSetId);
  const readyForChangeSet =
    executionDone && snapshot.mission.requiresMutation && !head && failed.length === 0 && reconciliation.length === 0;

  return {
    missionId: snapshot.mission.missionId,
    status: snapshot.mission.status,
    complete,
    ready,
    running,
    reconciliation,
    failed,
    blocked,
    pending,
    readyForChangeSet,
    ...(snapshot.mission.failureCode ? { failureCode: snapshot.mission.failureCode } : {}),
    ...(snapshot.mission.failureReason ? { failureReason: snapshot.mission.failureReason } : {})
  };
}
