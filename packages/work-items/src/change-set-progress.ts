import type { DatabaseSync } from "node:sqlite";
import { ControlStackError, stableHash, strictCanonicalJsonV1 } from "@agent-control-stack/shared";
import { z } from "zod";
import { executionAttemptSchema } from "./attempt.js";
import { executionAttemptInputHash, executionPlanSubjectInputHash } from "./execution-plan.js";
import { executionActionHash, submitWorkResultSchema, type WorkItem } from "./work-item.js";
import type { ChangeSetRecord } from "./change-set.js";
import { readVerifiedChangeSetAuthorityEvent } from "./change-set-approval-store.js";
import {
  changeSetOperationVerification,
  changeSetResultSubmissionHash,
  CHANGE_SET_VERIFICATION_POLICY
} from "./change-set-operation-permit.js";
import { assertChangeSetEvidenceAudit, verifyChangeSetReviews, sameReview } from "./change-set-review.js";
import type { WorkItemStore } from "./store.js";
import {
  authoritativeOperationReceiptSchema,
  authoritativeReceiptBundleHash,
  buildAuthoritativeCompletionReceipts
} from "./authoritative-completion-receipt.js";

const id = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const changeSetOperationProgressSchema = z
  .object({
    operationId: id,
    status: z.enum([
      "not_permitted",
      "not_started",
      "running",
      "succeeded",
      "failed",
      "blocked",
      "needs_reconciliation",
      "awaiting_verification"
    ]),
    dependsOn: z.array(id),
    permitId: id.optional(),
    permitHash: hash.optional(),
    executionWorkItemId: id.optional(),
    attemptId: id.optional(),
    resultId: id.optional(),
    resultPayloadHash: hash.optional(),
    resultAuditEventId: id.optional(),
    evidenceManifestHash: hash.optional()
  })
  .strict();
export const changeSetCompletionCoreSchema = z
  .object({
    schemaVersion: z.literal("acs.change-set.completion.v1"),
    missionId: id,
    manifestHash: hash,
    executingActorId: id,
    authorityKind: z.enum(["human_approval", "autonomous_grant"]),
    authorityId: id,
    policyHash: hash,
    operations: z.array(changeSetOperationProgressSchema).min(1).max(512),
    /** Historical v1 completions lack receipts; all new completions include them. */
    operationReceipts: z.array(authoritativeOperationReceiptSchema).min(1).max(512).optional(),
    completedAt: z.string().datetime({ offset: true })
  })
  .strict();
export const changeSetCompletionSchema = changeSetCompletionCoreSchema
  .extend({ completionHash: hash, auditEventId: id })
  .strict();
export const changeSetProgressSchema = z
  .object({
    schemaVersion: z.literal("acs.change-set.progress.v1"),
    missionId: id,
    manifestHash: hash,
    revision: z.number().int().positive(),
    operations: z.array(changeSetOperationProgressSchema).min(1).max(512),
    completion: changeSetCompletionSchema.optional()
  })
  .strict();
export type ChangeSetProgress = z.infer<typeof changeSetProgressSchema>;
export type ChangeSetCompletion = z.infer<typeof changeSetCompletionSchema>;
export function changeSetCompletionHash(core: unknown): string {
  return stableHash({ domain: "acs.change-set.completion.v1", record: changeSetCompletionCoreSchema.parse(core) });
}

/** Read persisted truth, never infer success from an executor message or an expired lease. */
export function readChangeSetProgress(
  db: DatabaseSync,
  store: WorkItemStore,
  record: ChangeSetRecord,
  mission: WorkItem,
  hashResult: (input: z.infer<typeof submitWorkResultSchema>) => string
): ChangeSetProgress {
  function fail(): never {
    throw new ControlStackError(
      "change_set_progress_integrity_mismatch",
      "mission execution evidence is missing or inconsistent"
    );
  }
  const definition = record.snapshot.definition;
  if (definition.subjectInputHash !== executionPlanSubjectInputHash(mission)) fail();
  const operations = definition.operations.map((operation): z.infer<typeof changeSetOperationProgressSchema> => {
    const base = { operationId: operation.operationId, dependsOn: operation.dependsOn };
    const permit = store.getChangeSetOperationPermitForOperation(
      mission.id,
      record.manifestHash,
      operation.operationId
    );
    if (!permit) {
      const retained = db
        .prepare(
          `SELECT id FROM audit_events WHERE name = 'change_set.operation_permitted'
        AND json_extract(body, '$.missionId') = ? AND json_extract(body, '$.manifestHash') = ?
        AND json_extract(body, '$.operationId') = ?`
        )
        .get(mission.id, record.manifestHash, operation.operationId);
      if (retained) fail();
      return { ...base, status: "not_permitted" as const };
    }
    const child = store.get(permit.executionWorkItemId);
    if (!child || executionPlanSubjectInputHash(child) !== permit.executionInputHash) fail();
    const marker = child.requestedActions[0]?.params.changeSetBinding;
    if (
      strictCanonicalJsonV1(marker) !==
      strictCanonicalJsonV1({
        missionId: mission.id,
        manifestHash: record.manifestHash,
        operationId: operation.operationId,
        ...(permit.approvalId ? { approvalId: permit.approvalId } : { authorizationId: permit.authorizationId })
      })
    )
      fail();
    const row = db
      .prepare(`SELECT * FROM execution_attempts WHERE work_item_id = ? ORDER BY attempt_number DESC LIMIT 1`)
      .get(child.id) as { attempt_id: string } | undefined;
    const attempt = row ? executionAttemptSchema.parse(store.getAttempt(row.attempt_id)) : undefined;
    const binding = {
      ...base,
      permitId: permit.permitId,
      permitHash: permit.permitHash,
      executionWorkItemId: child.id,
      ...(attempt ? { attemptId: attempt.attemptId } : {})
    };
    if (child.status !== "succeeded") {
      const status =
        !attempt && child.status === "approved"
          ? "not_started"
          : ["unknown", "quarantined", "interrupted"].includes(attempt?.status ?? child.status)
            ? "needs_reconciliation"
            : ["running", "cancelling"].includes(child.status)
              ? "running"
              : ["failed", "cancelled", "rejected"].includes(child.status)
                ? "failed"
                : "blocked";
      return { ...binding, status };
    }
    if (!attempt || attempt.status !== "succeeded") fail();
    const accepted = db.prepare(`SELECT * FROM attempt_results WHERE attempt_id = ?`).get(attempt.attemptId) as
      Record<string, unknown> | undefined;
    const resultId = child.result?.resultId;
    const result = typeof resultId === "string" ? store.getExecutionResult(resultId) : undefined;
    if (!accepted || !result || result.workItemId !== child.id || result.outcome !== "succeeded") fail();
    const { resultId: _id, payloadHash, createdAt: _at, ...legacy } = result;
    void _id;
    void _at;
    const input = submitWorkResultSchema.parse({
      ...legacy,
      attemptId: attempt.attemptId,
      planHash: attempt.planHash,
      inputHash: attempt.inputHash,
      fencingEpoch: attempt.currentFencingEpoch
    });
    const plan = store.getCurrentExecutionPlan(child.id);
    const lease = db
      .prepare(
        `SELECT status, worker_id, fencing_epoch, plan_hash, input_hash, expires_at
      FROM attempt_leases WHERE lease_id = ? AND attempt_id = ? AND work_item_id = ?`
      )
      .get(input.leaseId, attempt.attemptId, child.id) as
      | {
          status: string;
          worker_id: string;
          fencing_epoch: number;
          plan_hash: string;
          input_hash: string;
          expires_at: string;
        }
      | undefined;
    if (
      !plan ||
      plan.planId !== attempt.planId ||
      plan.planHash !== attempt.planHash ||
      plan.subjectInputHash !== executionPlanSubjectInputHash(child) ||
      executionAttemptInputHash({
        workItemId: child.id,
        planHash: plan.planHash,
        subjectInputHash: plan.subjectInputHash,
        actionHash: input.actionHash,
        workspaceHash: stableHash({
          domain: "acs.attempt-workspace.v1",
          workItemId: child.id,
          cwd: child.target.cwd,
          repo: child.target.repo
        })
      }) !== attempt.inputHash ||
      !lease ||
      lease.status !== "consumed" ||
      lease.worker_id !== result.workerId ||
      lease.fencing_epoch !== attempt.currentFencingEpoch ||
      lease.plan_hash !== attempt.planHash ||
      lease.input_hash !== attempt.inputHash ||
      Date.parse(input.finishedAt) > Date.parse(lease.expires_at)
    )
      fail();
    if (
      hashResult(input) !== payloadHash ||
      accepted.payload_hash !== payloadHash ||
      accepted.work_item_id !== child.id ||
      accepted.lease_id !== result.leaseId ||
      accepted.worker_id !== result.workerId ||
      accepted.fencing_epoch !== input.fencingEpoch ||
      accepted.plan_hash !== input.planHash ||
      accepted.input_hash !== input.inputHash ||
      accepted.outcome !== "succeeded" ||
      child.result?.payloadHash !== payloadHash ||
      input.actionHash !== executionActionHash(child) ||
      attempt.claimedByWorkerId !== result.workerId ||
      input.simulationMetadata.simulated ||
      input.simulationMetadata.toolName !== permit.toolName ||
      input.simulationMetadata.executionMode !== permit.runtime ||
      input.simulationMetadata.invocationFingerprint !== permit.invocationHash ||
      Date.parse(input.startedAt) < Date.parse(permit.createdAt) ||
      Date.parse(input.finishedAt) > Date.parse(permit.expiresAt)
    )
      fail();
    // The attempt row is a second immutable result projection. Verify its full
    // payload too, so a tampered output there is not ignored during resume.
    const attemptInput = submitWorkResultSchema.parse({
      ...input,
      idempotencyKey: accepted.idempotency_key,
      startedAt: accepted.started_at,
      finishedAt: accepted.finished_at,
      exitCode: accepted.exit_code,
      summary: accepted.summary,
      ...(accepted.stdout === null ? { stdout: undefined } : { stdout: accepted.stdout }),
      ...(accepted.stderr === null ? { stderr: undefined } : { stderr: accepted.stderr }),
      structuredOutput: JSON.parse(String(accepted.structured_output_json)),
      error: accepted.error ?? undefined,
      resourceUsage:
        accepted.resource_usage_json === null ? undefined : JSON.parse(String(accepted.resource_usage_json)),
      simulationMetadata: JSON.parse(String(accepted.simulation_metadata_json))
    });
    if (hashResult(attemptInput) !== payloadHash) fail();
    const auditRow = db
      .prepare(
        `SELECT id FROM audit_events WHERE name = 'execution_attempt.result_accepted'
      AND json_extract(body, '$.attemptId') = ?`
      )
      .get(attempt.attemptId) as { id: string } | undefined;
    if (!auditRow) fail();
    const event = readVerifiedChangeSetAuthorityEvent(db, auditRow.id);
    if (
      event.body.workItemId !== child.id ||
      event.body.leaseId !== input.leaseId ||
      event.body.workerId !== input.workerId ||
      event.body.payloadHash !== payloadHash ||
      event.body.planHash !== input.planHash ||
      event.body.inputHash !== input.inputHash ||
      event.body.fencingEpoch !== input.fencingEpoch ||
      event.body.outcome !== "succeeded"
    )
      fail();
    const required = changeSetOperationVerification(record, operation.operationId);
    let evidenceManifestHash: string | undefined;
    if (required) {
      const requirement = store.getVerificationRequirement(attempt.attemptId);
      const decision = store.getVerificationDecision(attempt.attemptId);
      const evidence = decision
        ? store.getEvidenceManifest(decision.evidenceManifestHash)
        : store.getEvidenceManifestForAttempt(attempt.attemptId);
      if (
        !requirement ||
        requirement.policyVersion !== required.policyVersion ||
        requirement.reviewersRequired !== required.reviewersRequired ||
        strictCanonicalJsonV1(requirement.requirement) !== strictCanonicalJsonV1(required.requirement) ||
        (decision && decision.verificationPolicyVersion !== CHANGE_SET_VERIFICATION_POLICY) ||
        (evidence &&
          (evidence.attemptId !== attempt.attemptId ||
            evidence.workItemId !== child.id ||
            evidence.manifest.permitHash !== permit.permitHash ||
            evidence.manifest.manifestHash !== record.manifestHash ||
            evidence.manifest.submissionHash !== changeSetResultSubmissionHash(input) ||
            stableHash({ domain: "acs.change-set.evidence.v1", evidence: evidence.manifest }) !==
              evidence.manifestHash))
      )
        fail();
      if (evidence) {
        assertChangeSetEvidenceAudit(db, evidence);
        const observations = evidence.manifest.observations as Array<{ requirementId: string }>;
        const expectedIds = required.requirement.requirements
          .filter((rule) => rule.kind !== "independent_review")
          .map((rule) => rule.requirementId)
          .sort();
        if (!sameReview(observations.map((item) => item.requirementId).sort(), expectedIds)) fail();
      }
      if (!evidence || !decision)
        return {
          ...binding,
          status: "awaiting_verification",
          resultId: result.resultId,
          resultPayloadHash: payloadHash,
          resultAuditEventId: auditRow.id,
          ...(evidence ? { evidenceManifestHash: evidence.manifestHash } : {})
        };
      assertChangeSetEvidenceAudit(db, evidence);
      if (decision.outcome !== "attempt_accepted") return { ...binding, status: "blocked" };
      const reviewHashes = verifyChangeSetReviews(
        db,
        store,
        attempt.attemptId,
        evidence.manifestHash,
        required.reviewersRequired,
        [permit.executingActorId, input.workerId]
      );
      if (
        reviewHashes.length < required.reviewersRequired ||
        strictCanonicalJsonV1([...reviewHashes].sort()) !==
          strictCanonicalJsonV1([...decision.reviewFindingHashes].sort())
      )
        fail();
      const decisionRow = db
        .prepare(
          `SELECT id FROM audit_events WHERE name = 'verification.decision'
        AND json_extract(body, '$.attemptId') = ? ORDER BY sequence DESC LIMIT 1`
        )
        .get(attempt.attemptId) as { id: string } | undefined;
      if (
        !decisionRow ||
        strictCanonicalJsonV1(readVerifiedChangeSetAuthorityEvent(db, decisionRow.id).body) !==
          strictCanonicalJsonV1(decision)
      )
        fail();
      evidenceManifestHash = evidence.manifestHash;
    }
    return {
      ...binding,
      status: "succeeded" as const,
      resultId: result.resultId,
      resultPayloadHash: payloadHash,
      resultAuditEventId: auditRow.id,
      ...(evidenceManifestHash ? { evidenceManifestHash } : {})
    };
  });
  let completion: ChangeSetCompletion | undefined;
  if (mission.result?.schemaVersion === "acs.change-set.completion.v1") {
    completion = changeSetCompletionSchema.parse(mission.result);
    const { completionHash, auditEventId, ...core } = completion;
    const event = readVerifiedChangeSetAuthorityEvent(db, auditEventId);
    const authority =
      core.authorityKind === "human_approval"
        ? store.getChangeSetApproval(core.authorityId)
        : store.getGrantAuthorization(core.authorityId);
    if (
      !authority ||
      authority.missionId !== mission.id ||
      authority.manifestHash !== record.manifestHash ||
      authority.executingActorId !== core.executingActorId ||
      authority.policyHash !== core.policyHash
    )
      fail();
    for (const operation of operations) {
      const permit = store.getChangeSetOperationPermit(operation.permitId!);
      if (
        !permit ||
        (permit.approvalId ?? permit.authorizationId) !== core.authorityId ||
        permit.policyHash !== core.policyHash
      )
        fail();
    }
    if (
      mission.status !== "succeeded" ||
      core.missionId !== mission.id ||
      core.manifestHash !== record.manifestHash ||
      core.executingActorId !== definition.executingActorId ||
      changeSetCompletionHash(core) !== completionHash ||
      strictCanonicalJsonV1(core.operations) !== strictCanonicalJsonV1(operations) ||
      operations.some((operation) => operation.status !== "succeeded") ||
      event.name !== "change_set.completed" ||
      event.body.completionHash !== completionHash ||
      event.body.authorityId !== core.authorityId ||
      event.body.authorityKind !== core.authorityKind ||
      event.body.policyHash !== core.policyHash ||
      event.body.completedAt !== core.completedAt ||
      event.attributes["actor.id"] !== core.executingActorId ||
      event.body.missionId !== mission.id ||
      event.body.manifestHash !== record.manifestHash
    )
      fail();
    if (core.operationReceipts) {
      const source = changeSetProgressSchema.parse({
        schemaVersion: "acs.change-set.progress.v1",
        missionId: mission.id,
        manifestHash: record.manifestHash,
        revision: record.snapshot.revision,
        operations
      });
      const rebuilt = buildAuthoritativeCompletionReceipts(db, store, record, source);
      const expectedBundleHash = authoritativeReceiptBundleHash(rebuilt);
      if (
        strictCanonicalJsonV1(rebuilt) !== strictCanonicalJsonV1(core.operationReceipts) ||
        event.body.receiptBundleHash !== expectedBundleHash
      )
        fail();
    } else if (event.body.receiptBundleHash !== undefined) fail();
  } else if (mission.status === "succeeded") fail();
  return changeSetProgressSchema.parse({
    schemaVersion: "acs.change-set.progress.v1",
    missionId: mission.id,
    manifestHash: record.manifestHash,
    revision: record.snapshot.revision,
    operations,
    ...(completion ? { completion } : {})
  });
}
