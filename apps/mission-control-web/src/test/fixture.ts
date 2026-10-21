import type { OverviewReadModel } from "@agent-control-stack/mission-control-contract";

/** Test-only builder for a contract-valid read model. Never imported by production code. */
export function overviewFixture(over: Partial<OverviewReadModel> = {}): OverviewReadModel {
  return {
    schemaVersion: 1,
    generatedAt: "2026-10-19T12:00:00.000Z",
    eventSequence: 3,
    execution: { mode: "strict", backend: "dry_run", dryRun: "yes" },
    sections: {
      needsYou: { status: "ok" },
      network: { status: "ok" },
      pipeline: { status: "ok" },
      observability: { status: "ok" },
      activity: { status: "ok" },
      readiness: { status: "ok" }
    },
    needsYou: {
      approvals: 1,
      blocked: 0,
      quarantined: 0,
      items: [{ workItemId: "wrk_abcdef123456", title: "Review deployment request", status: "needs_approval", risk: "high", since: "2026-10-19T11:58:00.000Z" }],
      expiringLeases: []
    },
    network: {
      nodes: [
        { id: "agent:a1", kind: "agent", label: "Runtime investigator", liveness: "online", detail: "LOCAL_CODING_AGENT", capabilities: ["code"], lastHeartbeatAt: "2026-10-19T11:59:00.000Z" },
        { id: "agent:a2", kind: "agent", label: "Idle reviewer", liveness: "unknown", detail: "REVIEW_PLANNING_AGENT" },
        { id: "work:w1", kind: "work_item", label: "Inspect queue latency", detail: "running" }
      ],
      edges: [{ from: "agent:a1", to: "work:w1", kind: "active_lease", fencingEpoch: 2 }]
    },
    pipeline: {
      stages: [
        { key: "needs_approval", label: "Waiting Approval", count: 1, countSource: "store", items: [{ id: "wrk_abcdef123456", title: "Review deployment request", intent: "Ship it", risk: "high", status: "needs_approval", updatedAt: "2026-10-19T11:58:00.000Z" }] },
        { key: "running", label: "Running", count: 1, countSource: "store", items: [{ id: "wrk_run00000001", title: "Inspect queue latency", intent: "Measure", risk: "low", status: "running", updatedAt: "2026-10-19T11:59:00.000Z", agentId: "a1" }] },
        { key: "succeeded", label: "Completed", count: 0, countSource: "store", items: [] }
      ]
    },
    observability: {
      telemetry: { windowStart: "2026-10-18T12:00:00.000Z", windowEnd: "2026-10-19T12:00:00.000Z", succeeded: 3, failed: 1, averageRunMs: 1200, averageQueueMs: 300, throughput: Array.from({ length: 24 }, (_, i) => ({ at: new Date(Date.UTC(2026, 9, 18, 12 + i)).toISOString(), started: 0, completed: i === 23 ? 3 : 0, failed: i === 23 ? 1 : 0 })) },
      admission: { active: 1, capacity: 4, queued: 0, saturated: false }
    },
    infrastructure: { agents: { registered: 2, online: 1 }, executors: { total: 2, configured: 0, attestedRuntimes: 0 }, connectors: { registered: 1, enabled: 1, activeSessions: 0 } },
    activity: [{ sequence: 3, id: "e3", name: "work_item.running", at: "2026-10-19T11:59:00.000Z", summary: '{"status":"running"}' }],
    readiness: { ok: true, checks: [{ name: "read", ok: true }, { name: "integrity", ok: true }] },
    ...over
  };
}

import type { QueueReadModel, TraceReadModel } from "@agent-control-stack/mission-control-contract";

export function queueFixture(over: Partial<QueueReadModel> = {}): QueueReadModel {
  const base = { createdAt: "2026-10-19T11:00:00.000Z", updatedAt: "2026-10-19T11:50:00.000Z", intent: "Browser verification" };
  return {
    schemaVersion: 1,
    generatedAt: "2026-10-19T12:00:00.000Z",
    counts: { source: "store", byStatus: { running: 1, needs_approval: 1, succeeded: 12 } },
    finishedWindow: { shown: 1, total: 12 },
    items: [
      { ...base, id: "wrk_run00000001", title: "Inspect queue latency", status: "running", stageLabel: "Running", risk: "low", plan: { state: "admitted", planNumber: 1, requiresApproval: false }, attempt: { status: "running", number: 1, workerId: "agent-a" }, lease: { status: "active", fencingEpoch: 2, workerId: "agent-a", expiresAt: "2026-10-19T12:30:00.000Z" } },
      { ...base, id: "wrk_appr0000002", title: "Review deployment request", status: "needs_approval", stageLabel: "Waiting Approval", risk: "high", plan: { state: "drafted", planNumber: 1 } },
      { ...base, id: "wrk_done0000003", title: "Read runtime heartbeat", status: "succeeded", stageLabel: "Completed", risk: "low", plan: { state: "unknown" }, lineage: { retrySequence: 1, sourceWorkItemId: "wrk_run00000001" } }
    ],
    ...over
  };
}

export function traceFixture(over: Partial<TraceReadModel> = {}): TraceReadModel {
  return {
    schemaVersion: 1,
    generatedAt: "2026-10-19T12:00:00.000Z",
    workItem: { id: "wrk_run00000001", title: "Inspect queue latency", intent: "Measure it", status: "running", risk: "low", requester: "user", createdAt: "2026-10-19T11:00:00.000Z", updatedAt: "2026-10-19T11:50:00.000Z", requestedActions: [{ kind: "fs.read", description: "read" }] },
    stages: [
      { key: "request", label: "Request", state: "done", summary: "Requested by user.", derived: false },
      { key: "policy", label: "Policy decision", state: "done", summary: "A policy decision was recorded.", derived: true },
      { key: "plan", label: "Execution plan", state: "done", summary: "Plan #1 with 1 step.", derived: false },
      { key: "admission", label: "Admission", state: "done", summary: "Admitted under policy p1.", derived: false },
      { key: "approval", label: "Human approval", state: "not_applicable", summary: "Policy did not require approval.", derived: true },
      { key: "attempt", label: "Execution attempt", state: "current", summary: "Attempt #1 is running.", derived: false },
      { key: "lease", label: "Lease and fencing", state: "current", summary: "Epoch 2, active, held by agent-a.", derived: false },
      { key: "result", label: "Result", state: "pending", summary: "No result recorded.", derived: false }
    ],
    plan: { planNumber: 1, planHash: "a".repeat(64), objective: "Measure latency", steps: [{ sequence: 1, kind: "fs.read", description: "read it" }], constraints: { executionMode: "dry_run", maxRuntimeMs: 5000, allowedCommandCount: 2 }, createdAt: "2026-10-19T11:01:00.000Z", createdBy: "planner" },
    admission: { admissionId: "adm-1", policyVersion: "p1", policyDecisionHash: "b".repeat(64), requiresApproval: false, admittedBy: "policy", admittedAt: "2026-10-19T11:02:00.000Z" },
    approval: { state: "not_required", events: [] },
    attempts: [{ attemptId: "att-1", attemptNumber: 1, status: "running", claimedByWorkerId: "agent-a", currentFencingEpoch: 2, createdAt: "2026-10-19T11:03:00.000Z", startedAt: "2026-10-19T11:04:00.000Z", updatedAt: "2026-10-19T11:50:00.000Z", leases: [{ leaseId: "l1", status: "active", fencingEpoch: 1, workerId: "agent-old", issuedAt: "2026-10-19T11:03:00.000Z", expiresAt: "2026-10-19T12:30:00.000Z" }, { leaseId: "l2", status: "active", fencingEpoch: 2, workerId: "agent-a", issuedAt: "2026-10-19T11:40:00.000Z", expiresAt: "2026-10-19T12:30:00.000Z" }] }],
    result: null,
    events: [{ sequence: 1, name: "work_item.created", at: "2026-10-19T11:00:00.000Z", summary: "{}" }],
    ...over
  };
}

import type { ApprovalsReadModel, ExecutionReadModel } from "@agent-control-stack/mission-control-contract";

export function approvalsFixture(over: Partial<ApprovalsReadModel> = {}): ApprovalsReadModel {
  return {
    schemaVersion: 1,
    generatedAt: "2026-10-19T12:00:00.000Z",
    viewer: { canApprove: true, canWrite: true },
    slaMs: 1_800_000,
    items: [
      { id: "wrk_appr0000002", title: "Review deployment request", intent: "Ship the release", status: "needs_approval", risk: "high", requester: "user", since: "2026-10-19T10:00:00.000Z", overSla: true, actions: [{ actionHash: "d".repeat(64), kind: "fs.write", description: "write config" }] },
      { id: "wrk_self0000003", title: "Review storage mutation", intent: "Mutate storage", status: "needs_approval", risk: "high", requester: "user", since: "2026-10-19T11:30:00.000Z", overSla: false, actions: [] },
      { id: "wrk_blk00000004", title: "Check connector scopes", intent: "Inspect", status: "blocked", risk: "low", requester: "user", since: "2026-10-19T11:40:00.000Z", overSla: false, actions: [] }
    ],
    ...over
  };
}

export function executionFixture(over: Partial<ExecutionReadModel> = {}): ExecutionReadModel {
  const t = overviewFixture().observability.telemetry!;
  return {
    schemaVersion: 1,
    generatedAt: "2026-10-19T12:00:00.000Z",
    viewer: { canApprove: true, canWrite: true },
    summary: { running: 1, failed: 1, attention: 0, expiringLeases: 1 },
    attempts: [
      { attemptId: "att-1", workItemId: "wrk_run00000001", title: "Inspect queue latency", workItemStatus: "running", risk: "low", attemptNumber: 1, status: "running", workerId: "agent-a", fencingEpoch: 2, lease: { status: "active", expiresAt: "2026-10-19T12:00:30.000Z", expiringSoon: true }, startedAt: "2026-10-19T11:50:00.000Z", updatedAt: "2026-10-19T11:59:00.000Z" },
      { attemptId: "att-2", workItemId: "wrk_fail0000005", title: "Review policy boundaries", workItemStatus: "failed", risk: "low", attemptNumber: 1, status: "failed", workerId: "agent-b", fencingEpoch: 1, lease: { status: "consumed", expiresAt: "2026-10-19T11:00:00.000Z", expiringSoon: false }, startedAt: "2026-10-19T10:50:00.000Z", updatedAt: "2026-10-19T10:55:00.000Z", durationMs: 300000 }
    ],
    telemetry: t,
    admission: { active: 1, capacity: 4, queued: 0, saturated: false },
    dryRun: "yes",
    ...over
  };
}
