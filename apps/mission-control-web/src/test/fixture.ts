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
