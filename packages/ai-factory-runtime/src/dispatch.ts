import { randomUUID } from "node:crypto";
import { createFactoryProposal, factoryMissionSummary, type FactoryIntent } from "@agent-control-stack/ai-factory";
import type { CodingMissionStore } from "@agent-control-stack/coding-mission";
import type {
  BuildExecutionEnvelopeInput,
  CodexSwarmAttemptOutcome,
  ExecutionEnvelope,
  SwarmExecutionEvidence
} from "@agent-control-stack/engine-adapter";
import { outOfScope } from "./scope.js";

/**
 * F6: bounded lane scheduling and authority-fenced dispatch.
 *
 * ACS owns cross-attempt scheduling: one ACS work unit = one claimed attempt = one Swarm run, whose
 * lanes are subordinate and capped by the mission's parallel budget. The claim token is the fence.
 * It is rechecked immediately before dispatch, served to Swarm as an oracle for every mutating lane
 * action, and rechecked when a result arrives: a result for a claim that moved on is discarded.
 *
 * A successful run is never accepted here. It becomes `awaiting_verification` and stays owned by the
 * claim until F7's independent verification completes or fails it.
 */
export type FactoryDispatchStore = Pick<
  CodingMissionStore,
  "require" | "workUnits" | "claimUnit" | "workUnitClaim" | "failUnit" | "markOperation" | "budget"
>;

export interface FactoryEngine {
  runAttempt(input: BuildExecutionEnvelopeInput, signal?: AbortSignal): Promise<CodexSwarmAttemptOutcome>;
}

/** Builds an engine bound to this attempt's fence oracle (e.g. a CodexSwarmEngineAdapter with fenceCheck). */
export type FactoryEngineFactory = (fenceCheck: () => boolean) => FactoryEngine;

export interface FactoryDispatchRequest {
  missionId: string;
  unitId: string;
  /** The admitted intent, re-supplied and checked against the hash bound into the mission. */
  intent: unknown;
  planId: string;
  planDigest: string;
  workspace: { allocationId: string; hostPath: string };
  workerId: string;
}

export type FactoryDispatchResult =
  | { status: "not_claimed"; outcome: string }
  | { status: "refused_before_dispatch"; reason: string }
  | { status: "fenced"; reason: "claim_moved_before_dispatch" | "late_result_fenced" }
  | { status: "unknown"; reason: string }
  | { status: "refused"; reason: string }
  | { status: "blocked_integration"; reason: string; overlaps: number }
  | {
      status: "awaiting_verification";
      claimToken: string;
      envelope: ExecutionEnvelope;
      evidence: SwarmExecutionEvidence;
    };

export async function dispatchFactoryUnit(
  deps: { store: FactoryDispatchStore; engine: FactoryEngineFactory; now?: () => Date },
  request: FactoryDispatchRequest,
  signal?: AbortSignal
): Promise<FactoryDispatchResult> {
  const now = () => deps.now?.() ?? new Date();
  let intent: FactoryIntent;
  let intentHash: string;
  try {
    const proposal = createFactoryProposal(request.intent);
    intent = proposal.intent;
    intentHash = proposal.intentHash;
  } catch {
    return { status: "refused_before_dispatch", reason: "intent_invalid" };
  }
  const mission = deps.store.require(request.missionId);
  if (factoryMissionSummary({ orderId: intent.orderId, intentHash }) !== mission.summary) {
    return { status: "refused_before_dispatch", reason: "intent_mismatch" };
  }
  const unit = deps.store.workUnits(request.missionId).find((candidate) => candidate.unitId === request.unitId);
  if (!unit || unit.kind !== "coding" || unit.payload?.kind !== "coding") {
    return { status: "refused_before_dispatch", reason: "unit_not_dispatchable" };
  }
  const unitPaths = unit.payload.files ?? [];
  if (unitPaths.length === 0) return { status: "refused_before_dispatch", reason: "unit_has_no_scope" };

  const token = randomUUID();
  const claim = deps.store.claimUnit(request.missionId, request.unitId, {
    token,
    workerId: request.workerId,
    route: { engine: "codex-swarm", planDigest: request.planDigest },
    claimedAt: now().toISOString()
  });
  if (!claim.ok) return { status: "not_claimed", outcome: claim.outcome };

  const fenceCurrent = (): boolean => {
    try {
      const current = deps.store.workUnitClaim(request.missionId, request.unitId);
      return current?.claimToken === token && current.status === "running" && current.attempt === claim.attempt;
    } catch {
      return false;
    }
  };
  const fail = (category: "policy_denied" | "invalid_output" | "verification_failure" | "lease_lost", reason: string) => {
    if (fenceCurrent()) {
      deps.store.failUnit(request.missionId, request.unitId, token, { category, retryable: false, now: now().toISOString() });
    }
    return { status: "refused" as const, reason };
  };

  const parallel = deps.store.budget(request.missionId)?.limits.parallel_work_units;
  const maxLanes = Math.max(1, Math.min(intent.budget.maxLanes, parallel ?? intent.budget.maxLanes));
  const issuedAt = now();
  const remainingMs = Math.max(1, intent.budget.maxWallClockMs - (issuedAt.getTime() - Date.parse(mission.createdAt)));
  const envelopeInput: BuildExecutionEnvelopeInput = {
    acsWorkItemId: request.missionId,
    acsAttemptId: request.unitId + ".a" + claim.attempt,
    planId: request.planId,
    admittedPlanHash: request.planDigest,
    leaseId: "lease-" + token,
    fencingEpoch: claim.attempt,
    auditCorrelationId: "factory-" + token,
    idempotencyKey: request.missionId.slice(-24) + "-" + request.unitId + "-" + claim.attempt,
    workspace: { ...request.workspace, expectedBaseSha: mission.baseSha },
    objective: (unit.title + "\n\n" + intent.objective).slice(0, 8_000),
    permittedPaths: [...unitPaths],
    forbiddenPaths: [...intent.forbiddenPaths],
    permittedOwnerProfiles: ["codex"],
    maxLanes,
    maxLoopIterations: 0,
    networkPolicy: "none",
    timeoutMs: Math.min(remainingMs, 24 * 60 * 60 * 1_000),
    acceptanceCommands: [],
    validationCommands: [],
    evidenceRequirements: ["diff", "tests"],
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + Math.min(remainingMs, 24 * 60 * 60 * 1_000)).toISOString()
  };

  // Recheck the fence immediately before handing authority to the engine.
  if (!fenceCurrent()) return { status: "fenced", reason: "claim_moved_before_dispatch" };
  const outcome = await deps.engine(fenceCurrent).runAttempt(envelopeInput, signal);
  // A result for a claim that has moved on (revoked, released, retried) is discarded untouched.
  if (!fenceCurrent()) return { status: "fenced", reason: "late_result_fenced" };

  if (outcome.status === "unknown") {
    // Effects are unknown: never success, never blind replay. F9 reconciles.
    deps.store.markOperation(request.missionId, request.unitId, "unknown");
    return { status: "unknown", reason: outcome.reason };
  }
  if (outcome.status === "refused") {
    return fail(outcome.reason.includes("fence_lost") ? "lease_lost" : "invalid_output", outcome.reason);
  }
  const evidence = outcome.evidence;
  if (evidence.exitStatus !== "completed") return fail("invalid_output", "swarm_exit_" + evidence.exitStatus);
  if (evidence.laneResults.length > maxLanes) return fail("policy_denied", "lane_budget_exceeded");
  const overlaps = evidence.integration?.overlaps ?? [];
  if (overlaps.length > 0) {
    // Overlapping lanes need human or planner resolution; ACS will not pick a winner.
    deps.store.markOperation(request.missionId, request.unitId, "conflict");
    return { status: "blocked_integration", reason: "lane_overlap", overlaps: overlaps.length };
  }
  const laneIds = evidence.laneResults.map((lane) => lane.laneId);
  if (evidence.integration) {
    const order = evidence.integration.topologicalOrder;
    if (order.length !== laneIds.length || new Set(order).size !== order.length || order.some((id) => !laneIds.includes(id))) {
      deps.store.markOperation(request.missionId, request.unitId, "conflict");
      return { status: "blocked_integration", reason: "integration_order_invalid", overlaps: 0 };
    }
  }
  // Scope is enforced on what lanes report here, and again on the real git diff in F7.
  const reported = evidence.laneResults.flatMap((lane) => lane.filesChanged);
  const escaped = outOfScope(reported, unitPaths, intent.forbiddenPaths);
  if (escaped.length > 0 || evidence.laneResults.some((lane) => !lane.footprintResult.ok)) {
    return fail("policy_denied", "out_of_scope_files");
  }
  if (evidence.aggregateVerdict === "FAIL" || evidence.aggregateVerdict === "BLOCKED") {
    return fail("verification_failure", "swarm_verdict_" + evidence.aggregateVerdict.toLowerCase());
  }
  return { status: "awaiting_verification", claimToken: token, envelope: outcome.envelope, evidence };
}
