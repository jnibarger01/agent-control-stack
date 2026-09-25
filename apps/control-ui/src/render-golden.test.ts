import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  renderDashboard,
  renderDashboardFragments,
  renderWorkItemDetailHtml,
  toMissionControlAttemptLease,
  type MissionControlViewModel
} from "./index.js";

// Golden files pin the full rendered output so structural refactors of the
// renderer can prove they changed nothing. After an intended markup change,
// regenerate with `npx vitest run apps/control-ui/src/render-golden.test.ts -u`
// and review the diff under __golden__/.

const now = new Date("2026-07-05T00:40:00.000Z");
const nano = (iso: string) => String(Date.parse(iso) * 1_000_000);
// Assembled at runtime so secret scanners do not flag the fixture source.
const fakeToken = ["gh", "p_", "0".repeat(36)].join("");
const fakeKey = ["s", "k-", "notARealKey"].join("");

const baseItem = {
  requester: "user" as const,
  intent: "verify rendering",
  target: { cwd: "/repo", files: ["src/index.ts"] },
  requestedActions: [{ kind: "fs.read", description: "inspect source", params: { paths: ["src/index.ts"] } }],
  risk: "low" as const,
  createdAt: "2026-07-05T00:00:00.000Z",
  updatedAt: "2026-07-05T00:00:00.000Z"
};

const needsApproval = {
  ...baseItem,
  id: "wrk_approve",
  title: "Approve me",
  status: "needs_approval" as const,
  risk: "high" as const
};
const blocked = {
  ...baseItem,
  id: "wrk_blocked",
  title: "Blocked task",
  status: "blocked" as const,
  updatedAt: "2026-07-05T00:30:00.000Z",
  result: { error: `worker lease expired token=${fakeToken}` }
};
const running = { ...baseItem, id: "wrk_running", title: "Running task", status: "running" as const };
const quarantined = { ...baseItem, id: "wrk_quarantined", title: "Quarantined task", status: "quarantined" as const };
const succeeded = {
  ...baseItem,
  id: "wrk_done",
  title: "Finished task",
  status: "succeeded" as const,
  risk: "medium" as const
};

const plan = {
  planId: "plan_1",
  workItemId: running.id,
  planNumber: 1,
  definition: {
    schemaVersion: "acs.execution-plan.v1" as const,
    workItemId: running.id,
    subjectInputHash: "a".repeat(64),
    objective: "verify rendering",
    target: { cwd: "/repo" },
    steps: [
      {
        stepId: "step-001",
        sequence: 1,
        action: { kind: "fs.read", description: "inspect source", params: {} },
        successCriteria: []
      }
    ],
    constraints: {
      executionMode: "dry_run" as const,
      network: "none" as const,
      localGitOnly: true as const,
      allowPush: false as const,
      allowDeployment: false as const,
      allowedCommands: [],
      maxRuntimeMs: 300_000
    }
  },
  planHash: "b".repeat(64),
  subjectInputHash: "a".repeat(64),
  createdByActorId: "user",
  createdAt: "2026-07-05T00:00:00.000Z"
};

const admission = {
  admissionId: "admission_1",
  workItemId: running.id,
  planId: "plan_1",
  planHash: "b".repeat(64),
  policyVersion: "v1",
  policyDecisionHash: "c".repeat(64),
  requiresApproval: true,
  admittedByActorId: "policy-gate",
  admittedAt: "2026-07-05T00:00:30.000Z"
};

const attempt = {
  attemptId: "attempt_1",
  workItemId: running.id,
  planId: "plan_1",
  planHash: "b".repeat(64),
  attemptNumber: 1,
  protocolVersion: "acs.worker.v2" as const,
  inputHash: "a".repeat(64),
  status: "leased" as const,
  currentFencingEpoch: 1,
  claimedByWorkerId: "worker-1",
  createdAt: "2026-07-05T00:30:05.000Z",
  updatedAt: "2026-07-05T00:30:06.000Z"
};

const lease = toMissionControlAttemptLease({
  leaseId: "lease_1",
  attemptId: attempt.attemptId,
  workItemId: running.id,
  admissionId: "admission_1",
  workerId: "worker-1",
  tokenHash: "f".repeat(64),
  planHash: attempt.planHash,
  inputHash: attempt.inputHash,
  fencingEpoch: 1,
  protocolVersion: "acs.worker.v2",
  policyVersion: "acs.policy.v1",
  policyDecisionHash: "c".repeat(64),
  issuedAt: "2026-07-05T00:30:06.000Z",
  expiresAt: "2026-07-05T00:41:06.000Z",
  maxExpiresAt: "2026-07-05T00:50:06.000Z",
  lastRenewedAt: "2026-07-05T00:39:06.000Z",
  status: "active"
});

const events: MissionControlViewModel["events"] = [
  {
    sequence: 1,
    id: "evt_1",
    name: "tunnel_session.heartbeat",
    timeUnixNano: nano("2026-07-05T00:39:30.000Z"),
    attributes: { "connector.id": "chatgpt-prod" },
    body: { connectorId: "chatgpt-prod" },
    previousHash: "",
    eventHash: "hash-1"
  },
  {
    sequence: 2,
    id: "evt_2",
    name: "policy.decided",
    timeUnixNano: nano("2026-07-05T00:39:40.000Z"),
    attributes: { "work_item.id": needsApproval.id, "policy.outcome": "require_approval", "action.kind": "fs.read" },
    body: { outcome: "require_approval", actionKind: "fs.read", ruleIds: ["fs-read-high-risk"] },
    previousHash: "hash-1",
    eventHash: "hash-2"
  },
  {
    sequence: 3,
    id: "evt_3",
    name: "work_item.needs_approval",
    timeUnixNano: nano("2026-07-05T00:39:50.000Z"),
    attributes: { "work_item.id": needsApproval.id, "agent.id": "/repo", api_key: fakeKey },
    body: { workItemId: needsApproval.id },
    previousHash: "hash-2",
    eventHash: "hash-3"
  }
];

const richModel: MissionControlViewModel = {
  workItems: [needsApproval, blocked, running, quarantined, succeeded],
  events,
  registeredAgents: [],
  approvalActionsByWorkItem: {
    [needsApproval.id]: [{ actionHash: "d".repeat(64), kind: "fs.read", description: "inspect source" }]
  },
  executionPlansByWorkItem: { [running.id]: plan },
  executionPlanAdmissionsByWorkItem: { [running.id]: admission },
  executionAttemptsByWorkItem: { [running.id]: [attempt] },
  attemptLeasesByWorkItem: { [running.id]: [lease] },
  executionBackend: "dry-run worker",
  statusCounts: { needs_approval: 1, blocked: 1, running: 1, quarantined: 1, succeeded: 7 },
  composerActionKinds: ["fs.read", "git.status"],
  approvalSlaMs: 30 * 60 * 1000,
  finishedWorkItems: { shown: 1, total: 7, limit: 50 },
  executionMode: "admin",
  now
};

describe("rendered output golden files", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    // toLocaleString depends on the host locale and time zone; pin it so the
    // golden files match on every machine.
    vi.spyOn(Date.prototype, "toLocaleString").mockImplementation(function (this: Date) {
      return this.toISOString();
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("full dashboard page (admin mode, plan, attempts, approvals, events)", async () => {
    await expect(renderDashboard(richModel)).toMatchFileSnapshot("./__golden__/dashboard-rich.html");
  });

  it("full dashboard page from a bare work-item array with a corrupt mode row", async () => {
    await expect(renderDashboard([needsApproval, blocked])).toMatchFileSnapshot("./__golden__/dashboard-legacy.html");
    await expect(
      renderDashboard({ workItems: [], events: [], executionModeProblem: "corrupt", now })
    ).toMatchFileSnapshot("./__golden__/dashboard-empty-corrupt-mode.html");
  });

  it("live dashboard fragments", async () => {
    await expect(JSON.stringify(renderDashboardFragments(richModel), null, 2)).toMatchFileSnapshot(
      "./__golden__/fragments-rich.json"
    );
  });

  it("work-item detail panel", async () => {
    await expect(
      renderWorkItemDetailHtml(blocked, [
        {
          name: "work_item.blocked",
          timeUnixNano: nano("2026-07-05T00:30:00.000Z"),
          attributes: { "work_item.id": blocked.id }
        }
      ])
    ).toMatchFileSnapshot("./__golden__/work-item-detail.html");
  });
});
