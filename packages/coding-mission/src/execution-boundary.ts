import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { ControlStackError, redactValue, stableHash } from "@agent-control-stack/shared";
import type { AutonomousAuthorityDefinition } from "./authority.js";
import type { MissionAuthorityLedger } from "./child-work.js";
import type { FailureCategory, WorkUnit, WorkUnitKind } from "./mission-model.js";
import type { CodingMissionStore } from "./store.js";
import {
  deadlineResult,
  failureCategoryForCode,
  resultBase,
  type DispatchEnvelope,
  type ExecutionClaim,
  type ResultEnvelope
} from "./worker-execution.js";

/**
 * The checks every lane adapter makes where work actually runs, as opposed to at dispatch. Dispatch and execution are
 * separated in time, so the claim, the authority and the unit can change in between. Each adapter adds its own contract
 * checks (what the unit may touch) on top of these; none of them is skipped by a lane.
 */

/** The authority surface an adapter re-reads at the execution boundary; `MissionAuthorityLedger` implements it. */
export type BoundaryAuthority = Pick<MissionAuthorityLedger, "verifyDispatch" | "missionAuthority" | "unitAuthority">;

export interface BoundaryRefusal {
  code: string;
  category: FailureCategory;
}

export const isRefusal = (value: unknown): value is BoundaryRefusal =>
  typeof value === "object" && value !== null && "code" in value && "category" in value;

export const refuse = (code: string, category: FailureCategory = "policy_denied"): BoundaryRefusal => ({
  code,
  category
});

/**
 * The physical path `path` names: the realpath of the path itself when it exists, otherwise the realpath of its nearest
 * existing ancestor with the missing segments appended. Undefined (fail closed) on any other error, including a path
 * that exists as a dangling or unreadable symlink, since where it would point is not knowable now.
 */
export function physicalPath(path: string): string | undefined {
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

/** Containment is judged on physical paths, so a symlink inside a scope cannot carry a path outside it. */
export function scopeCovers(scope: AutonomousAuthorityDefinition["scope"], target: string): boolean {
  const p = physicalPath(target);
  return p !== undefined && physicalScopeCovers(scope, p);
}

/** Judges an already-resolved physical path against the scope without resolving it again. */
export function physicalScopeCovers(scope: AutonomousAuthorityDefinition["scope"], physical: string): boolean {
  const path = physical;
  return scope.some((allowed) => {
    if (allowed.kind !== "repository" && allowed.kind !== "path") return false;
    if (!isAbsolute(allowed.id)) return false;
    const root = physicalPath(allowed.id);
    if (root === undefined) return false;
    if (root === path) return true;
    if (allowed.coverage !== "descendants") return false;
    const suffix = relative(root, path);
    return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
  });
}

/** The caller must hold the unit's live claim: the token hash matches the dispatch and the store still says so. */
export function guardClaim(
  store: CodingMissionStore,
  dispatch: DispatchEnvelope,
  claim: ExecutionClaim | undefined,
  unitKind: WorkUnitKind
): { unit: WorkUnit; claimToken: string } | BoundaryRefusal {
  if (!claim || stableHash(claim.claimToken) !== dispatch.claimTokenHash) return refuse("claim_mismatch");
  let unit: WorkUnit | undefined;
  try {
    unit = store.workUnits(dispatch.missionId).find((candidate) => candidate.unitId === dispatch.unitId);
  } catch {
    // An unreadable stored unit is a refusal, so the runner records the failure and releases the claim.
    return refuse("unit_unreadable");
  }
  if (
    !unit ||
    unit.kind !== unitKind ||
    unit.claimToken !== claim.claimToken ||
    unit.workerId !== dispatch.workerId ||
    !["running", "checkpointed"].includes(unit.status)
  ) {
    return refuse("claim_not_live", "lease_lost");
  }
  return { unit, claimToken: claim.claimToken };
}

/** The dispatch gate must still pass on current durable state, over the same authority definition dispatch used. */
export function guardAuthority(
  authority: BoundaryAuthority,
  dispatch: DispatchEnvelope,
  unit: WorkUnit
): AutonomousAuthorityDefinition | BoundaryRefusal {
  try {
    const verdict = authority.verifyDispatch({
      missionId: dispatch.missionId,
      unitId: dispatch.unitId,
      workerId: dispatch.workerId,
      lane: dispatch.lane,
      attempt: dispatch.unitAttempt
    });
    if (!verdict.ok) {
      return refuse(verdict.reason, verdict.reason === "authority_expired" ? "authority_expired" : "policy_denied");
    }
    if (verdict.unitAuthorityHash !== dispatch.authority.unitAuthorityHash) return refuse("authority_changed");
    const record = unit.parentUnitId ? authority.unitAuthority(dispatch.missionId, dispatch.unitId) : undefined;
    return (
      record?.definition ?? authority.missionAuthority(dispatch.missionId)?.definition ?? refuse("authority_missing")
    );
  } catch (error) {
    if (error instanceof ControlStackError && error.code === "authority_integrity") {
      return refuse("authority_integrity_failure");
    }
    throw error;
  }
}

/** A refusal result. The executor never ran, so there is no external state to be uncertain about. */
export function refusalResult(dispatch: DispatchEnvelope, refusal: BoundaryRefusal, now: string): ResultEnvelope {
  return {
    ...resultBase(dispatch, now),
    outcome: "failed",
    receipts: [],
    failure: { category: refusal.category, nativeCode: refusal.code, retrySafe: false },
    externalStateUncertain: false
  };
}

export function cancelledResult(dispatch: DispatchEnvelope, now: string): ResultEnvelope {
  return {
    ...resultBase(dispatch, now),
    outcome: "cancelled",
    receipts: [],
    failure: { category: "cancelled", retrySafe: false },
    externalStateUncertain: false
  };
}

/**
 * Runs `execute` for at most `maxRuntimeMs`, capped by the time ACS has left on the dispatch. It never starts the executor
 * when no time is left (or the deadline is unparseable), stops it with the signal at the bound, and records a timeout as
 * an uncertain outcome. An executor that throws becomes a failed, uncertain result with a redacted message.
 */
export async function runWithinBudget<T>(input: {
  dispatch: DispatchEnvelope;
  maxRuntimeMs: number;
  callerSignal: AbortSignal | undefined;
  now: () => string;
  execute: (signal: AbortSignal) => Promise<T>;
  map: (value: T) => ResultEnvelope;
}): Promise<ResultEnvelope> {
  const { dispatch, callerSignal, now } = input;
  const abort = new AbortController();
  const onCallerAbort = () => abort.abort();
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  const remaining =
    dispatch.authority.deadlineAt === undefined
      ? Number.POSITIVE_INFINITY
      : Date.parse(dispatch.authority.deadlineAt) - Date.parse(now());
  const budgetMs = Math.min(input.maxRuntimeMs, remaining);
  if (!(budgetMs > 0)) {
    callerSignal?.removeEventListener("abort", onCallerAbort);
    return deadlineResult(dispatch, now());
  }
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<"timeout">((resolveTimeout) => {
    timer = setTimeout(() => {
      abort.abort();
      resolveTimeout("timeout");
    }, budgetMs);
  });
  const execution = input.execute(abort.signal);
  execution.catch(() => undefined); // a late failure after the bound is not an unhandled rejection
  try {
    const winner = await Promise.race([execution, expired]);
    if (winner === "timeout") return deadlineResult(dispatch, now());
    return input.map(winner);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
    return {
      ...resultBase(dispatch, now()),
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
