import { createHash } from "node:crypto";
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
import { ControlStackError, createId, stableHash } from "@agent-control-stack/shared";
import { hashAttemptLeaseToken } from "./attempt.js";

/**
 * Persistence for advisor consultation. Completion reads dispositions, fence columns and the hash
 * inputs only (so every row is re-verified). The SQL below must not select guidance_text or decline_reason.
 */
export const ADVISOR_COMPLETION_DISPOSITION_SQL =
  "SELECT consultation_id, consultation_hash, subject_id, mission_id, subject_kind, checkpoint, disposition, " +
  "input_sha256, output_sha256, executor_model_id, advisor_model_id, created_at, attempt_id, lease_id, claim_token_hash " +
  "FROM advisor_consultations WHERE mission_id = ? AND subject_id = ? AND checkpoint = 'before_completion'";

export const ADVISOR_BINDING_HASH_DOMAIN = "acs:advisor-binding:v1" as const;
const ADVISOR_CLAIM_TOKEN_DOMAIN = "acs:advisor-claim-token:v1";

export function advisorClaimTokenHash(claimToken: string): string {
  return createHash("sha256").update(`${ADVISOR_CLAIM_TOKEN_DOMAIN}\n${claimToken}`).digest("hex");
}

/** Integrity hash over every binding field, including disabled_at. Re-verified on every read. */
export function advisorBindingHash(binding: Omit<AdvisorBinding, "bindingHash">): string {
  return createHash("sha256")
    .update(
      `${ADVISOR_BINDING_HASH_DOMAIN}\n${JSON.stringify({
        subjectId: binding.subjectId,
        missionId: binding.missionId,
        subjectKind: binding.subjectKind,
        executorModelId: binding.executorModelId,
        advisorModelId: binding.advisorModelId,
        advisorTransportModel: binding.advisorTransportModel,
        requireBeforeCompletion: binding.requireBeforeCompletion,
        createdAt: binding.createdAt,
        disabledAt: binding.disabledAt
      })}`
    )
    .digest("hex");
}

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
  bindingHash: string;
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
  /** Fence provenance (migration 074). Additive fields; the input contract is unchanged. */
  attemptId: string | null;
  leaseId: string | null;
  workerId: string;
  claimTokenHash: string | null;
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
  binding_hash: string | null;
}

/** Fails closed: a row whose stored hash does not match its fields (or has none, e.g. a 073 row) is refused. */
function rowToBinding(row: BindingRow): AdvisorBinding {
  if (row.require_before_completion !== 0 && row.require_before_completion !== 1) {
    throw new ControlStackError("advisor_binding_integrity_mismatch", "advisor binding failed its integrity check");
  }
  const fields = {
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
  const expected = advisorBindingHash(fields);
  if (!row.binding_hash || row.binding_hash !== expected) {
    throw new ControlStackError("advisor_binding_integrity_mismatch", "advisor binding failed its integrity check");
  }
  return { ...fields, bindingHash: expected };
}

function writeBindingHash(db: DatabaseSync, missionId: string, subjectId: string): void {
  const row = db
    .prepare(`SELECT * FROM advisor_bindings WHERE mission_id = ? AND subject_id = ?`)
    .get(missionId, subjectId) as BindingRow | undefined;
  if (!row) throw new ControlStackError("advisor_not_configured", "advisor binding is missing");
  const hash = advisorBindingHash({
    subjectId: row.subject_id,
    missionId: row.mission_id,
    subjectKind: row.subject_kind,
    executorModelId: row.executor_model_id,
    advisorModelId: row.advisor_model_id,
    advisorTransportModel: row.advisor_transport_model,
    requireBeforeCompletion: row.require_before_completion === 1,
    createdAt: row.created_at,
    disabledAt: row.disabled_at
  });
  db.prepare(`UPDATE advisor_bindings SET binding_hash = ? WHERE mission_id = ? AND subject_id = ?`).run(
    hash,
    missionId,
    subjectId
  );
}

/**
 * A binding may only name a mission its subject belongs to, so a binding cannot be used to read and send
 * another mission's flight record. A work item belongs to itself and to its lineage root; a mission unit's
 * subject id is derived from its mission id.
 */
function assertBindingOwnership(
  db: DatabaseSync,
  input: { subjectId: string; missionId: string; subjectKind: "work_item" | "mission_unit" }
): void {
  if (input.subjectKind === "mission_unit") {
    if (!input.subjectId.startsWith(`mission:${input.missionId}:unit:`)) {
      throw new ControlStackError("advisor_binding_mission_mismatch", "mission-unit binding names another mission");
    }
    return;
  }
  const item = db.prepare(`SELECT id, root_work_item_id FROM work_items WHERE id = ?`).get(input.subjectId) as
    { id: string; root_work_item_id: string | null } | undefined;
  if (!item) throw new ControlStackError("work_item_not_found", `work item not found: ${input.subjectId}`);
  if (input.missionId !== item.id && input.missionId !== item.root_work_item_id) {
    throw new ControlStackError("advisor_binding_mission_mismatch", "work item does not belong to the binding mission");
  }
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
  assertBindingOwnership(db, input);
  const now = input.now ?? new Date().toISOString();
  const transport = input.advisorTransportModel ?? paired.advisorModelId;
  // A row that fails its integrity check (tampered, or a pre-074 row without a hash) is never trusted;
  // an explicit, audited, privileged enable is the repair path and overwrites it with operator-supplied values.
  const rowExists = Boolean(
    db
      .prepare(`SELECT 1 FROM advisor_bindings WHERE mission_id = ? AND subject_id = ?`)
      .get(input.missionId, input.subjectId)
  );
  let existing: AdvisorBinding | undefined;
  try {
    existing = readAdvisorBinding(db, input.missionId, input.subjectId);
  } catch (error) {
    if (!(error instanceof ControlStackError) || error.code !== "advisor_binding_integrity_mismatch") throw error;
    existing = undefined;
  }
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
  if (rowExists) {
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
  writeBindingHash(db, input.missionId, input.subjectId);
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
  writeBindingHash(db, missionId, subjectId);
  return readAdvisorBinding(db, missionId, subjectId)!;
}

export interface CopyAdvisorBindingInput {
  parentMissionId: string;
  parentSubjectId: string;
  childMissionId: string;
  childSubjectId: string;
  childExecutorModelId?: string;
  now: string;
  /** Principal that caused the copy (worker, operator, system actor). Recorded on the audit event. */
  actorId?: string;
  /** Lease / claim provenance of the copy (lease id, claim fence, attempt id). Recorded on the audit event. */
  leaseProvenance?: Record<string, unknown>;
}

export interface CopyAdvisorBindingResult {
  status: "absent" | "copied" | "not_attached";
  code?: string;
  binding?: AdvisorBinding;
  /** Provenance callers must include on the audit event for a copied / not_attached outcome. */
  actorId?: string;
  leaseProvenance?: Record<string, unknown>;
}

export function copyAdvisorBinding(db: DatabaseSync, input: CopyAdvisorBindingInput): CopyAdvisorBindingResult {
  const provenance = { actorId: input.actorId, leaseProvenance: input.leaseProvenance };
  // Fails closed: a parent binding that does not verify throws, so admission/retry is refused instead of
  // producing a child that silently lacks the advisor requirement.
  const parent = readAdvisorBinding(db, input.parentMissionId, input.parentSubjectId);
  if (!parent || parent.disabledAt) return { status: "absent", ...provenance };
  let existing: AdvisorBinding | undefined;
  try {
    existing = readAdvisorBinding(db, input.childMissionId, input.childSubjectId);
  } catch (error) {
    if (!(error instanceof ControlStackError) || error.code !== "advisor_binding_integrity_mismatch") throw error;
    existing = undefined;
  }
  if (existing && !existing.disabledAt) return { status: "copied", binding: existing, ...provenance };
  const childExecutor = input.childExecutorModelId ?? parent.executorModelId;
  try {
    assertAdvisorPairing({ executorModelId: childExecutor, advisorModelId: parent.advisorModelId });
  } catch (error) {
    const code = error instanceof ControlStackError ? error.code : "advisor_pairing_rejected";
    return { status: "not_attached", code, ...provenance };
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
  return { status: "copied", binding, ...provenance };
}

export type AdvisorCompletionBlockCode =
  | "advisor_consultation_required"
  | "advisor_binding_ambiguous"
  | "advisor_binding_integrity_mismatch"
  | "advisor_consultation_integrity_mismatch";

interface CompletionRow {
  consultation_id: string;
  consultation_hash: string;
  subject_id: string;
  mission_id: string;
  subject_kind: "work_item" | "mission_unit";
  checkpoint: AdvisorCheckpoint;
  disposition: AdvisorDisposition;
  input_sha256: string;
  output_sha256: string;
  executor_model_id: string;
  advisor_model_id: string;
  created_at: string;
  attempt_id: string | null;
  lease_id: string | null;
  claim_token_hash: string | null;
}

type CurrentFence =
  | { kind: "attempt"; attemptId: string }
  | { kind: "lease"; leaseId: string }
  | { kind: "claim"; claimTokenHash: string };

/**
 * The attempt, lease or claim that is live for the subject right now. Evidence recorded under any other
 * attempt, lease or claim (for example before a retry) does not count. No live fence means no evidence counts.
 */
function currentSubjectFence(db: DatabaseSync, binding: AdvisorBinding): CurrentFence | undefined {
  if (binding.subjectKind === "work_item") {
    const attempts = db
      .prepare(`SELECT attempt_id FROM execution_attempts WHERE work_item_id = ? AND status = 'running'`)
      .all(binding.subjectId) as Array<{ attempt_id: string }>;
    if (attempts.length > 1) return undefined;
    if (attempts.length === 1) return { kind: "attempt", attemptId: attempts[0]!.attempt_id };
    const leases = db
      .prepare(`SELECT lease_id FROM leases WHERE work_item_id = ? AND status = 'active'`)
      .all(binding.subjectId) as Array<{ lease_id: string }>;
    return leases.length === 1 ? { kind: "lease", leaseId: leases[0]!.lease_id } : undefined;
  }
  const prefix = `mission:${binding.missionId}:unit:`;
  if (!binding.subjectId.startsWith(prefix)) return undefined;
  const unitId = binding.subjectId.slice(prefix.length);
  const row = db
    .prepare(`SELECT claim_token FROM coding_operations WHERE mission_id = ? AND operation_id = ?`)
    .get(binding.missionId, unitId) as { claim_token: string | null } | undefined;
  return row?.claim_token ? { kind: "claim", claimTokenHash: advisorClaimTokenHash(row.claim_token) } : undefined;
}

function rowMatchesFence(row: CompletionRow, fence: CurrentFence): boolean {
  if (fence.kind === "attempt") return row.attempt_id === fence.attemptId;
  if (fence.kind === "lease") return row.attempt_id === null && row.lease_id === fence.leaseId;
  return row.claim_token_hash === fence.claimTokenHash;
}

function consultationRowVerifies(row: CompletionRow): boolean {
  const expected = advisorConsultationHash({
    schemaVersion: ADVISOR_CONSULTATION_SCHEMA_VERSION,
    consultationId: row.consultation_id,
    subjectId: row.subject_id,
    missionId: row.mission_id,
    subjectKind: row.subject_kind,
    checkpoint: row.checkpoint,
    disposition: row.disposition,
    inputSha256: row.input_sha256,
    outputSha256: row.output_sha256,
    executorModelId: row.executor_model_id,
    advisorModelId: row.advisor_model_id,
    createdAt: row.created_at,
    attemptId: row.attempt_id,
    leaseId: row.lease_id,
    claimTokenHash: row.claim_token_hash
  });
  return expected === row.consultation_hash;
}

/**
 * The completion gate. Every terminal-success path for a work item or mission unit calls this. It fails
 * closed: a binding or consultation that does not verify blocks; only a `reviewed` before_completion
 * consultation recorded under the subject's live attempt/lease/claim satisfies it.
 */
export function advisorCompletionBlockReason(
  db: DatabaseSync,
  missionId: string,
  subjectId: string
): AdvisorCompletionBlockCode | undefined {
  let bindings: AdvisorBinding[];
  try {
    bindings = readAdvisorBindingsForSubject(db, subjectId).filter((binding) => binding.missionId === missionId);
  } catch (error) {
    if (error instanceof ControlStackError && error.code === "advisor_binding_integrity_mismatch") {
      return "advisor_binding_integrity_mismatch";
    }
    throw error;
  }
  if (bindings.length > 1) return "advisor_binding_ambiguous";
  const binding = bindings[0];
  if (!binding || binding.disabledAt || !binding.requireBeforeCompletion) return undefined;
  const rows = db.prepare(ADVISOR_COMPLETION_DISPOSITION_SQL).all(missionId, subjectId) as unknown as CompletionRow[];
  if (rows.some((row) => !consultationRowVerifies(row))) return "advisor_consultation_integrity_mismatch";
  const fence = currentSubjectFence(db, binding);
  const dispositions = fence ? rows.filter((row) => rowMatchesFence(row, fence)).map((row) => row.disposition) : [];
  return advisorCompletionBlock({ requireBeforeCompletion: true, dispositions });
}

/** Every binding on a subject (any mission) must verify and, where required, be satisfied. */
export function advisorSubjectCompletionBlockReason(
  db: DatabaseSync,
  subjectId: string
): AdvisorCompletionBlockCode | undefined {
  let bindings: AdvisorBinding[];
  try {
    bindings = readAdvisorBindingsForSubject(db, subjectId);
  } catch (error) {
    if (error instanceof ControlStackError && error.code === "advisor_binding_integrity_mismatch") {
      return "advisor_binding_integrity_mismatch";
    }
    throw error;
  }
  for (const binding of bindings) {
    if (binding.disabledAt) continue;
    const code = advisorCompletionBlockReason(db, binding.missionId, subjectId);
    if (code) return code;
  }
  return undefined;
}

export interface AdvisorFence {
  kind: "work_item";
  workItemId: string;
  attemptId?: string;
  leaseId: string;
  /**
   * Proof of lease possession. Optional for in-process privileged callers (the input contract of
   * insertAdvisorConsultation is unchanged); when present it must match the stored lease token hash.
   * The gateway MCP path always requires and passes it.
   */
  leaseToken?: string;
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

export interface AdvisorFenceProvenance {
  attemptId: string | null;
  leaseId: string | null;
  workerId: string;
  claimTokenHash: string | null;
}

export function assertAdvisorConsultationLease(db: DatabaseSync, input: AdvisorLeaseAssertion): AdvisorFenceProvenance {
  const nowIso = input.now ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(nowIso))) {
    throw new ControlStackError("advisor_lease_stale", "consultation time is not a valid timestamp");
  }
  if (input.fence.kind === "work_item") {
    if (input.subjectKind !== "work_item" || input.subjectId !== input.fence.workItemId) {
      throw new ControlStackError("advisor_lease_stale", "consultation subject does not match the work-item lease");
    }
    const attemptId = assertWorkItemFence(db, input.fence, nowIso);
    return { attemptId, leaseId: input.fence.leaseId, workerId: input.fence.workerId, claimTokenHash: null };
  }
  if (
    input.subjectKind !== "mission_unit" ||
    input.missionId !== input.fence.missionId ||
    input.subjectId !== missionUnitSubjectId(input.fence.missionId, input.fence.unitId)
  ) {
    throw new ControlStackError("advisor_lease_stale", "consultation subject does not match the mission claim");
  }
  assertMissionFence(db, input.fence);
  return {
    attemptId: null,
    leaseId: null,
    workerId: input.fence.workerId,
    claimTokenHash: advisorClaimTokenHash(input.fence.claimToken)
  };
}

/** Unparseable or non-finite expiry is treated as expired (fail closed). */
function leaseExpired(expiresAt: string, nowIso: string): boolean {
  const expires = Date.parse(expiresAt);
  const now = Date.parse(nowIso);
  return !Number.isFinite(expires) || !Number.isFinite(now) || expires <= now;
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

function assertWorkItemFence(db: DatabaseSync, fence: AdvisorFence, nowIso: string): string | null {
  const attempt = db.prepare(`SELECT * FROM attempt_leases WHERE lease_id = ?`).get(fence.leaseId) as
    | {
        attempt_id: string;
        work_item_id: string;
        worker_id: string;
        fencing_epoch: number;
        expires_at: string;
        status: string;
        token_hash: string;
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
      leaseExpired(attempt.expires_at, nowIso) ||
      (fence.leaseToken !== undefined && attempt.token_hash !== hashAttemptLeaseToken(fence.leaseToken)) ||
      !running ||
      running.status !== "running" ||
      running.current_fencing_epoch !== fence.fencingEpoch ||
      running.claimed_by_worker_id !== fence.workerId
    ) {
      throw new ControlStackError("advisor_lease_stale", "attempt lease does not fence this consultation");
    }
    return attempt.attempt_id;
  }
  if (fence.fencingEpoch !== 0) {
    throw new ControlStackError("advisor_lease_stale", "attempt fence does not match an active lease");
  }
  const legacy = db.prepare(`SELECT * FROM leases WHERE lease_id = ?`).get(fence.leaseId) as
    { work_item_id: string; worker_id: string; status: string; expires_at: string; token_hash: string } | undefined;
  const item = db.prepare(`SELECT status, worker_id FROM work_items WHERE id = ?`).get(fence.workItemId) as
    { status: string; worker_id: string | null } | undefined;
  if (
    !legacy ||
    legacy.status !== "active" ||
    legacy.work_item_id !== fence.workItemId ||
    legacy.worker_id !== fence.workerId ||
    leaseExpired(legacy.expires_at, nowIso) ||
    (fence.leaseToken !== undefined &&
      legacy.token_hash !==
        stableHash({ leaseToken: fence.leaseToken, workItemId: fence.workItemId, workerId: fence.workerId })) ||
    !item ||
    item.status !== "running" ||
    item.worker_id !== fence.workerId
  ) {
    throw new ControlStackError("advisor_lease_stale", "worker lease does not fence this consultation");
  }
  return null;
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
  const provenance = assertAdvisorConsultationLease(db, { ...input, now: createdAt });
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
    createdAt,
    attemptId: provenance.attemptId,
    leaseId: provenance.leaseId,
    claimTokenHash: provenance.claimTokenHash
  };
  const consultationHash = advisorConsultationHash(view);
  db.prepare(
    `INSERT INTO advisor_consultations
     (consultation_id, consultation_hash, subject_id, mission_id, subject_kind, checkpoint, disposition,
      input_sha256, output_sha256, guidance_text, decline_reason, error_code, executor_model_id, advisor_model_id,
      input_tokens, output_tokens, created_at, attempt_id, lease_id, claim_token_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    createdAt,
    provenance.attemptId,
    provenance.leaseId,
    provenance.claimTokenHash
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
    createdAt,
    attemptId: provenance.attemptId,
    leaseId: provenance.leaseId,
    workerId: provenance.workerId,
    claimTokenHash: provenance.claimTokenHash
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
    outputTokens: record.outputTokens,
    attemptId: record.attemptId,
    leaseId: record.leaseId,
    workerId: record.workerId,
    claimTokenHash: record.claimTokenHash
  };
}
