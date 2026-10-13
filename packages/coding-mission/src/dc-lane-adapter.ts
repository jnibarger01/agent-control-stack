import { isAbsolute, resolve } from "node:path";
import { dcCapabilityToolContract, type AcsDcScope } from "@agent-control-stack/dc-tool-manifest";
import { ControlStackError, redactValue } from "@agent-control-stack/shared";
import type { AutonomousAuthorityDefinition } from "./authority.js";
import { parseDcToolCall, type DcToolCall } from "./dc-tool-call.js";
import {
  cancelledResult,
  guardAuthority,
  guardClaim,
  isRefusal,
  refusalResult,
  refuse,
  runWithinBudget,
  scopeCovers,
  type BoundaryAuthority,
  type BoundaryRefusal
} from "./execution-boundary.js";
import type { CodingMissionStore } from "./store.js";
import {
  failureCategoryForCode,
  resultBase,
  type DispatchEnvelope,
  type ExecutionClaim,
  type ResultEnvelope,
  type WorkUnitExecutorAdapter
} from "./worker-execution.js";

/** One validated Desktop Commander call. The invoker is handed no authority: the adapter has already decided it may run. */
export interface DcToolInvocation {
  toolName: string;
  arguments: Readonly<Record<string, unknown>>;
  /** The fence for this claim, for a transport that validates it again at the device. */
  claimToken: string;
  /** Aborted at the call's runtime bound or when ACS stops waiting. */
  signal: AbortSignal;
}

/** What an invoker may report. The adapter, not the invoker, decides whether it is acceptable. */
export type DcToolOutcome =
  | { status: "succeeded"; resultHash: string; /** Must be absent or empty for a read-only tool. */ files?: string[] }
  | { status: "failed"; code?: string; message?: string; externalStateUncertain?: boolean }
  | { status: "unknown" };

export interface DcToolInvoker {
  invoke(call: DcToolInvocation): Promise<DcToolOutcome>;
}

/**
 * The tools this lane runs, and how to read the filesystem paths out of each one's (already schema-validated) arguments.
 * It is an explicit allowlist, not "whatever the manifest calls read-only": a tool whose paths this lane cannot enumerate
 * cannot be scope-checked, so it is refused rather than guessed at. Approval-bound mutation and process tools are
 * deliberately absent; a work unit has no per-call human approval, and a grant is not one.
 */
const READ_ONLY_TOOLS: Readonly<Record<string, (args: Record<string, unknown>) => string[]>> = Object.freeze({
  read_file: (args) => [args.path as string],
  read_multiple_files: (args) => args.paths as string[],
  get_file_info: (args) => [args.path as string],
  list_directory: (args) => [args.path as string]
});

/** The authority privilege that backs each acs.dc.v1 capability scope. */
const PRIVILEGE_FOR_SCOPE: Readonly<Record<AcsDcScope, string>> = Object.freeze({
  "fs.read": "fs.read",
  "fs.write": "fs.write",
  "network.read": "network",
  "network.write": "network",
  "process.exec": "process.exec",
  "process.spawn": "process.spawn"
});

const RUNTIME = "desktop_commander";

/**
 * Executes a `tool` work unit on the Desktop Commander lane. Dispatch already authorized the unit; this adapter enforces
 * its own tool-name authority again where the call is made, fail-closed and before the invoker runs:
 *
 *   claim       the caller holds the unit's live claim
 *   authority   the dispatch gate still passes on current durable state, over the same authority definition
 *   call        the payload is a complete typed contract whose arguments match their hash
 *   tool        the manifest manages it, it is on this lane's read-only allowlist, and nothing about it needs approval
 *   authorized  the authority lists this exact (desktop_commander, tool) pair and grants the privilege the tool consumes
 *   arguments   they satisfy the tool's strict schema
 *   scope       every path is canonical and, on its physical path, inside a scope resource
 *   runtime     the call's own bound does not exceed the authority's
 *
 * It does not mint a Desktop Commander capability or execute anything itself: the invoker is the existing transport.
 */
export class DcLaneExecutionAdapter implements WorkUnitExecutorAdapter {
  readonly lane = "dc" as const;

  constructor(
    private readonly store: CodingMissionStore,
    private readonly authority: BoundaryAuthority,
    private readonly invoker: DcToolInvoker,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async execute(dispatch: DispatchEnvelope, signal?: AbortSignal, claim?: ExecutionClaim): Promise<ResultEnvelope> {
    if (dispatch.lane !== this.lane) {
      throw new ControlStackError("execution_lane_mismatch", `dc adapter cannot execute ${dispatch.lane}`);
    }
    if (signal?.aborted) return cancelledResult(dispatch, this.now());
    const checked = this.check(dispatch, claim);
    if (isRefusal(checked)) return refusalResult(dispatch, checked, this.now());
    const { call, claimToken } = checked;
    return runWithinBudget({
      dispatch,
      maxRuntimeMs: call.maxRuntimeMs,
      callerSignal: signal,
      now: this.now,
      execute: (abort) =>
        this.invoker.invoke({
          toolName: call.toolName,
          arguments: Object.freeze({ ...call.arguments }),
          claimToken,
          signal: abort
        }),
      map: (outcome) => this.map(dispatch, outcome)
    });
  }

  /** Every pre-execution check. Nothing has run yet, so a refusal leaves no external state behind. */
  private check(
    dispatch: DispatchEnvelope,
    claim: ExecutionClaim | undefined
  ): BoundaryRefusal | { call: DcToolCall; claimToken: string } {
    const guarded = guardClaim(this.store, dispatch, claim, "tool");
    if (isRefusal(guarded)) return guarded;

    let call: DcToolCall;
    try {
      // The unit's stored payload, not the envelope's copy, is what ACS admitted.
      call = parseDcToolCall(guarded.unit.payload);
    } catch {
      return refuse("call_contract_invalid");
    }

    const definition = guardAuthority(this.authority, dispatch, guarded.unit);
    if (isRefusal(definition)) return definition;

    const refusal = this.checkCall(call, definition);
    return refusal ?? { call, claimToken: guarded.claimToken };
  }

  private checkCall(call: DcToolCall, definition: AutonomousAuthorityDefinition): BoundaryRefusal | undefined {
    const contract = dcCapabilityToolContract(call.toolName);
    const pathsOf = READ_ONLY_TOOLS[call.toolName];
    if (!contract || !pathsOf || contract.riskClass !== "read_only" || contract.requiresApproval) {
      return refuse("tool_not_supported");
    }
    // Exact: a broad runtime grant does not cover a tool nobody listed, and another runtime's grant is not this one's.
    if (!definition.toolClasses.some((tool) => tool.runtime === RUNTIME && tool.toolName === call.toolName)) {
      return refuse("tool_not_permitted");
    }
    if (!definition.maximumPrivileges.includes(PRIVILEGE_FOR_SCOPE[contract.scope] as never)) {
      return refuse("privilege_not_granted");
    }
    const parsed = contract.argsSchema.safeParse(call.arguments);
    if (!parsed.success) return refuse("arguments_invalid");
    for (const path of pathsOf(parsed.data as Record<string, unknown>)) {
      if (!isAbsolute(path) || resolve(path) !== path) return refuse("path_not_canonical");
      if (!scopeCovers(definition.scope, path)) return refuse("path_out_of_scope");
    }
    if (call.maxRuntimeMs > definition.limits.maxRuntimeMs) return refuse("runtime_exceeds_authority");
    return undefined;
  }

  /** Judges an invoker's report against the contract. A report that breaks it is never a success. */
  private map(dispatch: DispatchEnvelope, outcome: DcToolOutcome): ResultEnvelope {
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
    const violation =
      typeof outcome.resultHash !== "string" || outcome.resultHash.length === 0
        ? "result_hash_missing"
        : outcome.files !== undefined && (!Array.isArray(outcome.files) || outcome.files.length > 0)
          ? "read_only_tool_reported_changes"
          : undefined;
    if (violation) {
      return {
        ...resultBase(dispatch, finishedAt),
        outcome: "failed",
        receipts: [],
        // The call ran, so the device may have changed even though the report is unusable.
        failure: { category: "invalid_output", nativeCode: violation, retrySafe: false },
        externalStateUncertain: true
      };
    }
    return {
      ...resultBase(dispatch, finishedAt),
      outcome: "succeeded",
      receipts: [{ kind: "dc_tool_result", hash: outcome.resultHash }],
      result: { resultHash: outcome.resultHash, files: [] },
      externalStateUncertain: false
    };
  }
}
