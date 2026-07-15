const healthyChecks = [
  { id: "read", label: "Read", status: "pass" },
  { id: "write", label: "Write", status: "pass" },
  { id: "migrations", label: "Migrations", status: "pass" },
  { id: "auditChain", label: "Audit chain", status: "pass" }
];

const populatedAgents = [
  { id: "DEMO-AGENT-01", label: "Implementation Agent", role: "Implementation", status: "online", health: "healthy" },
  { id: "DEMO-AGENT-02", label: "Review Agent", role: "Review and planning", status: "online", health: "healthy" },
  { id: "DEMO-AGENT-03", label: "Research Agent", role: "Broad research", status: "stale", health: "warning" },
  { id: "DEMO-AGENT-04", label: "Orchestration Agent", role: "Orchestration", status: "observed", health: "unknown" },
  { id: "DEMO-AGENT-05", label: "Desktop Bridge", role: "Local bridge", status: "offline", health: "unknown" }
];

const populatedWorkItems = [
  {
    id: "DEMO-WRK-201",
    title: "Inspect package dependency boundaries",
    requesterClass: "agent",
    status: "succeeded",
    risk: "low",
    actionKinds: ["fs.read"],
    targetClass: "reviewed repository",
    assignedAgentId: "DEMO-AGENT-02",
    result: { category: "dry_run_complete", summary: "Dry-run result recorded.", executionMode: "dry_run" }
  },
  {
    id: "DEMO-WRK-202",
    title: "Replay approval lifecycle checks",
    requesterClass: "agent",
    status: "succeeded",
    risk: "medium",
    actionKinds: ["agent.prompt"],
    targetClass: "control-plane fixture",
    assignedAgentId: "DEMO-AGENT-02",
    result: { category: "dry_run_complete", summary: "Redacted dry-run result recorded.", executionMode: "dry_run" }
  },
  {
    id: "DEMO-WRK-203",
    title: "Verify audit-chain continuity",
    requesterClass: "system",
    status: "running",
    risk: "low",
    actionKinds: ["fs.read"],
    targetClass: "synthetic audit fixture",
    assignedAgentId: "DEMO-AGENT-01"
  },
  {
    id: "DEMO-WRK-204",
    title: "Update gateway authorization guard",
    requesterClass: "agent",
    status: "needs_approval",
    risk: "medium",
    actionKinds: ["fs.write"],
    targetClass: "synthetic source tree",
    assignedAgentId: "DEMO-AGENT-01",
    approval: {
      required: true,
      actionCount: 1,
      fingerprintRecorded: true,
      fingerprintValue: "withheld",
      summary: "One exact file-write action awaits operator approval."
    }
  },
  {
    id: "DEMO-WRK-205",
    title: "Test destructive-command denial",
    requesterClass: "agent",
    status: "blocked",
    risk: "critical",
    actionKinds: ["shell"],
    targetClass: "synthetic control boundary",
    assignedAgentId: "DEMO-AGENT-04",
    result: { category: "policy_denied", summary: "Policy denied the proposed action." }
  },
  {
    id: "DEMO-WRK-206",
    title: "Collect adapter diagnostics",
    requesterClass: "system",
    status: "failed",
    risk: "low",
    actionKinds: ["fs.read"],
    targetClass: "synthetic adapter fixture",
    assignedAgentId: "DEMO-AGENT-03",
    result: { category: "lease_expired", summary: "Worker lease expired.", executionMode: "dry_run" }
  }
];

const populatedActivity = [
  { id: "DEMO-EVT-042", sequence: 42, eventType: "agent.heartbeat", subjectId: "DEMO-AGENT-01", summary: "Recent heartbeat recorded", scenarioOffset: "T+17:45", tone: "neutral" },
  { id: "DEMO-EVT-041", sequence: 41, eventType: "work_item.failed", subjectId: "DEMO-WRK-206", summary: "Work item failed: worker lease expired", scenarioOffset: "T+16:00", tone: "danger" },
  { id: "DEMO-EVT-040", sequence: 40, eventType: "work_item.needs_approval", subjectId: "DEMO-WRK-204", summary: "Exact file-write action awaits operator approval", scenarioOffset: "T+14:01", tone: "warning" },
  { id: "DEMO-EVT-039", sequence: 39, eventType: "policy.decided", subjectId: "DEMO-WRK-204", summary: "Policy decision: require approval", scenarioOffset: "T+14:00", tone: "warning" },
  { id: "DEMO-EVT-038", sequence: 38, eventType: "work_item.blocked", subjectId: "DEMO-WRK-205", summary: "Denied action moved the item to blocked", scenarioOffset: "T+13:01", tone: "danger" },
  { id: "DEMO-EVT-037", sequence: 37, eventType: "policy.decided", subjectId: "DEMO-WRK-205", summary: "Policy decision: deny", scenarioOffset: "T+13:00", tone: "danger" },
  { id: "DEMO-EVT-036", sequence: 36, eventType: "work_item.running", subjectId: "DEMO-WRK-203", summary: "Lease-bound worker claimed approved work", scenarioOffset: "T+12:00", tone: "neutral" },
  { id: "DEMO-EVT-035", sequence: 35, eventType: "work_item.succeeded", subjectId: "DEMO-WRK-202", summary: "Redacted dry-run result recorded", scenarioOffset: "T+09:00", tone: "success" }
];

const populatedMetrics = {
  agentsObserved: 5,
  agentsOnline: 2,
  runningWorkItems: 1,
  pendingApprovals: 1,
  failedOrBlocked: 2,
  auditIntegrity: { status: "verified", eventCount: 42 }
};

export const scenarioOrder = [
  "populated",
  "empty",
  "degraded",
  "failed_work",
  "pending_approval",
  "audit_integrity_failure",
  "data_unavailable"
];

export const fixtures = {
  populated: {
    label: "Populated",
    summary: "A balanced synthetic snapshot showing policy, approval, worker, and audit states.",
    banner: "Synthetic populated state. Every record below is authored demonstration data.",
    metrics: populatedMetrics,
    checks: healthyChecks,
    agents: populatedAgents,
    workItems: populatedWorkItems,
    activity: populatedActivity,
    focusId: "DEMO-WRK-204"
  },
  empty: {
    label: "Empty",
    summary: "The control plane has no synthetic work or agent observations in this scenario.",
    banner: "Synthetic empty state. No demo activity exists in this scenario.",
    metrics: {
      agentsObserved: 0,
      agentsOnline: 0,
      runningWorkItems: 0,
      pendingApprovals: 0,
      failedOrBlocked: 0,
      auditIntegrity: { status: "verified", eventCount: 0 }
    },
    checks: healthyChecks,
    agents: [],
    workItems: [],
    activity: [],
    focusId: null
  },
  degraded: {
    label: "Degraded",
    summary: "A synthetic storage write-check failure with read, migration, and audit checks intact.",
    banner: "Synthetic degraded state: the data-store write check failed. Read, migration, and audit checks passed.",
    metrics: { ...populatedMetrics, agentsOnline: 1 },
    checks: healthyChecks.map((check) => check.id === "write" ? { ...check, status: "fail", publicCode: "db_write_failed" } : check),
    agents: populatedAgents.map((agent) => agent.id === "DEMO-AGENT-01" ? { ...agent, status: "stale", health: "warning" } : agent),
    workItems: populatedWorkItems,
    activity: populatedActivity,
    focusId: "DEMO-WRK-203"
  },
  failed_work: {
    label: "Failed work",
    summary: "A terminal synthetic work-item failure represented by an allowlisted category.",
    banner: "Synthetic failed-work state. The visible failure contains no runtime diagnostics.",
    metrics: populatedMetrics,
    checks: healthyChecks,
    agents: populatedAgents,
    workItems: populatedWorkItems,
    activity: populatedActivity,
    focusId: "DEMO-WRK-206"
  },
  pending_approval: {
    label: "Pending approval",
    summary: "A synthetic file-write action waiting on one exact-action operator approval.",
    banner: "Synthetic pending-approval state. This public preview cannot approve or reject work.",
    metrics: populatedMetrics,
    checks: healthyChecks,
    agents: populatedAgents,
    workItems: populatedWorkItems,
    activity: populatedActivity,
    focusId: "DEMO-WRK-204"
  },
  audit_integrity_failure: {
    label: "Audit-integrity failure",
    summary: "A synthetic integrity mismatch that demonstrates the fail-closed write boundary.",
    banner: "Synthetic integrity failure: audit verification failed. Writes are disabled.",
    metrics: {
      ...populatedMetrics,
      auditIntegrity: { status: "failed", eventCount: 42 }
    },
    checks: healthyChecks.map((check) => {
      if (check.id === "auditChain") return { ...check, status: "fail", publicCode: "audit_chain_event_hash_mismatch" };
      if (check.id === "write") return { ...check, status: "fail", publicCode: "audit_chain_invalid" };
      return check;
    }),
    agents: populatedAgents,
    workItems: populatedWorkItems,
    activity: [
      { id: "DEMO-EVT-043", sequence: 43, eventType: "audit.verification_failed", subjectId: "DEMO-WRK-205", summary: "Integrity verification failed; write path disabled", scenarioOffset: "T+18:00", tone: "danger" },
      ...populatedActivity
    ],
    focusId: "DEMO-WRK-205"
  },
  data_unavailable: {
    label: "Data unavailable",
    summary: "The bundled demonstration fixture could not be presented.",
    banner: "Demo snapshot unavailable. No healthy state or zero values have been substituted.",
    metrics: null,
    checks: healthyChecks.map((check) => ({ ...check, status: "unknown" })),
    agents: [],
    workItems: [],
    activity: [],
    focusId: null
  }
};
