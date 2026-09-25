import { ControlStackError, redactValue } from "@agent-control-stack/shared";
import { resultPayloadHash, type WorkItemStore } from "@agent-control-stack/work-items";

/** Read-only, redacted output; never capabilities, credentials or lease tokens. */
export function harnessExecutionResult(store: WorkItemStore, id: string) {
  const item = store.get(id);
  if (!item) throw new ControlStackError("work_item_not_found", "work item not found");
  const resultId = item.result?.resultId;
  if (item.status !== "succeeded" || typeof resultId !== "string") {
    throw new ControlStackError("execution_result_not_ready", "execution result is not ready");
  }
  const result = store.getExecutionResult(resultId);
  if (
    !result ||
    result.workItemId !== id ||
    result.payloadHash !== item.result?.payloadHash ||
    resultPayloadHash(result) !== result.payloadHash ||
    result.actionHash !== item.result?.actionHash ||
    result.leaseId !== item.result?.leaseId ||
    result.workerId !== item.result?.workerId
  ) {
    throw new ControlStackError(
      "execution_result_integrity_mismatch",
      "execution result binding or integrity mismatch"
    );
  }
  const meta = result.simulationMetadata;
  if (
    result.outcome !== "succeeded" ||
    meta.executionMode !== "desktop_commander" ||
    meta.simulated !== false ||
    meta.backend !== "desktop-commander-mcp" ||
    meta.blocked ||
    typeof meta.toolName !== "string" ||
    typeof meta.requestId !== "string" ||
    typeof meta.invocationFingerprint !== "string"
  ) {
    throw new ControlStackError(
      "execution_result_backend_mismatch",
      "a successful real Desktop Commander result is required"
    );
  }
  const events = store.readEvents({ workItemId: id, limit: 1000 });
  const leaseEvents = events.filter(
    (event) => event.attributes["lease.id"] === result.leaseId && event.attributes["worker.id"] === result.workerId
  );
  const boundEvents = leaseEvents.filter((event) => event.attributes["action.hash"] === result.actionHash);
  const capability = boundEvents.find((event) => event.name === "desktop_commander.capability_issued");
  const attemptId = typeof capability?.body.attemptId === "string" ? capability.body.attemptId : undefined;
  // Two executor routes produce equivalent evidence:
  //  - ACS worker: execution.authorization_granted + execution.completed
  //  - managed bridge (Strands hand-off): policy-bound attempt_lease.issued +
  //    execution_result.accepted for this exact lease and payload.
  const authorization =
    boundEvents.find(
      (event) =>
        event.name === "execution.authorization_granted" &&
        event.body.actionHash === result.actionHash &&
        event.attributes["attempt.id"] === attemptId
    ) ??
    leaseEvents.find(
      (event) =>
        event.name === "attempt_lease.issued" &&
        event.body.leaseId === result.leaseId &&
        event.body.workerId === result.workerId &&
        event.body.attemptId === attemptId &&
        event.attributes["attempt.id"] === attemptId
    );
  const completion =
    boundEvents.find(
      (event) =>
        event.name === "execution.completed" && event.body.ok === true && event.attributes["attempt.id"] === attemptId
    ) ??
    boundEvents.find(
      (event) =>
        event.name === "execution_result.accepted" &&
        event.body.outcome === "succeeded" &&
        event.body.leaseId === result.leaseId &&
        event.body.payloadHash === result.payloadHash
    );
  if (
    !capability ||
    !authorization ||
    !completion ||
    attemptId === undefined ||
    typeof capability.body.runtimeId !== "string" ||
    typeof capability.body.requestHash !== "string" ||
    typeof capability.body.keyId !== "string" ||
    typeof authorization.body.policyDecisionHash !== "string" ||
    capability.attributes["attempt.id"] !== attemptId
  ) {
    throw new ControlStackError(
      "execution_result_audit_incomplete",
      "bound authorization, capability and completion audit evidence is required"
    );
  }
  return {
    workItemId: id,
    resultId,
    leaseId: result.leaseId,
    workerId: result.workerId,
    actionHash: result.actionHash,
    payloadHash: result.payloadHash,
    outcome: "succeeded",
    // The managed bridge records tool text as stdout; older results carry only the bounded summary.
    output: redactValue(result.stdout ?? result.summary ?? ""),
    executionMode: "desktop_commander",
    toolName: meta.toolName,
    requestId: meta.requestId,
    invocationFingerprint: meta.invocationFingerprint,
    audit: {
      authorizationEventId: authorization.id,
      capabilityEventId: capability.id,
      completionEventId: completion.id,
      policyDecisionHash: authorization.body.policyDecisionHash,
      attemptId,
      runtimeId: capability.body.runtimeId,
      capabilityRequestHash: capability.body.requestHash,
      keyId: capability.body.keyId
    }
  };
}
