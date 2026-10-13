import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { ControlStackError, redactValue, stableHash } from "@agent-control-stack/shared";
import type { AutonomousAuthorityDefinition } from "./authority.js";
import type { MissionAuthorityLedger } from "./child-work.js";
import { isNormalRelativePath, parseGeneralCodingTask, type GeneralCodingTask } from "./general-coding.js";
import type { FailureCategory } from "./mission-model.js";
import type { CodingMissionStore } from "./store.js";
import {
  deadlineResult,
  failureCategoryForCode,
  resultBase,
  type DispatchEnvelope,
  type ExecutionClaim,
  type ResultEnvelope,
  type WorkUnitExecutorAdapter
} from "./worker-execution.js";

/** What the executor is asked to do. Everything in it was re-checked at the execution boundary. */
export interface GeneralCodingRequest {
  task: GeneralCodingTask;
  /** The fence for this claim, for an executor that validates it again at the repository. */
  claimToken: string;
  /** Aborted at the task's runtime bound or when ACS stops waiting. */
  signal: AbortSignal;
}

/** What an executor may report. The adapter, not the executor, decides whether it is acceptable. */
export type GeneralCodingOutcome =
  | {
      status: "succeeded";
      /** The immutable commit the executor attests it actually ran against. */
      baseSha: string;
      resultHash: string;
      /** Repository-relative paths the executor changed. */
      files: string[];
    }
  | { status: "failed"; code?: string; message?: string; externalStateUncertain?: boolean }
  | { status: "unknown" };

/** Runs one repository-scoped coding task. It is handed no authority: the adapter has already decided it may run. */
export interface GeneralCodingExecutor {
  execute(request: GeneralCodingRequest): Promise<GeneralCodingOutcome>;
}

/** The authority surface the adapter re-reads at the execution boundary; `MissionAuthorityLedger` implements it. */
export type BoundaryAuthority = Pick<MissionAuthorityLedger, "verifyDispatch" | "missionAuthority" | "unitAuthority">;

/** Runtime a coding unit needs from its authority (the coder lane runs in the sandbox runtime). */
const REQUIRED_RUNTIME = "sandbox";

/**
 * The physical path `path` names: the realpath of the path itself when it exists, otherwise the realpath of its nearest
 * existing ancestor with the missing segments appended. Undefined (fail closed) on any other error, including a path
 * that exists as a dangling or unreadable symlink, since where it would point is not knowable now.
 */
function physicalPath(path: string): string | undefined {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync(current), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") return undefined;
      try {
        lstatSync(current);
        return undefined; // the entry exists (a dangling symlink) but cannot be resolved
      } catch (lstatError) {
        if ((lstatError as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") return undefined;
      }
      const parent = dirname(current);
      if (parent === current) return undefined;
      missing.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Containment is judged on physical paths, so a symlink inside a scope cannot carry the repository outside it. Returns
 * the resolved physical path when the scope covers it, otherwise undefined.
 */
function covers(scope: AutonomousAuthorityDefinition["scope"], repository: string): string | undefined {
  const path = physicalPath(repository);
  if (path === undefined) return undefined;
  const covered = scope.some((allowed) => {
    if (allowed.kind !== "repository" && allowed.kind !== "path") return false;
    if (!isAbsolute(allowed.id)) return false;
    const root = physicalPath(allowed.id);
    if (root === undefined) return false;
    if (root === path) return true;
    if (allowed.coverage !== "descendants") return false;
    const suffix = relative(root, path);
    return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
  });
  return covered ? path : undefined;
}

/** A reported file is acceptable only if it is one of the declared paths or lies under a declared directory. */
function withinDeclared(file: string, declared: readonly string[]): boolean {
  return declared.some((entry) => file === entry || file.startsWith(`${entry}/`));
}

/**
 * Executes a `general`-mission coding unit as one explicit, repository-scoped task. Dispatch already authorized the unit;
 * this adapter enforces the same authority again where the work actually happens, because dispatch and execution are
 * separated in time and the authority, the claim or the task can change between them. It checks, fail-closed and before
 * the executor runs:
 *
 *   claim        the caller holds the unit's live claim (token hash, store row, worker)
 *   authority    the dispatch gate still passes on current durable state, over the same authority definition
 *   task         the payload is a complete typed contract
 *   scope        the repository lies inside the authority's scope; the sandbox runtime is granted
 *   runtime      the task's own bound does not exceed the authority's
 *
 * and after it runs, that the reported base revision, file list and file count match the contract. It does not manage a
 * branch, a pull request or a merge; that stays with `CodingMissionController`.
 */
export class GeneralCodingExecutionAdapter implements WorkUnitExecutorAdapter {
  readonly lane = "coder" as const;

  constructor(
    private readonly store: CodingMissionStore,
    private readonly authority: BoundaryAuthority,
    private readonly executor: GeneralCodingExecutor,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async execute(dispatch: DispatchEnvelope, signal?: AbortSignal, claim?: ExecutionClaim): Promise<ResultEnvelope> {
    if (dispatch.lane !== this.lane) {
      throw new ControlStackError("execution_lane_mismatch", `general coding adapter cannot execute ${dispatch.lane}`);
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
    const refusal = this.refusal(dispatch, claim);
    if (refusal.denied) return this.denied(dispatch, refusal.category, refusal.code);
    return this.run(dispatch, refusal.task, refusal.claimToken, signal);
  }

  /** Every pre-execution check. Nothing has run yet, so a refusal leaves no external state behind. */
  private refusal(
    dispatch: DispatchEnvelope,
    claim: ExecutionClaim | undefined
  ):
    | { denied: true; category: FailureCategory; code: string }
    | { denied: false; task: GeneralCodingTask; claimToken: string } {
    const deny = (code: string, category: FailureCategory = "policy_denied") => ({
      denied: true as const,
      category,
      code
    });
    if (!claim || stableHash(claim.claimToken) !== dispatch.claimTokenHash) return deny("claim_mismatch");
    let unit: ReturnType<CodingMissionStore["workUnits"]>[number] | undefined;
    try {
      unit = this.store.workUnits(dispatch.missionId).find((candidate) => candidate.unitId === dispatch.unitId);
    } catch {
      // An unreadable stored unit is a refusal, so the runner records the failure and releases the claim.
      return deny("unit_unreadable");
    }
    if (
      !unit ||
      unit.kind !== "coding" ||
      unit.claimToken !== claim.claimToken ||
      unit.workerId !== dispatch.workerId ||
      !["running", "checkpointed"].includes(unit.status)
    ) {
      return deny("claim_not_live", "lease_lost");
    }

    let task: GeneralCodingTask;
    try {
      // The unit's stored payload, not the envelope's copy, is what ACS admitted.
      task = parseGeneralCodingTask(unit.payload);
    } catch {
      return deny("task_contract_invalid");
    }

    let definition: AutonomousAuthorityDefinition;
    try {
      const verdict = this.authority.verifyDispatch({
        missionId: dispatch.missionId,
        unitId: dispatch.unitId,
        workerId: dispatch.workerId,
        lane: dispatch.lane,
        attempt: dispatch.unitAttempt
      });
      if (!verdict.ok) {
        return deny(verdict.reason, verdict.reason === "authority_expired" ? "authority_expired" : "policy_denied");
      }
      if (verdict.unitAuthorityHash !== dispatch.authority.unitAuthorityHash) return deny("authority_changed");
      const record = unit.parentUnitId ? this.authority.unitAuthority(dispatch.missionId, dispatch.unitId) : undefined;
      const found = record?.definition ?? this.authority.missionAuthority(dispatch.missionId)?.definition;
      if (!found) return deny("authority_missing");
      definition = found;
    } catch (error) {
      if (error instanceof ControlStackError && error.code === "authority_integrity") {
        return deny("authority_integrity_failure");
      }
      throw error;
    }

    if (!definition.toolClasses.some((tool) => tool.runtime === REQUIRED_RUNTIME))
      return deny("tool_class_not_granted");
    const repository = covers(definition.scope, task.repository);
    if (repository === undefined) return deny("repository_out_of_scope");
    if (task.maxRuntimeMs > definition.limits.maxRuntimeMs) return deny("runtime_exceeds_authority");
    // Pin the task to the physical path that was checked, so a symlink swapped later cannot redirect the executor.
    return { denied: false, task: { ...task, repository }, claimToken: claim.claimToken };
  }

  private denied(dispatch: DispatchEnvelope, category: FailureCategory, code: string): ResultEnvelope {
    return {
      ...resultBase(dispatch, this.now()),
      outcome: "failed",
      receipts: [],
      failure: { category, nativeCode: code, retrySafe: false },
      // The executor never ran, so there is no external state to be uncertain about.
      externalStateUncertain: false
    };
  }

  private async run(
    dispatch: DispatchEnvelope,
    task: GeneralCodingTask,
    claimToken: string,
    callerSignal: AbortSignal | undefined
  ): Promise<ResultEnvelope> {
    const abort = new AbortController();
    const onCallerAbort = () => abort.abort();
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    // The task's own bound, capped by whatever time ACS has left on the dispatch.
    const remaining =
      dispatch.authority.deadlineAt === undefined
        ? Number.POSITIVE_INFINITY
        : Date.parse(dispatch.authority.deadlineAt) - Date.parse(this.now());
    const budgetMs = Math.min(task.maxRuntimeMs, remaining);
    // No time left (or an unparseable deadline): report the deadline without ever starting the executor.
    if (!(budgetMs > 0)) {
      callerSignal?.removeEventListener("abort", onCallerAbort);
      return deadlineResult(dispatch, this.now());
    }
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<"timeout">((resolveTimeout) => {
      timer = setTimeout(() => {
        abort.abort();
        resolveTimeout("timeout");
      }, budgetMs);
    });
    // The checked path must still be the physical path right before the executor starts (TOCTOU, #361).
    if (physicalPath(task.repository) !== task.repository) {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
      return this.denied(dispatch, "policy_denied", "repository_moved");
    }
    const execution = this.executor.execute({ task, claimToken, signal: abort.signal });
    execution.catch(() => undefined); // a late failure after the bound is not an unhandled rejection
    try {
      const winner = await Promise.race([execution, expired]);
      if (winner === "timeout") return deadlineResult(dispatch, this.now());
      return this.map(dispatch, task, winner);
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
          ...(code ? { nativeCode: code.slice(0, 128) } : {}),
          nativeMessage: String(redactValue(message)).slice(0, 500),
          retrySafe: false
        },
        externalStateUncertain: true
      };
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }

  /** Judges an executor's report against the contract. A report that breaks it is never a success. */
  private map(dispatch: DispatchEnvelope, task: GeneralCodingTask, outcome: GeneralCodingOutcome): ResultEnvelope {
    const finishedAt = this.now();
    if (outcome.status === "unknown") {
      return { ...resultBase(dispatch, finishedAt), outcome: "unknown", receipts: [], externalStateUncertain: true };
    }
    if (outcome.status === "failed") {
      return {
        ...resultBase(dispatch, finishedAt),
        outcome: "failed",
        receipts: [],
        failure: {
          category: failureCategoryForCode(outcome.code, outcome.message),
          ...(outcome.code ? { nativeCode: outcome.code.slice(0, 128) } : {}),
          ...(outcome.message ? { nativeMessage: String(redactValue(outcome.message)).slice(0, 500) } : {}),
          retrySafe: false
        },
        externalStateUncertain: outcome.externalStateUncertain !== false
      };
    }
    const violation = this.outputViolation(task, outcome);
    if (violation) {
      return {
        ...resultBase(dispatch, finishedAt),
        outcome: "failed",
        receipts: [],
        // The work ran, so the repository may have changed even though the report is unusable.
        failure: { category: "invalid_output", nativeCode: violation, retrySafe: false },
        externalStateUncertain: true
      };
    }
    return {
      ...resultBase(dispatch, finishedAt),
      outcome: "succeeded",
      receipts: [{ kind: "general_coding_result", hash: outcome.resultHash }],
      result: { resultHash: outcome.resultHash, files: [...outcome.files] },
      externalStateUncertain: false
    };
  }

  private outputViolation(
    task: GeneralCodingTask,
    outcome: Extract<GeneralCodingOutcome, { status: "succeeded" }>
  ): string | undefined {
    if (outcome.baseSha !== task.baseSha) return "base_revision_mismatch";
    if (typeof outcome.resultHash !== "string" || outcome.resultHash.length === 0) return "result_hash_missing";
    if (!Array.isArray(outcome.files) || outcome.files.some((file) => typeof file !== "string")) {
      return "files_malformed";
    }
    if (outcome.files.length > task.maxFiles) return "too_many_files";
    if (!outcome.files.every(isNormalRelativePath)) return "file_path_invalid";
    if (!outcome.files.every((file) => withinDeclared(file, task.files))) return "file_outside_declared";
    return undefined;
  }
}
