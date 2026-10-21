import type { TraceAttempt, TraceReadModel, TraceStage } from "@agent-control-stack/mission-control-contract";
import type { ExecutionAttempt, ExecutionPlanAdmission, ExecutionPlanRecord, StoredAuditEvent, WorkItem } from "@agent-control-stack/work-items";
import { redactSecrets, redactedAttributesJson } from "../redaction.js";
import type { MissionControlAttemptLease } from "../types.js";
import { displayLeaseStatus } from "./lease.js";

export interface TraceInput {
  workItem: WorkItem;
  plan?: ExecutionPlanRecord | undefined;
  admission?: ExecutionPlanAdmission | undefined;
  attempts: ExecutionAttempt[];
  leases: MissionControlAttemptLease[];
  events: StoredAuditEvent[];
  now: Date;
}

const text = (value: unknown, max: number): string => {
  const redacted = redactSecrets(value);
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted;
};
const nanosToIso = (nanos: string): string => {
  try {
    return new Date(Number(BigInt(nanos) / 1_000_000n)).toISOString();
  } catch {
    return "";
  }
};
const TERMINAL_ATTEMPT = new Set(["succeeded", "failed", "cancelled", "quarantined", "unknown", "interrupted"]);

/**
 * Pure projection of persisted authority records for one work item into the
 * request → policy → plan → admission → approval → attempt → lease → result
 * trace. Stages projected from audit events (policy, approval) are flagged
 * `derived`. Plan step params, allowed command lists, host paths and free-form
 * results are never forwarded.
 */
export function toTraceReadModel(input: TraceInput): TraceReadModel {
  const { workItem, plan, admission, attempts, leases, events, now } = input;
  const names = new Set(events.map((e) => e.name));

  const approvalEvents = events
    .filter((e) => e.name === "work_item.needs_approval" || e.name === "approval.granted" || e.name === "work_item.approved" || e.name === "work_item.rejected")
    .map((e) => ({ name: e.name, at: nanosToIso(e.timeUnixNano) }))
    .slice(-20);
  const rejected = workItem.status === "rejected" || names.has("work_item.rejected");
  const required = admission?.requiresApproval ?? (names.has("work_item.needs_approval") ? true : undefined);
  // `work_item.approved` also fires when policy allows low-risk work without a human, so it only
  // counts as a human grant when approval was actually required. An explicit approval.granted always counts.
  // Grant events are historical: one approved action leaves the item in needs_approval while others remain,
  // and a replaced plan can invalidate an earlier grant. The canonical work-item status decides while it still waits.
  const awaitingApproval = workItem.status === "needs_approval";
  const granted = !awaitingApproval && (names.has("approval.granted") || (required !== false && names.has("work_item.approved")));
  const approvalState: TraceReadModel["approval"]["state"] = rejected
    ? "rejected"
    : awaitingApproval
      ? "required"
      : granted
        ? "granted"
        : required === false
          ? "not_required"
          : required === true
            ? "required"
            : "unknown";

  const traceAttempts: TraceAttempt[] = attempts.map((a) => ({
    attemptId: a.attemptId,
    attemptNumber: a.attemptNumber,
    status: a.status,
    ...(a.claimedByWorkerId ? { claimedByWorkerId: text(a.claimedByWorkerId, 200) } : {}),
    currentFencingEpoch: a.currentFencingEpoch,
    createdAt: a.createdAt,
    ...(a.startedAt ? { startedAt: a.startedAt } : {}),
    updatedAt: a.updatedAt,
    leases: leases
      .filter((l) => l.attemptId === a.attemptId)
      .sort((x, y) => x.fencingEpoch - y.fencingEpoch)
      .map((l) => ({
        leaseId: l.leaseId,
        status: displayLeaseStatus(l, now.getTime()),
        fencingEpoch: l.fencingEpoch,
        workerId: text(l.workerId, 200),
        issuedAt: l.issuedAt,
        expiresAt: l.expiresAt,
        ...(l.closedAt ? { closedAt: l.closedAt } : {})
      }))
  }));
  const latest = traceAttempts.at(-1);
  const latestLease = latest?.leases.at(-1);

  const resultRecord = workItem.result as Record<string, unknown> | undefined;
  const result =
    resultRecord && typeof resultRecord === "object"
      ? {
          ...(typeof resultRecord.outcome === "string" ? { outcome: text(resultRecord.outcome, 60) } : {}),
          ...(typeof resultRecord.summary === "string" ? { summary: text(resultRecord.summary, 500) } : {})
        }
      : null;

  const policyDecided = names.has("policy.decided");
  const preAdmission = workItem.status === "draft" || workItem.status === "pending_policy";
  const stage = (s: TraceStage): TraceStage => s;
  const stages: TraceStage[] = [
    stage({ key: "request", label: "Request", state: "done", summary: `Requested by ${text(workItem.requester, 60)}.`, derived: false }),
    stage({
      key: "policy",
      label: "Policy decision",
      state: policyDecided ? "done" : preAdmission ? "current" : "unavailable",
      summary: policyDecided ? "A policy decision was recorded." : preAdmission ? "Awaiting policy evaluation." : "No policy decision event in the retrieved window.",
      derived: true
    }),
    stage({
      key: "plan",
      label: "Execution plan",
      state: plan ? "done" : preAdmission ? "pending" : "unavailable",
      summary: plan ? `Plan #${plan.planNumber} with ${plan.definition.steps.length} step${plan.definition.steps.length === 1 ? "" : "s"}.` : preAdmission ? "No plan drafted yet." : "No persisted plan found.",
      derived: false
    }),
    stage({
      key: "admission",
      label: "Admission",
      state: admission ? "done" : plan ? "current" : "pending",
      summary: admission ? `Admitted under policy ${text(admission.policyVersion, 60)}.` : plan ? "Plan not admitted. Execution cannot start." : "Nothing to admit yet.",
      derived: false
    }),
    stage({
      key: "approval",
      label: "Human approval",
      state: approvalState === "not_required" ? "not_applicable" : approvalState === "granted" || approvalState === "rejected" ? "done" : approvalState === "required" ? "current" : "unavailable",
      summary: { not_required: "Policy did not require approval.", required: "Waiting for a human decision.", granted: "Approval granted.", rejected: "Rejected by a human.", unknown: "Approval requirement could not be established." }[approvalState],
      derived: true
    }),
    stage({
      key: "attempt",
      label: "Execution attempt",
      state: latest ? (TERMINAL_ATTEMPT.has(latest.status) ? "done" : "current") : "pending",
      summary: latest ? `Attempt #${latest.attemptNumber} is ${latest.status.replace(/_/g, " ")}.` : "No attempt has started.",
      derived: false
    }),
    stage({
      key: "lease",
      label: "Lease and fencing",
      state: latestLease ? (latestLease.status === "active" ? "current" : "done") : "pending",
      summary: latestLease ? `Epoch ${latestLease.fencingEpoch}, ${latestLease.status}, held by ${latestLease.workerId}.` : "No lease issued.",
      derived: false
    }),
    stage({
      key: "result",
      label: "Result",
      state: result ? "done" : "pending",
      summary: result ? (result.summary ?? result.outcome ?? "A result was recorded.") : "No result recorded.",
      derived: false
    })
  ];

  const lineage =
    workItem.sourceWorkItemId || workItem.rootWorkItemId || workItem.retrySequence !== undefined
      ? {
          ...(workItem.retrySequence !== undefined ? { retrySequence: workItem.retrySequence } : {}),
          ...(workItem.sourceWorkItemId ? { sourceWorkItemId: workItem.sourceWorkItemId } : {}),
          ...(workItem.rootWorkItemId ? { rootWorkItemId: workItem.rootWorkItemId } : {}),
          ...(workItem.lineageType ? { type: String(workItem.lineageType) } : {})
        }
      : undefined;

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    workItem: {
      id: workItem.id,
      title: text(workItem.title, 300),
      intent: text(workItem.intent, 500),
      status: workItem.status,
      risk: workItem.risk,
      requester: text(workItem.requester, 100),
      createdAt: workItem.createdAt,
      updatedAt: workItem.updatedAt,
      requestedActions: workItem.requestedActions.slice(0, 64).map((a) => ({ kind: text(a.kind, 100), description: text(a.description, 300) })),
      ...(lineage ? { lineage } : {})
    },
    stages,
    plan: plan
      ? {
          planNumber: plan.planNumber,
          planHash: plan.planHash,
          objective: text(plan.definition.objective, 500),
          steps: plan.definition.steps.slice(0, 128).map((s) => ({ sequence: s.sequence, kind: text(s.action.kind, 100), description: text(s.action.description, 300) })),
          constraints: {
            executionMode: plan.definition.constraints.executionMode,
            maxRuntimeMs: plan.definition.constraints.maxRuntimeMs,
            allowedCommandCount: plan.definition.constraints.allowedCommands.length
          },
          createdAt: plan.createdAt,
          createdBy: text(plan.createdByActorId, 256)
        }
      : null,
    admission: admission
      ? {
          admissionId: admission.admissionId,
          policyVersion: text(admission.policyVersion, 128),
          policyDecisionHash: admission.policyDecisionHash,
          requiresApproval: admission.requiresApproval,
          admittedBy: text(admission.admittedByActorId, 256),
          admittedAt: admission.admittedAt
        }
      : null,
    approval: { state: approvalState, events: approvalEvents },
    attempts: traceAttempts.slice(-100),
    result,
    events: [...events]
      .sort((a, b) => a.sequence - b.sequence)
      .slice(-100)
      .map((e) => ({ sequence: e.sequence, name: e.name, at: nanosToIso(e.timeUnixNano), summary: text(redactedAttributesJson(e.attributes), 400) }))
  };
}
