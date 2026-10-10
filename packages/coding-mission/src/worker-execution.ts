import { ControlStackError, stableHash } from "@agent-control-stack/shared";
import type { CodingMissionPorts } from "./controller.js";
import type { FailureCategory, WorkUnitKind, WorkUnitPayload, VerificationPolicy } from "./mission-model.js";
import type { CodingMissionStore } from "./store.js";

export const EXECUTOR_LANES = ["coder", "jc", "dc", "mcp"] as const;
export type ExecutorLane = (typeof EXECUTOR_LANES)[number];

export interface ExecutionAuthorityRefs {
  grantId?: string;
  permitId?: string;
  leaseId?: string;
  fencingToken?: number;
  actionHash?: string;
  /** Hash of the unit's derived authority definition, set by ACS (never the caller) for governed missions. */
  unitAuthorityHash?: string;
}

/** The outcome of checking a dispatch against the authority the mission was granted. */
export type DispatchAuthorityVerdict =
  | { ok: true; grantId: string; unitAuthorityHash: string; executingActorId: string }
  | { ok: false; reason: string };

/**
 * Decides whether a worker may run a unit on a lane right now. `MissionAuthorityLedger` implements it. It must read
 * durable state and ACS's own clock, and return a refusal for anything it cannot prove.
 */
export interface DispatchAuthorityVerifier {
  verifyDispatch(input: {
    missionId: string;
    unitId: string;
    workerId: string;
    lane: ExecutorLane;
    attempt: number;
  }): DispatchAuthorityVerdict;
}

export interface DispatchEnvelope {
  schemaVersion: "acs.work-unit-dispatch.v1";
  attemptId: string;
  missionId: string;
  unitId: string;
  unitAttempt: number;
  unitKind: WorkUnitKind;
  verificationPolicy: VerificationPolicy;
  workerId: string;
  implementerEngineId: string;
  lane: ExecutorLane;
  claimTokenHash: string;
  payloadHash: string;
  routeHash: string;
  payload?: WorkUnitPayload;
  authority: ExecutionAuthorityRefs;
  issuedAt: string;
}

export interface ExecutionReceipt {
  kind: string;
  hash: string;
}

export interface NormalizedExecutionFailure {
  category: FailureCategory;
  nativeCode?: string;
  nativeMessage?: string;
  retrySafe: boolean;
}

export type ExecutionOutcome = "succeeded" | "failed" | "cancelled" | "unknown";

export interface ResultEnvelope {
  schemaVersion: "acs.work-unit-result.v1";
  attemptId: string;
  missionId: string;
  unitId: string;
  unitAttempt: number;
  workerId: string;
  lane: ExecutorLane;
  claimTokenHash: string;
  outcome: ExecutionOutcome;
  startedAt: string;
  finishedAt: string;
  receipts: ExecutionReceipt[];
  result?: {
    resultHash: string;
    files: string[];
  };
  failure?: NormalizedExecutionFailure;
  externalStateUncertain: boolean;
}

export interface ExecutionAttemptRecord {
  attemptId: string;
  missionId: string;
  unitId: string;
  unitAttempt: number;
  workerId: string;
  implementerEngineId: string;
  lane: ExecutorLane;
  claimTokenHash: string;
  dispatchHash: string;
  dispatch: DispatchEnvelope;
  authority: ExecutionAuthorityRefs;
  state: "started" | "succeeded" | "failed" | "cancelled" | "unknown" | "rejected_stale";
  startedAt: string;
  finishedAt?: string;
  resultHash?: string;
  failureCategory?: FailureCategory;
  reportHash?: string;
  report?: ResultEnvelope;
  receipts: ExecutionReceipt[];
}

export type ApplyResult =
  | { applied: "completed" | "awaiting_verification" | "failed" | "retryable" | "cancelled" | "unknown" | "duplicate" }
  | { applied: "rejected_stale" | "rejected_invalid"; reason: string };

interface AttemptRow {
  attempt_id: string;
  mission_id: string;
  unit_id: string;
  unit_attempt: number;
  worker_id: string;
  implementer_engine_id: string | null;
  executor_lane: ExecutorLane;
  claim_token_hash: string;
  dispatch_hash: string;
  dispatch_json: string;
  authority_json: string;
  state: ExecutionAttemptRecord["state"];
  started_at: string;
  finished_at: string | null;
  result_hash: string | null;
  failure_category: FailureCategory | null;
  report_hash: string | null;
  report_json: string | null;
}

const TERMINAL_ATTEMPT_STATES = new Set<ExecutionAttemptRecord["state"]>([
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
  "rejected_stale"
]);

function boundedText(value: string, max = 500): string {
  const scrubbed = value
    .replace(/authorization\s*[:=]\s*[^\s]+/giu, "authorization=[redacted]")
    .replace(/(?:token|password|secret)\s*[:=]\s*[^\s]+/giu, "[redacted]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/gu, "[redacted]");
  return scrubbed.slice(0, max);
}

function implementerEngineIdFromRoute(route: unknown): string | undefined {
  if (!route || typeof route !== "object" || Array.isArray(route)) return undefined;
  const value = (route as Record<string, unknown>).implementerEngineId;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 128 ? normalized : undefined;
}

function normalizedAuthority(authority: ExecutionAuthorityRefs | undefined): ExecutionAuthorityRefs {
  if (!authority) return {};
  return {
    ...(typeof authority.grantId === "string" ? { grantId: authority.grantId } : {}),
    ...(typeof authority.permitId === "string" ? { permitId: authority.permitId } : {}),
    ...(typeof authority.leaseId === "string" ? { leaseId: authority.leaseId } : {}),
    ...(typeof authority.fencingToken === "number" && Number.isInteger(authority.fencingToken)
      ? { fencingToken: authority.fencingToken }
      : {}),
    ...(typeof authority.actionHash === "string" ? { actionHash: authority.actionHash } : {}),
    ...(typeof authority.unitAuthorityHash === "string" ? { unitAuthorityHash: authority.unitAuthorityHash } : {})
  };
}

export function failureCategoryForCode(code?: string, message?: string): FailureCategory {
  const value = `${code ?? ""} ${message ?? ""}`.toLowerCase();
  if (/policy|unauthor|forbidden|denied/u.test(value)) return "policy_denied";
  if (/lease.*expir|authority.*expir/u.test(value)) return "authority_expired";
  if (/lease.*lost|fenc|claim.*conflict|stale.*worker/u.test(value)) return "lease_lost";
  if (/timeout|timed out/u.test(value)) return "timeout";
  if (/econn|enotfound|unavailable|connect|spawn/u.test(value)) return "worker_unavailable";
  if (/conflict|stale_head|environment/u.test(value)) return "environment_changed";
  if (/cancel|abort/u.test(value)) return "cancelled";
  if (/invalid|malformed|parse/u.test(value)) return "invalid_output";
  return "tool_failure";
}

function resultBase(dispatch: DispatchEnvelope, now: string): Omit<ResultEnvelope, "outcome" | "receipts" | "externalStateUncertain"> {
  return {
    schemaVersion: "acs.work-unit-result.v1",
    attemptId: dispatch.attemptId,
    missionId: dispatch.missionId,
    unitId: dispatch.unitId,
    unitAttempt: dispatch.unitAttempt,
    workerId: dispatch.workerId,
    lane: dispatch.lane,
    claimTokenHash: dispatch.claimTokenHash,
    startedAt: dispatch.issuedAt,
    finishedAt: now
  };
}

export interface WorkUnitExecutorAdapter {
  readonly lane: ExecutorLane;
  execute(dispatch: DispatchEnvelope, signal?: AbortSignal): Promise<ResultEnvelope>;
}

export class CoderExecutionAdapter implements WorkUnitExecutorAdapter {
  readonly lane = "coder" as const;

  constructor(
    private readonly store: CodingMissionStore,
    private readonly coder: CodingMissionPorts["coder"],
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async execute(dispatch: DispatchEnvelope, signal?: AbortSignal): Promise<ResultEnvelope> {
    if (dispatch.lane !== this.lane) {
      throw new ControlStackError("execution_lane_mismatch", `coder adapter cannot execute ${dispatch.lane}`);
    }
    if (signal?.aborted) {
      return {
        ...resultBase(dispatch, this.now()),
        outcome: "cancelled",
        receipts: [],
        failure: { category: "cancelled", retrySafe: false },
        externalStateUncertain: false
      };
    }
    const mission = this.store.require(dispatch.missionId);
    try {
      const outcome = await this.coder.execute({
        mission,
        operationId: dispatch.unitId,
        workerId: dispatch.workerId
      });
      const finishedAt = this.now();
      if (outcome.status === "succeeded" && outcome.value) {
        return {
          ...resultBase(dispatch, finishedAt),
          outcome: "succeeded",
          receipts: [{ kind: "coder_result", hash: outcome.value.resultHash }],
          result: { resultHash: outcome.value.resultHash, files: [...outcome.value.files] },
          externalStateUncertain: false
        };
      }
      if (outcome.status === "unknown") {
        return {
          ...resultBase(dispatch, finishedAt),
          outcome: "unknown",
          receipts: [],
          externalStateUncertain: true
        };
      }
      const category =
        outcome.status === "rejected" && outcome.code === "conflict"
          ? "environment_changed"
          : outcome.status === "absent"
            ? "invalid_output"
            : failureCategoryForCode(outcome.code);
      return {
        ...resultBase(dispatch, finishedAt),
        outcome: "failed",
        receipts: [],
        failure: {
          category,
          ...(outcome.code ? { nativeCode: boundedText(outcome.code) } : {}),
          retrySafe: false
        },
        externalStateUncertain: outcome.status !== "absent"
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code =
        error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
      return {
        ...resultBase(dispatch, this.now()),
        outcome: "failed",
        receipts: [],
        failure: {
          category: failureCategoryForCode(code, message),
          ...(code ? { nativeCode: boundedText(code) } : {}),
          nativeMessage: boundedText(message),
          retrySafe: false
        },
        externalStateUncertain: true
      };
    }
  }
}

export interface ToolLaneOutcome {
  ok: boolean;
  resultHash?: string;
  files?: string[];
  receiptKind?: string;
  receiptHash?: string;
  errorCode?: string;
  errorMessage?: string;
  retrySafe?: boolean;
  externalStateUncertain?: boolean;
}

export type ToolLaneInvoker = (input: {
  dispatch: DispatchEnvelope;
  signal?: AbortSignal;
}) => Promise<ToolLaneOutcome>;

/**
 * Thin facade for the existing JC, Desktop Commander, and generic MCP composition roots.
 * It does not authorize a tool call or create capabilities: those existing ACS boundaries
 * stay authoritative. This adapter only normalizes their already-authorized outcome.
 */
export class ToolLaneExecutionAdapter implements WorkUnitExecutorAdapter {
  constructor(
    readonly lane: "jc" | "dc" | "mcp",
    private readonly invoke: ToolLaneInvoker,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async execute(dispatch: DispatchEnvelope, signal?: AbortSignal): Promise<ResultEnvelope> {
    if (dispatch.lane !== this.lane) {
      throw new ControlStackError("execution_lane_mismatch", `${this.lane} adapter cannot execute ${dispatch.lane}`);
    }
    if (signal?.aborted) {
      return {
        ...resultBase(dispatch, this.now()),
        outcome: "cancelled",
        receipts: [],
        failure: { category: "cancelled", retrySafe: false },
        externalStateUncertain: false
      };
    }
    try {
      const outcome = await this.invoke({ dispatch, ...(signal ? { signal } : {}) });
      const receipts =
        outcome.receiptKind && outcome.receiptHash
          ? [{ kind: outcome.receiptKind, hash: outcome.receiptHash }]
          : outcome.resultHash
            ? [{ kind: `${this.lane}_result`, hash: outcome.resultHash }]
            : [];
      if (outcome.ok) {
        const resultHash = outcome.resultHash ?? stableHash({ lane: this.lane, attemptId: dispatch.attemptId, receipts });
        return {
          ...resultBase(dispatch, this.now()),
          outcome: "succeeded",
          receipts,
          result: { resultHash, files: [...(outcome.files ?? [])] },
          externalStateUncertain: outcome.externalStateUncertain === true
        };
      }
      const category = failureCategoryForCode(outcome.errorCode, outcome.errorMessage);
      return {
        ...resultBase(dispatch, this.now()),
        outcome: "failed",
        receipts,
        failure: {
          category,
          ...(outcome.errorCode ? { nativeCode: boundedText(outcome.errorCode) } : {}),
          ...(outcome.errorMessage ? { nativeMessage: boundedText(outcome.errorMessage) } : {}),
          retrySafe: outcome.retrySafe === true && outcome.externalStateUncertain !== true
        },
        externalStateUncertain: outcome.externalStateUncertain !== false
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code =
        error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
      return {
        ...resultBase(dispatch, this.now()),
        outcome: "failed",
        receipts: [],
        failure: {
          category: failureCategoryForCode(code, message),
          ...(code ? { nativeCode: boundedText(code) } : {}),
          nativeMessage: boundedText(message),
          retrySafe: false
        },
        externalStateUncertain: true
      };
    }
  }
}

export class WorkUnitExecutionLedger {
  constructor(
    private readonly store: CodingMissionStore,
    private readonly options: { authority?: DispatchAuthorityVerifier } = {}
  ) {}

  beginDispatch(input: {
    missionId: string;
    unitId: string;
    claimToken: string;
    workerId: string;
    lane: ExecutorLane;
    authority?: ExecutionAuthorityRefs;
    now: string;
  }): DispatchEnvelope {
    // A refusal is evidence, so it is committed inside the transaction and thrown only after it.
    let denial: ControlStackError | undefined;
    const envelope = this.store.transaction((): DispatchEnvelope | undefined => {
      const unit = this.store.workUnits(input.missionId).find((candidate) => candidate.unitId === input.unitId);
      if (!unit) throw new ControlStackError("work_unit_not_found", "work unit does not exist");
      if (
        unit.status !== "running" ||
        unit.claimToken !== input.claimToken ||
        unit.workerId !== input.workerId ||
        unit.attempt < 1
      ) {
        throw new ControlStackError("coding_mission_claim_conflict", "execution dispatch does not match the live claim");
      }
      if (!EXECUTOR_LANES.includes(input.lane)) {
        throw new ControlStackError("execution_lane_invalid", "executor lane is invalid");
      }
      // A mission with a persisted authority binding is governed: nothing in it runs unless that authority is verified
      // for this worker, unit, lane and attempt. A governed mission with no verifier configured is refused, not run
      // unchecked. Missions with no binding dispatch exactly as before. The check precedes the replay path below, so
      // a revoked or expired authority also stops a resumed dispatch.
      let governedAuthority: ExecutionAuthorityRefs | undefined;
      const governed = this.store.db
        .prepare("SELECT 1 AS present FROM mission_authority WHERE mission_id = ?")
        .get(input.missionId);
      if (governed) {
        let refusal: string | undefined;
        if (!this.options.authority) {
          refusal = "authority_verifier_unavailable";
        } else {
          let verdict: DispatchAuthorityVerdict;
          try {
            verdict = this.options.authority.verifyDispatch({
              missionId: input.missionId,
              unitId: input.unitId,
              workerId: input.workerId,
              lane: input.lane,
              attempt: unit.attempt
            });
          } catch {
            verdict = { ok: false, reason: "authority_verifier_failed" };
          }
          if (!verdict.ok) {
            refusal = verdict.reason;
          } else if (input.authority?.grantId !== undefined && input.authority.grantId !== verdict.grantId) {
            refusal = "authority_ref_mismatch";
          } else {
            governedAuthority = {
              ...normalizedAuthority(input.authority),
              grantId: verdict.grantId,
              unitAuthorityHash: verdict.unitAuthorityHash
            };
          }
        }
        if (refusal !== undefined) {
          this.store.recordMissionEvent(
            input.missionId,
            "authority.denied",
            { operation: "dispatch", unitId: input.unitId, lane: input.lane, reason: refusal },
            input.now
          );
          denial = new ControlStackError("dispatch_authority_denied", `dispatch refused: ${refusal}`);
          return undefined;
        }
      }
      if (unit.verificationPolicy !== "none" && !this.store.verificationRequirement(input.missionId, input.unitId)) {
        throw new ControlStackError(
          "verification_requirement_missing",
          "verified execution cannot begin without an admitted verification requirement"
        );
      }
      // Verified dispatches derive the producer engine from the route admitted
      // with the durable claim. A beginDispatch caller cannot relabel the producer.
      const implementerEngineId =
        implementerEngineIdFromRoute(unit.route) ?? (unit.verificationPolicy === "none" ? `lane:${input.lane}` : "");
      if (!implementerEngineId) {
        throw new ControlStackError(
          "execution_implementer_identity_required",
          "verified execution requires an implementer engine/provider identity on the admitted route"
        );
      }
      const claimTokenHash = stableHash(input.claimToken);
      const authority = governedAuthority ?? normalizedAuthority(input.authority);
      const payloadHash = stableHash(unit.payload ?? null);
      const routeHash = stableHash(unit.route ?? null);
      // Migration-056 attempts used an identity without implementerEngineId.
      // Reuse that durable identity for resumable policy-none work only after
      // matching every authority and payload binding from its stored envelope.
      if (unit.verificationPolicy === "none") {
        const legacyAttemptId = `wua_${stableHash({
          missionId: input.missionId,
          unitId: input.unitId,
          unitAttempt: unit.attempt,
          workerId: input.workerId,
          claimTokenHash
        }).slice(0, 32)}`;
        const legacy = this.row(legacyAttemptId);
        if (legacy && legacy.implementer_engine_id === null) {
          const stored = JSON.parse(legacy.dispatch_json) as Omit<DispatchEnvelope, "implementerEngineId">;
          if (
            legacy.dispatch_hash !== stableHash(stored) ||
            legacy.claim_token_hash !== claimTokenHash ||
            legacy.worker_id !== input.workerId ||
            legacy.executor_lane !== input.lane ||
            stored.missionId !== input.missionId ||
            stored.unitId !== input.unitId ||
            stored.unitAttempt !== unit.attempt ||
            stored.workerId !== input.workerId ||
            stored.lane !== input.lane ||
            stored.claimTokenHash !== claimTokenHash ||
            stored.payloadHash !== payloadHash ||
            stored.routeHash !== routeHash ||
            stableHash(stored.authority) !== stableHash(authority)
          ) {
            throw new ControlStackError("execution_attempt_conflict", "legacy execution attempt binding does not match");
          }
          return { ...stored, implementerEngineId };
        }
      }
      const attemptId = `wua_${stableHash({
        missionId: input.missionId,
        unitId: input.unitId,
        unitAttempt: unit.attempt,
        workerId: input.workerId,
        implementerEngineId,
        claimTokenHash
      }).slice(0, 32)}`;
      const dispatch: DispatchEnvelope = {
        schemaVersion: "acs.work-unit-dispatch.v1",
        attemptId,
        missionId: input.missionId,
        unitId: input.unitId,
        unitAttempt: unit.attempt,
        unitKind: unit.kind,
        verificationPolicy: unit.verificationPolicy,
        workerId: input.workerId,
        implementerEngineId,
        lane: input.lane,
        claimTokenHash,
        payloadHash,
        routeHash,
        ...(unit.payload ? { payload: unit.payload } : {}),
        authority,
        issuedAt: input.now
      };
      const dispatchHash = stableHash(dispatch);
      const existing = this.row(attemptId);
      if (existing) {
        if (
          existing.dispatch_hash !== dispatchHash ||
          existing.claim_token_hash !== claimTokenHash ||
          existing.worker_id !== input.workerId ||
          existing.implementer_engine_id !== implementerEngineId ||
          existing.executor_lane !== input.lane
        ) {
          throw new ControlStackError("execution_attempt_conflict", "execution attempt identity already has another dispatch");
        }
        return JSON.parse(existing.dispatch_json) as DispatchEnvelope;
      }
      const sameUnitAttempt = this.store.db
        .prepare(
          `SELECT attempt_id, dispatch_hash FROM work_unit_execution_attempts
           WHERE mission_id = ? AND unit_id = ? AND unit_attempt = ?`
        )
        .get(input.missionId, input.unitId, unit.attempt) as
        | { attempt_id: string; dispatch_hash: string }
        | undefined;
      if (sameUnitAttempt) {
        throw new ControlStackError(
          "execution_attempt_conflict",
          `unit attempt is already bound to ${sameUnitAttempt.attempt_id}`
        );
      }
      this.store.db
        .prepare(
          `INSERT INTO work_unit_execution_attempts (
             attempt_id, mission_id, unit_id, unit_attempt, worker_id, implementer_engine_id,
             executor_lane, claim_token_hash, dispatch_hash, dispatch_json, authority_json, state, started_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'started', ?)`
        )
        .run(
          attemptId,
          input.missionId,
          input.unitId,
          unit.attempt,
          input.workerId,
          implementerEngineId,
          input.lane,
          claimTokenHash,
          dispatchHash,
          JSON.stringify(dispatch),
          JSON.stringify(authority),
          input.now
        );
      this.store.putEvidence(
        input.missionId,
        `execution_dispatch:${attemptId}`,
        { attemptId, unitId: input.unitId, unitAttempt: unit.attempt, workerId: input.workerId, lane: input.lane, dispatchHash },
        input.now
      );
      return dispatch;
    });
    if (denial) throw denial;
    return envelope!;
  }

  attempt(attemptId: string): ExecutionAttemptRecord | undefined {
    const row = this.row(attemptId);
    if (!row) return undefined;
    const receipts = this.store.db
      .prepare(
        `SELECT kind, hash FROM work_unit_execution_receipts
         WHERE attempt_id = ? ORDER BY receipt_index`
      )
      .all(attemptId) as Array<{ kind: string; hash: string }>;
    return {
      attemptId: row.attempt_id,
      missionId: row.mission_id,
      unitId: row.unit_id,
      unitAttempt: row.unit_attempt,
      workerId: row.worker_id,
      implementerEngineId: row.implementer_engine_id ?? `lane:${row.executor_lane}`,
      lane: row.executor_lane,
      claimTokenHash: row.claim_token_hash,
      dispatchHash: row.dispatch_hash,
      dispatch: JSON.parse(row.dispatch_json) as DispatchEnvelope,
      authority: JSON.parse(row.authority_json) as ExecutionAuthorityRefs,
      state: row.state,
      startedAt: row.started_at,
      ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
      ...(row.result_hash ? { resultHash: row.result_hash } : {}),
      ...(row.failure_category ? { failureCategory: row.failure_category } : {}),
      ...(row.report_hash ? { reportHash: row.report_hash } : {}),
      ...(row.report_json ? { report: JSON.parse(row.report_json) as ResultEnvelope } : {}),
      receipts
    };
  }

  applyResult(input: { claimToken: string; result: ResultEnvelope }): ApplyResult {
    return this.store.transaction(() => {
      const row = this.row(input.result.attemptId);
      if (!row) return { applied: "rejected_invalid", reason: "execution attempt does not exist" };
      const invalid = this.validateResult(row, input.claimToken, input.result);
      if (invalid) {
        this.store.putEvidence(
          row.mission_id,
          `execution_result_rejected:${row.attempt_id}`,
          { attemptId: row.attempt_id, reason: invalid, reportHash: stableHash(input.result) },
          input.result.finishedAt
        );
        return { applied: "rejected_invalid", reason: invalid };
      }
      const reportHash = stableHash(input.result);
      if (TERMINAL_ATTEMPT_STATES.has(row.state)) {
        if (row.report_hash === reportHash) return { applied: "duplicate" };
        return { applied: "rejected_invalid", reason: "attempt already has a different terminal report" };
      }
      const unit = this.store.workUnits(row.mission_id).find((candidate) => candidate.unitId === row.unit_id);
      if (
        !unit ||
        unit.status !== "running" ||
        unit.claimToken !== input.claimToken ||
        unit.workerId !== row.worker_id ||
        unit.attempt !== row.unit_attempt
      ) {
        this.persistReport(row, input.result, reportHash, "rejected_stale");
        this.store.putEvidence(
          row.mission_id,
          `execution_result_stale:${row.attempt_id}`,
          { attemptId: row.attempt_id, unitId: row.unit_id, reportHash },
          input.result.finishedAt
        );
        return { applied: "rejected_stale", reason: "live claim no longer matches this execution attempt" };
      }

      for (const [index, receipt] of input.result.receipts.entries()) {
        this.store.db
          .prepare(
            `INSERT INTO work_unit_execution_receipts (attempt_id, receipt_index, kind, hash, created_at)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(row.attempt_id, index, receipt.kind, receipt.hash, input.result.finishedAt);
      }

      let applied: ApplyResult;
      switch (input.result.outcome) {
        case "succeeded": {
          if (!input.result.result) {
            const next = this.store.failUnit(row.mission_id, row.unit_id, input.claimToken, {
              category: "invalid_output",
              retryable: false,
              now: input.result.finishedAt
            });
            applied = { applied: next };
            break;
          }
          if (unit.verificationPolicy === "none") {
            this.store.completeOperation(
              row.mission_id,
              row.unit_id,
              input.claimToken,
              { resultHash: input.result.result.resultHash, files: input.result.result.files },
              input.result.finishedAt
            );
            applied = { applied: "completed" };
          } else {
            const changed = this.store.db
              .prepare(
                `UPDATE coding_operations SET status = 'verifying', result_hash = ?, files_json = ?
                 WHERE mission_id = ? AND operation_id = ? AND claim_token = ? AND status = 'running'`
              )
              .run(
                input.result.result.resultHash,
                JSON.stringify(input.result.result.files),
                row.mission_id,
                row.unit_id,
                input.claimToken
              );
            if (changed.changes !== 1) {
              throw new ControlStackError("coding_mission_claim_conflict", "verification hand-off lost the claim");
            }
            this.store.db
              .prepare(
                `INSERT INTO coding_events (mission_id, name, body_json, created_at)
                 VALUES (?, 'verification.started', ?, ?)`
              )
              .run(
                row.mission_id,
                JSON.stringify({ unitId: row.unit_id, attemptId: row.attempt_id, resultHash: input.result.result.resultHash }),
                input.result.finishedAt
              );
            applied = { applied: "awaiting_verification" };
          }
          break;
        }
        case "failed": {
          const failure = input.result.failure ?? { category: "unknown" as const, retrySafe: false };
          const next = this.store.failUnit(row.mission_id, row.unit_id, input.claimToken, {
            category: failure.category,
            retryable: failure.retrySafe && !input.result.externalStateUncertain,
            now: input.result.finishedAt
          });
          applied = { applied: next };
          break;
        }
        case "cancelled": {
          const changed = this.store.db
            .prepare(
              `UPDATE coding_operations
               SET status = 'cancelled', failure_category = 'cancelled', cancel_external_state = ?
               WHERE mission_id = ? AND operation_id = ? AND claim_token = ? AND status = 'running'`
            )
            .run(
              input.result.externalStateUncertain ? "uncertain" : "none",
              row.mission_id,
              row.unit_id,
              input.claimToken
            );
          if (changed.changes !== 1) {
            throw new ControlStackError("coding_mission_claim_conflict", "cancelled outcome lost the claim");
          }
          this.store.db
            .prepare(
              `INSERT INTO coding_events (mission_id, name, body_json, created_at)
               VALUES (?, 'work_unit.cancelled', ?, ?)`
            )
            .run(
              row.mission_id,
              JSON.stringify({ unitId: row.unit_id, attemptId: row.attempt_id }),
              input.result.finishedAt
            );
          applied = { applied: "cancelled" };
          break;
        }
        case "unknown": {
          const changed = this.store.db
            .prepare(
              `UPDATE coding_operations SET status = 'unknown', failure_category = 'unknown'
               WHERE mission_id = ? AND operation_id = ? AND claim_token = ? AND status = 'running'`
            )
            .run(row.mission_id, row.unit_id, input.claimToken);
          if (changed.changes !== 1) {
            throw new ControlStackError("coding_mission_claim_conflict", "unknown outcome lost the claim");
          }
          applied = { applied: "unknown" };
          break;
        }
      }
      this.persistReport(row, input.result, reportHash, input.result.outcome);
      this.store.putEvidence(
        row.mission_id,
        `execution_result:${row.attempt_id}`,
        { attemptId: row.attempt_id, reportHash, outcome: input.result.outcome, applied: applied.applied },
        input.result.finishedAt
      );
      return applied;
    });
  }

  private row(attemptId: string): AttemptRow | undefined {
    return this.store.db
      .prepare(`SELECT * FROM work_unit_execution_attempts WHERE attempt_id = ?`)
      .get(attemptId) as unknown as AttemptRow | undefined;
  }

  private validateResult(row: AttemptRow, claimToken: string, result: ResultEnvelope): string | undefined {
    if (result.schemaVersion !== "acs.work-unit-result.v1") return "unsupported result schema";
    if (
      result.attemptId !== row.attempt_id ||
      result.missionId !== row.mission_id ||
      result.unitId !== row.unit_id ||
      result.unitAttempt !== row.unit_attempt ||
      result.workerId !== row.worker_id ||
      result.lane !== row.executor_lane
    ) {
      return "result identity does not match the persisted execution attempt";
    }
    const claimTokenHash = stableHash(claimToken);
    if (claimTokenHash !== row.claim_token_hash || result.claimTokenHash !== row.claim_token_hash) {
      return "result claim hash does not match the persisted execution attempt";
    }
    if (
      !Array.isArray(result.receipts) ||
      result.receipts.some(
        (receipt) =>
          !receipt ||
          typeof receipt.kind !== "string" ||
          receipt.kind.length === 0 ||
          typeof receipt.hash !== "string" ||
          receipt.hash.length === 0 ||
          Object.keys(receipt).some((key) => key !== "kind" && key !== "hash")
      )
    ) {
      return "result receipts are malformed";
    }
    if (result.outcome === "succeeded" && !result.result) return "successful result is missing result evidence";
    return undefined;
  }

  private persistReport(
    row: AttemptRow,
    result: ResultEnvelope,
    reportHash: string,
    state: ExecutionAttemptRecord["state"]
  ): void {
    this.store.db
      .prepare(
        `UPDATE work_unit_execution_attempts SET
           state = ?, finished_at = ?, result_hash = ?, failure_category = ?, report_hash = ?, report_json = ?
         WHERE attempt_id = ? AND state = 'started'`
      )
      .run(
        state,
        result.finishedAt,
        result.result?.resultHash ?? null,
        result.failure?.category ?? (result.outcome === "failed" || result.outcome === "unknown" ? "unknown" : null),
        reportHash,
        JSON.stringify(result),
        row.attempt_id
      );
  }
}
