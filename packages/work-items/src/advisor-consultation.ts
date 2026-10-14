import type { DatabaseSync } from "node:sqlite";
import {
  ADVISOR_CONSULTATION_SCHEMA_VERSION,
  advisorCompletionBlock,
  advisorConsultationHash,
  advisorOutputDigest,
  assertAdvisorPairing,
  missionUnitSubjectId,
  type AdvisorCheckpoint,
  type AdvisorConsultationView,
  type AdvisorDisposition
} from "@agent-control-stack/advisory";
import { ControlStackError, createId } from "@agent-control-stack/shared";

/**
 * Persistence for advisor consultation. Completion reads dispositions only.
 * The SQL below must not select guidance_text or decline_reason.
 */
export const ADVISOR_COMPLETION_DISPOSITION_SQL =
  "SELECT disposition FROM advisor_consultations WHERE mission_id = ? AND subject_id = ? AND checkpoint = 'before_completion'";

export interface AdvisorBinding {
  subjectId: string;
  missionId: string;
  subjectKind: "work_item" | "mission_unit";
  executorModelId: string;
  advisorModelId: string;
  advisorTransportModel: string;
  requireBeforeCompletion: boolean;
  createdAt: string;
  disabledAt: string | null;
}

export interface AdvisorConsultationRecord {
  consultationId: string;
  consultationHash: string;
  subjectId: string;
  missionId: string;
  subjectKind: "work_item" | "mission_unit";
  checkpoint: AdvisorCheckpoint;
  disposition: AdvisorDisposition;
  inputSha256: string;
  outputSha256: string;
  guidanceText: string | null;
  declineReason: string | null;
  errorCode: string | null;
  executorModelId: string;
  advisorModelId: string;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: string;
}

export interface EnableAdvisorBindingInput {
  subjectId: string;
  missionId: string;
  subjectKind: "work_item" | "mission_unit";
  executorModelId: string;
  advisorModelId: string;
  advisorTransportModel?: string;
  requireBeforeCompletion: boolean;
  allowedAdvisorModels?: readonly string[];
  now?: string;
}

interface BindingRow {
  subject_id: string;
  mission_id: string;
  subject_kind: "work_item" | "mission_unit";
  executor_model_id: string;
  advisor_model_id: string;
  advisor_transport_model: string;
  require_before_completion: number;
  created_at: string;
  disabled_at: string | null;
}

function rowToBinding(row: BindingRow): AdvisorBinding {
  return {
    subjectId: row.subject_id,
    missionId: row.mission_id,
    subjectKind: row.subject_kind,
    executorModelId: row.executor_model_id,
    advisorModelId: row.advisor_model_id,
    advisorTransportModel: row.advisor_transport_model,
    requireBeforeCompletion: row.require_before_completion === 1,
    createdAt: row.created_at,
    disabledAt: row.disabled_at
  };
}

export function readAdvisorBinding(db: DatabaseSync, missionId: string, subjectId: string): AdvisorBinding | undefined {
  const row = db
    .prepare(`SELECT * FROM advisor_bindings WHERE mission_id = ? AND subject_id = ?`)
    .get(missionId, subjectId) as BindingRow | undefined;
  return row ? rowToBinding(row) : undefined;
}

export function readAdvisorBindingsForSubject(db: DatabaseSync, subjectId: string): AdvisorBinding[] {
  const rows = db
    .prepare(`SELECT * FROM advisor_bindings WHERE subject_id = ?`)
    .all(subjectId) as unknown as BindingRow[];
  return rows.map(rowToBinding);
}

export function enableAdvisorBinding(db: DatabaseSync, input: EnableAdvisorBindingInput): AdvisorBinding {
  const paired = assertAdvisorPairing({
    executorModelId: input.executorModelId,
    advisorModelId: input.advisorModelId,
    allowedAdvisorModels: input.allowedAdvisorModels
  });
  const now = input.now ?? new Date().toISOString();
  const transport = input.advisorTransportModel ?? paired.advisorModelId;
  const existing = readAdvisorBinding(db, input.missionId, input.subjectId);
  if (existing && !existing.disabledAt) {
    if (
      existing.executorModelId === paired.executorModelId &&
      existing.advisorModelId === paired.advisorModelId &&
      existing.advisorTransportModel === transport &&
      existing.requireBeforeCompletion === input.requireBeforeCompletion
    ) {
      return existing;
    }
    throw new ControlStackError("advisor_binding_conflict", "an advisor binding is already enabled for this subject");
  }
  if (existing) {
    db.prepare(
      `UPDATE advisor_bindings
       SET subject_kind = ?, executor_model_id = ?, advisor_model_id = ?, advisor_transport_model = ?,
           require_before_completion = ?, created_at = ?, disabled_at = NULL
       WHERE mission_id = ? AND subject_id = ?`
    ).run(
      input.subjectKind,
      paired.executorModelId,
      paired.advisorModelId,
      transport,
      input.requireBeforeCompletion ? 1 : 0,
      now,
      input.missionId,
      input.subjectId
    );
  } else {
    db.prepare(
      `INSERT INTO advisor_bindings
       (subject_id, mission_id, subject_kind, executor_model_id, advisor_model_id, advisor_transport_model,
        require_before_completion, created_at, disabled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    ).run(
      input.subjectId,
      input.missionId,
      input.subjectKind,
      paired.executorModelId,
      paired.advisorModelId,
      transport,
      input.requireBeforeCompletion ? 1 : 0,
      now
    );
  }
  return readAdvisorBinding(db, input.missionId, input.subjectId)!;
}

export function disableAdvisorBinding(
  db: DatabaseSync,
  missionId: string,
  subjectId: string,
  now: string
): AdvisorBinding {
  const existing = readAdvisorBinding(db, missionId, subjectId);
  if (!existing || existing.disabledAt) {
    throw new ControlStackError("advisor_not_configured", "no active advisor binding to disable");
  }
  db.prepare(
    `UPDATE advisor_bindings SET disabled_at = ? WHERE mission_id = ? AND subject_id = ? AND disabled_at IS NULL`
  ).run(now, missionId, subjectId);
  return readAdvisorBinding(db, missionId, subjectId)!;
}

export interface CopyAdvisorBindingInput {
  parentMissionId: string;
  parentSubjectId: string;
  childMissionId: string;
  childSubjectId: string;
  childExecutorModelId?: string;
  now: string;
}

export function copyAdvisorBinding(
  db: DatabaseSync,
  input: CopyAdvisorBindingInput
): { status: "absent" | "copied" | "not_attached"; code?: string; binding?: AdvisorBinding } {
  const parent = readAdvisorBinding(db, input.parentMissionId, input.parentSubjectId);
  if (!parent || parent.disabledAt) return { status: "absent" };
  const existing = readAdvisorBinding(db, input.childMissionId, input.childSubjectId);
  if (existing && !existing.disabledAt) return { status: "copied", binding: existing };
  const childExecutor = input.childExecutorModelId ?? parent.executorModelId;
  try {
    assertAdvisorPairing({ executorModelId: childExecutor, advisorModelId: parent.advisorModelId });
  } catch (error) {
    const code = error instanceof ControlStackError ? error.code : "advisor_pairing_rejected";
    return { status: "not_attached", code };
  }
  const binding = enableAdvisorBinding(db, {
    subjectId: input.childSubjectId,
    missionId: input.childMissionId,
    subjectKind: parent.subjectKind,
    executorModelId: childExecutor,
    advisorModelId: parent.advisorModelId,
    advisorTransportModel: parent.advisorTransportModel,
    requireBeforeCompletion: parent.requireBeforeCompletion,
    now: input.now
  });
  return { status: "copied", binding };
}

export function advisorCompletionBlockReason(
  db: DatabaseSync,
  missionId: string,
  subjectId: string
): "advisor_consultation_required" | "advisor_binding_ambiguous" | undefined {
  const bindings = readAdvisorBindingsForSubject(db, subjectId).filter((binding) => binding.missionId === missionId);
  if (bindings.length > 1) return "advisor_binding_ambiguous";
  const binding = bindings[0];
  if (!binding || binding.disabledAt || !binding.requireBeforeCompletion) return undefined;
  const rows = db.prepare(ADVISOR_COMPLETION_DISPOSITION_SQL).all(missionId, subjectId) as Array<{
    disposition: AdvisorDisposition;
  }>;
  return advisorCompletionBlock({
    requireBeforeCompletion: true,
    dispositions: rows.map((row) => row.disposition)
  });
}

export interface AdvisorFence {
  kind: "work_item";
  workItemId: string;
  attemptId?: string;
  leaseId: string;
  workerId: string;
  fencingEpoch: number;
}

export interface MissionClaimFence {
  kind: "mission_unit";
  missionId: string;
  unitId: string;
  workerId: string;
  claimToken: string;
}

export interface AdvisorLeaseAssertion {
  subjectId: string;
  missionId: string;
  subjectKind: "work_item" | "mission_unit";
  fence: AdvisorFence | MissionClaimFence;
  now?: string;
}

export function assertAdvisorConsultationLease(db: DatabaseSync, input: AdvisorLeaseAssertion): void {
  const nowIso = input.now ?? new Date().toISOString();
  if (input.fence.kind === "work_item") {
    if (input.subjectKind !== "work_item" || input.subjectId !== input.fence.workItemId) {
      throw new ControlStackError("advisor_lease_stale", "consultation subject does not match the work-item lease");
    }
    assertWorkItemFence(db, input.fence, nowIso);
    return;
  }
  if (
    input.subjectKind !== "mission_unit" ||
    input.missionId !== input.fence.missionId ||
    input.subjectId !== missionUnitSubjectId(input.fence.missionId, input.fence.unitId)
  ) {
    throw new ControlStackError("advisor_lease_stale", "consultation subject does not match the mission claim");
  }
  assertMissionFence(db, input.fence);
}

export interface RecordAdvisorConsultationInput {
  subjectId: string;
  missionId: string;
  subjectKind: "work_item" | "mission_unit";
  checkpoint: AdvisorCheckpoint;
  disposition: AdvisorDisposition;
  inputSha256: string;
  guidanceText: string | null;
  declineReason: string | null;
  errorCode: string | null;
  executorModelId: string;
  advisorModelId: string;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt?: string;
  fence: AdvisorFence | MissionClaimFence;
}

function assertWorkItemFence(db: DatabaseSync, fence: AdvisorFence, nowIso: string): void {
  const attempt = db.prepare(`SELECT * FROM attempt_leases WHERE lease_id = ?`).get(fence.leaseId) as
    | {
        attempt_id: string;
        work_item_id: string;
        worker_id: string;
        fencing_epoch: number;
        expires_at: string;
        status: string;
      }
    | undefined;
  if (attempt) {
    const running = db
      .prepare(
        `SELECT status, current_fencing_epoch, claimed_by_worker_id FROM execution_attempts WHERE attempt_id = ?`
      )
      .get(attempt.attempt_id) as
      { status: string; current_fencing_epoch: number; claimed_by_worker_id: string } | undefined;
    if (
      attempt.status !== "active" ||
      attempt.work_item_id !== fence.workItemId ||
      attempt.worker_id !== fence.workerId ||
      attempt.fencing_epoch !== fence.fencingEpoch ||
      (fence.attemptId !== undefined && attempt.attempt_id !== fence.attemptId) ||
      Date.parse(attempt.expires_at) <= Date.parse(nowIso) ||
      !running ||
      running.status !== "running" ||
      running.current_fencing_epoch !== fence.fencingEpoch ||
      running.claimed_by_worker_id !== fence.workerId
    ) {
      throw new ControlStackError("advisor_lease_stale", "attempt lease does not fence this consultation");
    }
    return;
  }
  if (fence.fencingEpoch !== 0) {
    throw new ControlStackError("advisor_lease_stale", "attempt fence does not match an active lease");
  }
  const legacy = db.prepare(`SELECT * FROM leases WHERE lease_id = ?`).get(fence.leaseId) as
    { work_item_id: string; worker_id: string; status: string; expires_at: string } | undefined;
  const item = db.prepare(`SELECT status, worker_id FROM work_items WHERE id = ?`).get(fence.workItemId) as
    { status: string; worker_id: string | null } | undefined;
  if (
    !legacy ||
    legacy.status !== "active" ||
    legacy.work_item_id !== fence.workItemId ||
    legacy.worker_id !== fence.workerId ||
    Date.parse(legacy.expires_at) <= Date.parse(nowIso) ||
    !item ||
    item.status !== "running" ||
    item.worker_id !== fence.workerId
  ) {
    throw new ControlStackError("advisor_lease_stale", "worker lease does not fence this consultation");
  }
}

function assertMissionFence(db: DatabaseSync, fence: MissionClaimFence): void {
  const row = db
    .prepare(`SELECT worker_id, claim_token, status FROM coding_operations WHERE mission_id = ? AND operation_id = ?`)
    .get(fence.missionId, fence.unitId) as
    { worker_id: string | null; claim_token: string | null; status: string } | undefined;
  if (
    !row ||
    row.worker_id !== fence.workerId ||
    row.claim_token !== fence.claimToken ||
    (row.status !== "running" && row.status !== "checkpointed")
  ) {
    throw new ControlStackError("advisor_lease_stale", "mission claim does not fence this consultation");
  }
}

function materialFor(input: RecordAdvisorConsultationInput): string {
  if (input.disposition === "reviewed") {
    if (!input.guidanceText || input.declineReason || input.errorCode) {
      throw new ControlStackError("advisor_output_invalid", "reviewed consultations require guidance only");
    }
    return input.guidanceText;
  }
  if (input.disposition === "declined") {
    if (!input.declineReason || input.guidanceText || input.errorCode) {
      throw new ControlStackError("advisor_output_invalid", "declined consultations require a reason only");
    }
    return input.declineReason;
  }
  if (!input.errorCode || input.guidanceText || input.declineReason) {
    throw new ControlStackError("advisor_output_invalid", "unavailable consultations require an error code only");
  }
  return input.errorCode;
}

export function insertAdvisorConsultation(
  db: DatabaseSync,
  input: RecordAdvisorConsultationInput
): AdvisorConsultationRecord {
  const createdAt = input.createdAt ?? new Date().toISOString();
  assertAdvisorConsultationLease(db, { ...input, now: createdAt });
  const binding = readAdvisorBinding(db, input.missionId, input.subjectId);
  if (!binding || binding.disabledAt) {
    throw new ControlStackError("advisor_not_configured", "advisor consultation requires an active binding");
  }
  if (binding.executorModelId !== input.executorModelId || binding.advisorModelId !== input.advisorModelId) {
    throw new ControlStackError("advisor_pairing_rejected", "consultation models do not match the binding");
  }
  const material = materialFor(input);
  const outputSha256 = advisorOutputDigest(input.disposition, material);
  const consultationId = createId("adv");
  const view: AdvisorConsultationView = {
    schemaVersion: ADVISOR_CONSULTATION_SCHEMA_VERSION,
    consultationId,
    subjectId: input.subjectId,
    missionId: input.missionId,
    subjectKind: input.subjectKind,
    checkpoint: input.checkpoint,
    disposition: input.disposition,
    inputSha256: input.inputSha256,
    outputSha256,
    executorModelId: input.executorModelId,
    advisorModelId: input.advisorModelId,
    createdAt
  };
  const consultationHash = advisorConsultationHash(view);
  db.prepare(
    `INSERT INTO advisor_consultations
     (consultation_id, consultation_hash, subject_id, mission_id, subject_kind, checkpoint, disposition,
      input_sha256, output_sha256, guidance_text, decline_reason, error_code, executor_model_id, advisor_model_id,
      input_tokens, output_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    consultationId,
    consultationHash,
    input.subjectId,
    input.missionId,
    input.subjectKind,
    input.checkpoint,
    input.disposition,
    input.inputSha256,
    outputSha256,
    input.guidanceText,
    input.declineReason,
    input.errorCode,
    input.executorModelId,
    input.advisorModelId,
    input.inputTokens,
    input.outputTokens,
    createdAt
  );
  return {
    consultationId,
    consultationHash,
    subjectId: input.subjectId,
    missionId: input.missionId,
    subjectKind: input.subjectKind,
    checkpoint: input.checkpoint,
    disposition: input.disposition,
    inputSha256: input.inputSha256,
    outputSha256,
    guidanceText: input.guidanceText,
    declineReason: input.declineReason,
    errorCode: input.errorCode,
    executorModelId: input.executorModelId,
    advisorModelId: input.advisorModelId,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    createdAt
  };
}

export function advisorAuditView(record: AdvisorConsultationRecord): Record<string, unknown> {
  return {
    consultationId: record.consultationId,
    consultationHash: record.consultationHash,
    subjectId: record.subjectId,
    missionId: record.missionId,
    subjectKind: record.subjectKind,
    checkpoint: record.checkpoint,
    disposition: record.disposition,
    inputSha256: record.inputSha256,
    outputSha256: record.outputSha256,
    errorCode: record.errorCode,
    executorModelId: record.executorModelId,
    advisorModelId: record.advisorModelId,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens
  };
}
