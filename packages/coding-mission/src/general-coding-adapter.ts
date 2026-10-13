import { ControlStackError, redactValue } from "@agent-control-stack/shared";
import {
  cancelledResult,
  guardAuthority,
  guardClaim,
  isRefusal,
  refuse,
  refusalResult,
  runWithinBudget,
  scopeCovers,
  type BoundaryAuthority,
  type BoundaryRefusal
} from "./execution-boundary.js";
import { isNormalRelativePath, parseGeneralCodingTask, type GeneralCodingTask } from "./general-coding.js";
import {
  failureCategoryForCode,
  resultBase,
  type DispatchEnvelope,
  type ExecutionClaim,
  type ResultEnvelope,
  type WorkUnitExecutorAdapter
} from "./worker-execution.js";
import type { CodingMissionStore } from "./store.js";

export type { BoundaryAuthority };

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

/** Runtime a coding unit needs from its authority (the coder lane runs in the sandbox runtime). */
const REQUIRED_RUNTIME = "sandbox";

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
    if (signal?.aborted) return cancelledResult(dispatch, this.now());
    const checked = this.refusal(dispatch, claim);
    if (isRefusal(checked)) return refusalResult(dispatch, checked, this.now());
    const { task, claimToken } = checked;
    return runWithinBudget({
      dispatch,
      maxRuntimeMs: task.maxRuntimeMs,
      callerSignal: signal,
      now: this.now,
      execute: (abort) => this.executor.execute({ task, claimToken, signal: abort }),
      map: (outcome) => this.map(dispatch, task, outcome)
    });
  }

  /** Every pre-execution check. Nothing has run yet, so a refusal leaves no external state behind. */
  private refusal(
    dispatch: DispatchEnvelope,
    claim: ExecutionClaim | undefined
  ): BoundaryRefusal | { task: GeneralCodingTask; claimToken: string } {
    const guarded = guardClaim(this.store, dispatch, claim, "coding");
    if (isRefusal(guarded)) return guarded;

    let task: GeneralCodingTask;
    try {
      // The unit's stored payload, not the envelope's copy, is what ACS admitted.
      task = parseGeneralCodingTask(guarded.unit.payload);
    } catch {
      return refuse("task_contract_invalid");
    }

    const definition = guardAuthority(this.authority, dispatch, guarded.unit);
    if (isRefusal(definition)) return definition;

    if (!definition.toolClasses.some((tool) => tool.runtime === REQUIRED_RUNTIME)) {
      return refuse("tool_class_not_granted");
    }
    if (!scopeCovers(definition.scope, task.repository)) return refuse("repository_out_of_scope");
    if (task.maxRuntimeMs > definition.limits.maxRuntimeMs) return refuse("runtime_exceeds_authority");
    return { task, claimToken: guarded.claimToken };
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
