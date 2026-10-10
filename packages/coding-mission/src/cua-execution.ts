import { createHash } from "node:crypto";
import { ControlStackError, stableHash } from "@agent-control-stack/shared";
import type { CuaAction, CuaActionType } from "./mission-model.js";
import { parseWorkUnitPayload } from "./mission-model.js";
import type { CodingMissionStore } from "./store.js";
import {
  boundedText,
  resultBase,
  type DispatchEnvelope,
  type ExecutionReceipt,
  type ResultEnvelope,
  type WorkUnitExecutorAdapter
} from "./worker-execution.js";

/**
 * Subset of Playwright's Page. A real Page already has these members; this package does not depend on playwright.
 * screenshot returns bytes the caller hashes and drops. It must not retain them.
 */
export interface CuaPage {
  url(): string;
  screenshot(): Promise<Uint8Array>;
  locator(selector: string): {
    click(): Promise<void>;
    fill(text: string): Promise<void>;
  };
  mouse: {
    wheel(dx: number, dy: number): Promise<void>;
  };
  goto(url: string): Promise<unknown>;
  close(): Promise<void>;
}

export interface CuaBrowserProvider {
  open(application: string): Promise<CuaPage>;
}

/** Opens a Playwright-shaped page and starts it at about:blank before any governed action. */
export class PlaywrightCuaBrowser implements CuaBrowserProvider {
  constructor(private readonly connect: (application: string) => Promise<CuaPage>) {}

  async open(application: string): Promise<CuaPage> {
    const page = await this.connect(application);
    try {
      await page.goto("about:blank");
    } catch (error) {
      try {
        await page.close();
      } catch {
        // A close failure must not hide the about:blank reset error.
      }
      throw error;
    }
    return page;
  }
}

const MUTATING: ReadonlySet<CuaActionType> = new Set(["click", "type", "scroll", "navigate"]);

interface CheckpointRow {
  sequence: number;
  action_type: CuaActionType;
  action_hash: string;
  state: "planned" | "committed" | "uncertain";
  screenshot_hash: string | null;
  receipt_hash: string;
  origin: string | null;
}

interface ActionEffect {
  origin: string | null;
  screenshotHash?: string;
  uncertain: boolean;
}

function receiptKind(type: CuaActionType): string {
  return `cua_${type}`;
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pageOrigin(url: string): string | null {
  if (url === "about:blank") return "about:blank";
  try {
    const parsed = new URL(url);
    if (parsed.username !== "" || parsed.password !== "") return null;
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function approvedNavigation(url: string, origins: readonly string[]): { href: string; origin: string } | undefined {
  if (origins.length === 0) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  if (parsed.username !== "" || parsed.password !== "") return undefined;
  if (!origins.includes(parsed.origin)) return undefined;
  return { href: parsed.href, origin: parsed.origin };
}

function landingUncertain(
  type: CuaActionType,
  url: string,
  origins: readonly string[],
  requireAllowlisted: boolean
): boolean {
  if (type === "observe" && !requireAllowlisted && url === "about:blank") return false;
  const origin = pageOrigin(url);
  return origin === null || origin === "about:blank" || !origins.includes(origin);
}

function isFenceError(error: unknown): boolean {
  return (
    error instanceof ControlStackError &&
    (error.code === "coding_mission_claim_conflict" || error.code === "execution_attempt_conflict")
  );
}

/**
 * Runs the actions already on a cua work-unit payload. It does not plan actions,
 * mint capabilities, or consult a second approval store. The live claim fence is
 * rechecked in the same transaction as each checkpoint write.
 */
export class CuaExecutionAdapter implements WorkUnitExecutorAdapter {
  readonly lane = "cua" as const;

  constructor(
    private readonly store: CodingMissionStore,
    private readonly browser: CuaBrowserProvider,
    private readonly application: string,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async execute(dispatch: DispatchEnvelope, signal?: AbortSignal): Promise<ResultEnvelope> {
    if (dispatch.lane !== this.lane) {
      throw new ControlStackError("execution_lane_mismatch", `cua adapter cannot execute ${dispatch.lane}`);
    }
    const prior = this.checkpoints(dispatch.attemptId);
    if (prior.some((row) => row.state === "uncertain" || row.state === "planned")) {
      if (prior.some((row) => row.state === "planned")) this.settlePlanned(dispatch);
      return this.unknownResult(dispatch, committedReceipts(this.checkpoints(dispatch.attemptId)));
    }
    if (prior.length > 0) {
      const receipts = committedReceipts(prior);
      const mutated = prior.some((row) => row.state === "committed" && MUTATING.has(row.action_type));
      if (signal?.aborted) return this.cancelled(dispatch, mutated, receipts);
      return this.unknownResult(dispatch, receipts);
    }
    if (signal?.aborted) return this.cancelled(dispatch, false, []);

    let payload;
    try {
      payload = parseWorkUnitPayload("cua", dispatch.payload ?? {});
    } catch (error) {
      const message = error instanceof Error ? error.message : "cua payload is invalid";
      return this.failed(dispatch, "invalid_output", "cua_payload_invalid", message, []);
    }
    if (payload.kind !== "cua") {
      return this.failed(dispatch, "invalid_output", "cua_payload_invalid", "cua payload is required", []);
    }
    const applications = payload.allowedApplications ?? [];
    if (this.application.length === 0 || applications.length === 0 || !applications.includes(this.application)) {
      return this.failed(dispatch, "policy_denied", "cua_application_denied", "application is not allowlisted", []);
    }
    const origins = payload.allowedOrigins ?? [];
    const actions = payload.actions ?? [];
    if (actions.length === 0) return this.succeeded(dispatch, []);

    this.assertFence(dispatch);
    let page: CuaPage | undefined;
    let committedMutation = false;
    let requireAllowlisted = false;
    const receipts: ExecutionReceipt[] = [];
    try {
      for (const [sequence, action] of actions.entries()) {
        if (signal?.aborted) return this.cancelled(dispatch, committedMutation, receipts);
        const hash = stableHash(action);
        if (page) {
          let liveUrl: string;
          try {
            liveUrl = page.url();
          } catch {
            return this.unknownResult(dispatch, receipts);
          }
          const freshBlank = liveUrl === "about:blank" && !requireAllowlisted;
          const navigateFromBlank = action.type === "navigate" && freshBlank;
          if (!navigateFromBlank && landingUncertain(action.type, liveUrl, origins, requireAllowlisted)) {
            return this.unknownResult(dispatch, receipts);
          }
        }
        const refusal = this.refusal(action, origins);
        if (refusal) {
          return this.failed(dispatch, "policy_denied", refusal, "CUA action refused", receipts);
        }
        if (
          !page &&
          action.type !== "navigate" &&
          landingUncertain(action.type, "about:blank", origins, requireAllowlisted)
        ) {
          return this.failed(
            dispatch,
            "policy_denied",
            "cua_origin_denied",
            "page origin is not allowlisted",
            receipts
          );
        }
        if (this.plan(dispatch, action, sequence, hash) === "blocked") {
          this.settlePlanned(dispatch);
          return this.unknownResult(dispatch, committedReceipts(this.checkpoints(dispatch.attemptId)));
        }
        if (!page) {
          try {
            page = await this.browser.open(this.application);
          } catch (error) {
            if (isFenceError(error)) throw error;
            this.finish(dispatch, sequence, action.type, hash, "uncertain", { uncertain: true, origin: null });
            return this.unknownResult(dispatch, receipts);
          }
        }
        try {
          const effect = await this.perform(page, action, origins, requireAllowlisted);
          if (effect.uncertain) {
            this.finish(dispatch, sequence, action.type, hash, "uncertain", effect);
            return this.unknownResult(dispatch, receipts);
          }
          const receiptHash = this.finish(dispatch, sequence, action.type, hash, "committed", effect);
          receipts.push({ kind: receiptKind(action.type), hash: receiptHash });
          if (MUTATING.has(action.type)) {
            committedMutation = true;
            requireAllowlisted = true;
          }
        } catch (error) {
          if (isFenceError(error)) throw error;
          let origin: string | null = null;
          try {
            origin = pageOrigin(page.url());
          } catch {
            origin = null;
          }
          this.finish(dispatch, sequence, action.type, hash, "uncertain", { uncertain: true, origin });
          return this.unknownResult(dispatch, receipts);
        }
        if (signal?.aborted) return this.cancelled(dispatch, committedMutation, receipts);
      }
      return this.succeeded(dispatch, receipts);
    } finally {
      if (page) {
        try {
          await page.close();
        } catch {
          // A close failure must not replace a fenced result or invite a retry.
        }
      }
    }
  }

  private refusal(action: CuaAction, origins: readonly string[]): string | undefined {
    if (action.type === "navigate") {
      if (!approvedNavigation(action.url, origins)) {
        return action.url.trim().toLowerCase().startsWith("javascript:") ? "cua_scheme_denied" : "cua_origin_denied";
      }
      return undefined;
    }
    if (action.type !== "observe" && origins.length === 0) return "cua_origin_denied";
    return undefined;
  }

  private async perform(
    page: CuaPage,
    action: CuaAction,
    origins: readonly string[],
    requireAllowlisted: boolean
  ): Promise<ActionEffect> {
    let screenshotHash: string | undefined;
    if (action.type === "observe") {
      const bytes = await page.screenshot();
      if (!(bytes instanceof Uint8Array)) {
        throw new ControlStackError("cua_observation_invalid", "screenshot was not bytes");
      }
      screenshotHash = sha256Bytes(bytes);
    } else if (action.type === "click") {
      await page.locator(action.selector).click();
    } else if (action.type === "type") {
      await page.locator(action.selector).fill(action.text);
    } else if (action.type === "scroll") {
      await page.mouse.wheel(action.dx, action.dy);
    } else {
      const approved = approvedNavigation(action.url, origins);
      if (!approved) return { uncertain: true, origin: null };
      await page.goto(approved.href);
    }
    const url = page.url();
    return {
      uncertain: landingUncertain(action.type, url, origins, requireAllowlisted),
      origin: pageOrigin(url),
      ...(screenshotHash ? { screenshotHash } : {})
    };
  }

  private assertFence(dispatch: DispatchEnvelope): void {
    this.store.transaction(() => this.assertFenceInTransaction(dispatch));
  }

  private assertFenceInTransaction(dispatch: DispatchEnvelope): void {
    const unit = this.store.db
      .prepare(
        `SELECT status, claim_token, worker_id, attempt
         FROM coding_operations WHERE mission_id = ? AND operation_id = ?`
      )
      .get(dispatch.missionId, dispatch.unitId) as
      { status: string; claim_token: string | null; worker_id: string | null; attempt: number } | undefined;
    if (
      !unit ||
      unit.status !== "running" ||
      unit.worker_id !== dispatch.workerId ||
      unit.attempt !== dispatch.unitAttempt ||
      !unit.claim_token ||
      stableHash(unit.claim_token) !== dispatch.claimTokenHash
    ) {
      throw new ControlStackError("coding_mission_claim_conflict", "CUA fence does not match the live claim");
    }
    const attempt = this.store.db
      .prepare(
        `SELECT claim_token_hash, worker_id, unit_attempt, state, authority_json
         FROM work_unit_execution_attempts WHERE attempt_id = ?`
      )
      .get(dispatch.attemptId) as
      | {
          claim_token_hash: string;
          worker_id: string;
          unit_attempt: number;
          state: string;
          authority_json: string;
        }
      | undefined;
    if (
      !attempt ||
      attempt.state !== "started" ||
      attempt.claim_token_hash !== dispatch.claimTokenHash ||
      attempt.worker_id !== dispatch.workerId ||
      attempt.unit_attempt !== dispatch.unitAttempt
    ) {
      throw new ControlStackError("coding_mission_claim_conflict", "CUA fence does not match the execution attempt");
    }
    let storedFence: unknown;
    try {
      storedFence = (JSON.parse(attempt.authority_json) as { fencingToken?: unknown }).fencingToken;
    } catch {
      throw new ControlStackError("coding_mission_claim_conflict", "CUA fencing token is unreadable");
    }
    const expected = dispatch.authority.fencingToken;
    const stored = typeof storedFence === "number" && Number.isInteger(storedFence) ? storedFence : undefined;
    if (stored !== expected) {
      throw new ControlStackError("coding_mission_claim_conflict", "CUA fencing token does not match");
    }
  }

  private plan(dispatch: DispatchEnvelope, action: CuaAction, sequence: number, hash: string): "inserted" | "blocked" {
    return this.store.transaction(() => {
      this.assertFenceInTransaction(dispatch);
      const existing = this.checkpoint(dispatch.attemptId, sequence);
      if (existing) return "blocked";
      if (sequence > 0) {
        const previous = this.checkpoint(dispatch.attemptId, sequence - 1);
        if (!previous || previous.state !== "committed") {
          throw new ControlStackError("coding_mission_claim_conflict", "CUA checkpoint sequence is not contiguous");
        }
      }
      this.store.db
        .prepare(
          `INSERT INTO cua_action_checkpoints (
             attempt_id, mission_id, unit_id, unit_attempt, worker_id, claim_token_hash, fencing_token,
             sequence, action_type, action_hash, state, screenshot_hash, receipt_hash, origin, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', NULL, ?, NULL, ?)`
        )
        .run(
          dispatch.attemptId,
          dispatch.missionId,
          dispatch.unitId,
          dispatch.unitAttempt,
          dispatch.workerId,
          dispatch.claimTokenHash,
          dispatch.authority.fencingToken ?? null,
          sequence,
          action.type,
          hash,
          stableHash({ actionHash: hash, state: "planned" }),
          this.now()
        );
      return "inserted";
    });
  }

  private finish(
    dispatch: DispatchEnvelope,
    sequence: number,
    actionType: CuaActionType,
    hash: string,
    state: "committed" | "uncertain",
    effect: ActionEffect
  ): string {
    const receiptHash = stableHash({
      kind: receiptKind(actionType),
      actionHash: hash,
      state,
      origin: effect.origin,
      ...(effect.screenshotHash ? { screenshotHash: effect.screenshotHash } : {})
    });
    this.store.transaction(() => {
      this.assertFenceInTransaction(dispatch);
      const changed = this.store.db
        .prepare(
          `UPDATE cua_action_checkpoints
           SET state = ?, screenshot_hash = ?, receipt_hash = ?, origin = ?
           WHERE attempt_id = ? AND sequence = ? AND state = 'planned' AND action_hash = ?`
        )
        .run(state, effect.screenshotHash ?? null, receiptHash, effect.origin, dispatch.attemptId, sequence, hash);
      if (changed.changes !== 1) {
        throw new ControlStackError("coding_mission_claim_conflict", "CUA checkpoint could not be fenced");
      }
    });
    return receiptHash;
  }

  private settlePlanned(dispatch: DispatchEnvelope): void {
    this.store.transaction(() => {
      this.assertFenceInTransaction(dispatch);
      const planned = this.checkpoints(dispatch.attemptId).filter((row) => row.state === "planned");
      for (const row of planned) {
        const receiptHash = stableHash({ actionHash: row.action_hash, state: "uncertain", origin: row.origin });
        const changed = this.store.db
          .prepare(
            `UPDATE cua_action_checkpoints
             SET state = 'uncertain', receipt_hash = ?
             WHERE attempt_id = ? AND sequence = ? AND state = 'planned'`
          )
          .run(receiptHash, dispatch.attemptId, row.sequence);
        if (changed.changes !== 1) {
          throw new ControlStackError("coding_mission_claim_conflict", "planned CUA checkpoint could not be fenced");
        }
      }
    });
  }

  private checkpoints(attemptId: string): CheckpointRow[] {
    return this.store.db
      .prepare(
        `SELECT sequence, action_type, action_hash, state, screenshot_hash, receipt_hash, origin
         FROM cua_action_checkpoints WHERE attempt_id = ? ORDER BY sequence`
      )
      .all(attemptId) as unknown as CheckpointRow[];
  }

  private checkpoint(attemptId: string, sequence: number): CheckpointRow | undefined {
    return this.store.db
      .prepare(
        `SELECT sequence, action_type, action_hash, state, screenshot_hash, receipt_hash, origin
         FROM cua_action_checkpoints WHERE attempt_id = ? AND sequence = ?`
      )
      .get(attemptId, sequence) as CheckpointRow | undefined;
  }

  private succeeded(dispatch: DispatchEnvelope, receipts: ExecutionReceipt[]): ResultEnvelope {
    return {
      ...resultBase(dispatch, this.now()),
      outcome: "succeeded",
      receipts,
      result: { resultHash: stableHash({ receipts }), files: [] },
      externalStateUncertain: false
    };
  }

  private failed(
    dispatch: DispatchEnvelope,
    category: "policy_denied" | "invalid_output",
    code: string,
    message: string,
    receipts: ExecutionReceipt[]
  ): ResultEnvelope {
    return {
      ...resultBase(dispatch, this.now()),
      outcome: "failed",
      receipts,
      failure: {
        category,
        nativeCode: boundedText(code),
        nativeMessage: boundedText(message),
        retrySafe: false
      },
      externalStateUncertain: false
    };
  }

  private cancelled(
    dispatch: DispatchEnvelope,
    externalStateUncertain: boolean,
    receipts: ExecutionReceipt[]
  ): ResultEnvelope {
    return {
      ...resultBase(dispatch, this.now()),
      outcome: "cancelled",
      receipts,
      failure: { category: "cancelled", retrySafe: false },
      externalStateUncertain
    };
  }

  private unknownResult(dispatch: DispatchEnvelope, receipts: ExecutionReceipt[]): ResultEnvelope {
    return {
      ...resultBase(dispatch, this.now()),
      outcome: "unknown",
      receipts,
      failure: {
        category: "unknown",
        nativeCode: "cua_external_state_uncertain",
        retrySafe: false
      },
      externalStateUncertain: true
    };
  }
}

function committedReceipts(rows: CheckpointRow[]): ExecutionReceipt[] {
  return rows
    .filter((row) => row.state === "committed")
    .map((row) => ({ kind: receiptKind(row.action_type), hash: row.receipt_hash }));
}
