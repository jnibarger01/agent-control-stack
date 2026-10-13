import { stableHash } from "@agent-control-stack/shared";
import { parseWorkUnitPayload, type CuaAction, type CuaActionType } from "./mission-model.js";
import type { ExecutionReceipt } from "./worker-execution.js";

/**
 * The one definition of CUA checkpoint evidence. The adapter writes checkpoints with these hashes, resume verifies
 * them, and result acceptance rebuilds the receipts from them. Nothing here trusts a worker-reported receipt.
 */
export type CuaCheckpointState = "planned" | "committed" | "uncertain";

export interface CuaCheckpointRow {
  attempt_id: string;
  mission_id: string;
  unit_id: string;
  unit_attempt: number;
  worker_id: string;
  claim_token_hash: string;
  fencing_token: number | null;
  sequence: number;
  action_type: CuaActionType;
  action_hash: string;
  state: CuaCheckpointState;
  screenshot_hash: string | null;
  receipt_hash: string;
  origin: string | null;
  application: string;
}

export function cuaReceiptKind(type: CuaActionType): string {
  return `cua_${type}`;
}

/** Receipt hash of one checkpoint: binds the attempt, position, selected application, action, state and effect. */
export function cuaCheckpointReceiptHash(input: {
  attemptId: string;
  sequence: number;
  application: string;
  actionType: CuaActionType;
  actionHash: string;
  state: CuaCheckpointState;
  origin: string | null;
  screenshotHash: string | null;
}): string {
  return stableHash({
    domain: "acs.cua-checkpoint.v1",
    kind: cuaReceiptKind(input.actionType),
    attemptId: input.attemptId,
    sequence: input.sequence,
    application: input.application,
    actionHash: input.actionHash,
    state: input.state,
    origin: input.origin,
    screenshotHash: input.screenshotHash
  });
}

export function cuaActionHash(action: CuaAction): string {
  return stableHash(action);
}

export function committedCuaReceipts(rows: readonly CuaCheckpointRow[]): ExecutionReceipt[] {
  return rows
    .filter((row) => row.state === "committed")
    .map((row) => ({ kind: cuaReceiptKind(row.action_type), hash: row.receipt_hash }));
}

/** The result hash a fully committed CUA script reports. */
export function cuaResultHash(receipts: readonly ExecutionReceipt[]): string {
  return stableHash({ receipts });
}

interface AttemptBindingRow {
  attempt_id: string;
  mission_id: string;
  unit_id: string;
  unit_attempt: number;
  worker_id: string;
  claim_token_hash: string;
  executor_lane: string;
  dispatch_json: string;
  authority_json: string;
}

interface Db {
  prepare(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
}

export type CuaCheckpointVerification =
  | { ok: true; rows: CuaCheckpointRow[]; actions: CuaAction[]; application: string | undefined }
  | { ok: false; defect: string };

/**
 * Verify every persisted checkpoint of an attempt against the persisted attempt and dispatch: identity, claim and
 * fence bindings, contiguous sequence, the action hash of the dispatched script at that position, one selected
 * application that the payload allows (and equals `expectedApplication` when given), and the recomputed receipt hash.
 */
export function verifyCuaCheckpoints(
  db: Db,
  attemptId: string,
  expectedApplication?: string
): CuaCheckpointVerification {
  const fail = (defect: string): CuaCheckpointVerification => ({ ok: false, defect });
  const attempt = db
    .prepare(
      `SELECT attempt_id, mission_id, unit_id, unit_attempt, worker_id, claim_token_hash, executor_lane, dispatch_json,
              authority_json
       FROM work_unit_execution_attempts WHERE attempt_id = ?`
    )
    .get(attemptId) as AttemptBindingRow | undefined;
  if (!attempt || attempt.executor_lane !== "cua") return fail("attempt_missing");
  let actions: CuaAction[];
  let allowedApplications: string[];
  let fencingToken: number | null;
  try {
    const dispatch = JSON.parse(attempt.dispatch_json) as { payload?: unknown };
    const payload = parseWorkUnitPayload("cua", dispatch.payload ?? {});
    if (payload.kind !== "cua") return fail("dispatch_payload_invalid");
    actions = payload.actions ?? [];
    allowedApplications = payload.allowedApplications ?? [];
    const fence = (JSON.parse(attempt.authority_json) as { fencingToken?: unknown }).fencingToken;
    fencingToken = typeof fence === "number" && Number.isInteger(fence) ? fence : null;
  } catch {
    return fail("dispatch_payload_invalid");
  }
  const rows = db
    .prepare(
      `SELECT attempt_id, mission_id, unit_id, unit_attempt, worker_id, claim_token_hash, fencing_token, sequence,
              action_type, action_hash, state, screenshot_hash, receipt_hash, origin, application
       FROM cua_action_checkpoints WHERE attempt_id = ? ORDER BY sequence`
    )
    .all(attemptId) as unknown as CuaCheckpointRow[];
  const application = rows[0]?.application;
  if (application !== undefined) {
    if (!allowedApplications.includes(application)) return fail("application_not_allowed");
    if (expectedApplication !== undefined && application !== expectedApplication) return fail("application_mismatch");
  }
  for (const [index, row] of rows.entries()) {
    if (row.sequence !== index) return fail("sequence_gap");
    if (
      row.mission_id !== attempt.mission_id ||
      row.unit_id !== attempt.unit_id ||
      row.unit_attempt !== attempt.unit_attempt ||
      row.worker_id !== attempt.worker_id ||
      row.claim_token_hash !== attempt.claim_token_hash ||
      (row.fencing_token ?? null) !== fencingToken
    )
      return fail("binding_mismatch");
    if (row.application !== application) return fail("application_mismatch");
    const action = actions[index];
    if (!action || row.action_type !== action.type || row.action_hash !== cuaActionHash(action))
      return fail("action_mismatch");
    if (index < rows.length - 1 && row.state !== "committed") return fail("sequence_not_committed");
    if (row.state === "committed" && (row.action_type === "observe") !== (row.screenshot_hash !== null))
      return fail("observation_mismatch");
    const recomputed = cuaCheckpointReceiptHash({
      attemptId: row.attempt_id,
      sequence: row.sequence,
      application: row.application,
      actionType: row.action_type,
      actionHash: row.action_hash,
      state: row.state,
      origin: row.origin ?? null,
      screenshotHash: row.screenshot_hash ?? null
    });
    if (recomputed !== row.receipt_hash) return fail("receipt_hash_mismatch");
  }
  return { ok: true, rows, actions, application };
}

const sameReceipts = (left: readonly ExecutionReceipt[], right: readonly ExecutionReceipt[]) =>
  left.length === right.length &&
  left.every((receipt, index) => receipt.kind === right[index]?.kind && receipt.hash === right[index]?.hash);

/**
 * Evidence-bound acceptance for the cua lane, run inside the result-acceptance transaction. Returns a rejection
 * reason or undefined. Receipts must equal the ones rebuilt from committed checkpoints; success additionally needs a
 * non-empty script whose every action committed and the matching result hash.
 */
export function cuaAcceptanceDefect(
  db: Db,
  attemptId: string,
  result: { outcome: string; receipts: readonly ExecutionReceipt[]; result?: { resultHash: string } }
): string | undefined {
  const verified = verifyCuaCheckpoints(db, attemptId);
  if (!verified.ok) return `cua checkpoint integrity failure: ${verified.defect}`;
  const receipts = committedCuaReceipts(verified.rows);
  if (!sameReceipts(receipts, result.receipts)) return "cua receipts do not match committed checkpoints";
  if (result.outcome === "succeeded") {
    if (verified.actions.length === 0) return "cua success requires a non-empty action script";
    if (verified.rows.length !== verified.actions.length || verified.rows.some((row) => row.state !== "committed"))
      return "cua success requires every action to be committed";
    if (result.result?.resultHash !== cuaResultHash(receipts)) return "cua result hash does not match its receipts";
  }
  return undefined;
}
