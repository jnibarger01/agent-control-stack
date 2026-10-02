import { ControlStackError, stableHash } from "@agent-control-stack/shared";
import { containPath, type ContainmentConfig } from "@agent-control-stack/desktop-commander-adapter";
import { verifyFileReadback } from "@agent-control-stack/verification";
import {
  executionActionHash,
  changeSetResultSubmissionHash,
  CHANGE_SET_VERIFICATION_POLICY,
  changeSetOperationVerification,
  type WorkItemStore,
  type SubmitWorkResultInput
} from "@agent-control-stack/work-items";

/** Gateway-owned verifier; the worker can report a result, never a verdict. */
export function verifyChangeSetResult(
  store: WorkItemStore,
  result: SubmitWorkResultInput,
  containment?: ContainmentConfig
) {
  if (result.outcome !== "succeeded" || !result.attemptId) return;
  const permit = store.requireActiveChangeSetOperationPermit(result.workItemId, result.workerId);
  if (!permit) return;
  const record = store.getChangeSet(permit.missionId)!;
  const specification = changeSetOperationVerification(record, permit.operationId);
  if (!specification) return;
  const operation = record.snapshot.definition.operations.find((op) => op.operationId === permit.operationId)!;
  const assertCurrentLease = () => {
    const attempt = store.getAttempt(result.attemptId!);
    const accepted = store.getExecutionResultForIdempotency(result.idempotencyKey);
    if (
      !attempt ||
      attempt.workItemId !== result.workItemId ||
      attempt.status !== "succeeded" ||
      !accepted ||
      accepted.workItemId !== result.workItemId ||
      accepted.leaseId !== result.leaseId ||
      accepted.workerId !== result.workerId ||
      attempt.currentFencingEpoch !== result.fencingEpoch ||
      attempt.planHash !== result.planHash ||
      attempt.inputHash !== result.inputHash ||
      executionActionHash(store.get(result.workItemId)!) !== result.actionHash ||
      store.getExecutionResultForIdempotency(result.idempotencyKey)?.resultId !==
        store.get(result.workItemId)?.result?.resultId
    )
      throw new ControlStackError(
        "verification_lease_binding_mismatch",
        "verification needs a durably accepted canonical execution result"
      );
  };
  assertCurrentLease();
  if (
    result.simulationMetadata.simulated ||
    result.simulationMetadata.executionMode !== permit.runtime ||
    result.simulationMetadata.toolName !== permit.toolName ||
    result.simulationMetadata.invocationFingerprint !== permit.invocationHash
  )
    throw new ControlStackError(
      "verification_execution_binding_mismatch",
      "result is not the approved real invocation"
    );
  const issuanceName =
    permit.runtime === "desktop_commander" ? "desktop_commander.capability_issued" : "jace_commander.capability_issued";
  if (
    !store
      .readEvents({ name: issuanceName, workItemId: result.workItemId })
      .some(
        (event) =>
          event.name === issuanceName &&
          event.attributes["attempt.id"] === result.attemptId &&
          event.attributes["lease.id"] === result.leaseId
      )
  )
    throw new ControlStackError("verification_issuance_missing", "no governed capability issuance for this attempt");
  const storedRequirement = store.getVerificationRequirement(result.attemptId);
  if (
    !storedRequirement ||
    storedRequirement.policyVersion !== specification.policyVersion ||
    storedRequirement.reviewersRequired !== specification.reviewersRequired ||
    stableHash(storedRequirement.requirement) !== stableHash(specification.requirement)
  )
    throw new ControlStackError(
      "verification_not_satisfied",
      "approved verification requirement is missing or changed"
    );
  store.getChangeSetProgress(permit.missionId, permit.manifestHash);
  const requirements = specification.requirement.requirements;
  if (requirements.length > 32)
    throw new ControlStackError("verification_resource_limit", "too many verification checks for one operation");
  const observations = requirements
    .filter((rule) => rule.kind !== "independent_review")
    .map((rule) => {
      if (rule.kind !== "fs_inspect" || !containment)
        throw new ControlStackError("verification_adapter_unavailable", "approved verification adapter is unavailable");
      const path = rule.expectation.path ?? operation.action.params.path;
      if (typeof path !== "string")
        throw new ControlStackError("verification_resource_missing", "verification needs a bound path");
      const assertCanonicalPath = (requested: string) => {
        const canonical = containPath(containment, requested).canonical;
        if (!operation.resources.some((resource) => resource.kind === "path" && resource.id === canonical))
          throw new ControlStackError(
            "verification_resource_out_of_scope",
            "verification resource not in approved operation"
          );
        return canonical;
      };
      return { requirementId: rule.requirementId, ...verifyFileReadback(path, rule.expectation, assertCanonicalPath) };
    });
  const passed = observations.length > 0 && observations.every((observation) => observation.passed);
  const evidence = {
    schemaVersion: "acs.change-set.evidence.v1",
    missionId: permit.missionId,
    manifestHash: permit.manifestHash,
    permitHash: permit.permitHash,
    operationId: permit.operationId,
    attemptId: result.attemptId,
    leaseId: result.leaseId,
    planHash: result.planHash,
    actionHash: result.actionHash,
    submissionHash: changeSetResultSubmissionHash(result),
    verifierId: "acs-file-readback",
    observations
  };
  const evidenceHash = stableHash({ domain: "acs.change-set.evidence.v1", evidence });
  store.withTransaction(() => {
    store.requireActiveChangeSetOperationPermit(result.workItemId, result.workerId);
    assertCurrentLease();
    store.recordEvidenceManifest(
      {
        manifestHash: evidenceHash,
        attemptId: result.attemptId!,
        workItemId: result.workItemId,
        admittedPlanHash: result.planHash!,
        planHash: result.planHash!,
        actionHash: result.actionHash,
        baseWorkspaceRevision: permit.manifestHash,
        resultWorkspaceRevision: evidenceHash,
        manifest: evidence
      },
      { via: "policy_gate" }
    );
    if (passed && specification.reviewersRequired === 0)
      store.recordVerificationDecision(
        {
          attemptId: result.attemptId!,
          workItemId: result.workItemId,
          outcome: "attempt_accepted",
          evidenceManifestHash: evidenceHash,
          reviewFindingHashes: [],
          verificationPolicyVersion: CHANGE_SET_VERIFICATION_POLICY
        },
        { via: "policy_gate" }
      );
  });
  if (!passed)
    throw new ControlStackError(
      "verification_not_satisfied",
      "independent file observations did not satisfy approved expectations"
    );
}
