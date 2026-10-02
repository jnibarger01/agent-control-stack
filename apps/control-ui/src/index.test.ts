import { describe, expect, it } from "vitest";
import { workItemRiskSchema } from "@agent-control-stack/work-items";
import { JSDOM } from "jsdom";
import {
  applyQueueFilterToDom,
  approvalActionHashPrefix,
  emptyQueueFilter,
  filterWorkItems,
  isElevatedApprovalRisk,
  nextSseReconnectDelayMs,
  parseQueueFilter,
  projectAgents,
  renderDashboard,
  serializeQueueFilter,
  WORK_ITEM_RISK_VALUES,
  type MissionControlViewModel
} from "./index.js";

describe("renderDashboard", () => {
  const workItem = {
    id: "wrk_test",
    title: "Inspect me",
    requester: "user" as const,
    status: "needs_approval" as const,
    intent: "verify rendering",
    target: { cwd: "/repo", files: ["src/index.ts"] },
    requestedActions: [{ kind: "fs.read", description: "inspect source", params: { paths: ["src/index.ts"] } }],
    risk: "low" as const,
    createdAt: "2026-07-05T00:00:00.000Z",
    updatedAt: "2026-07-05T00:00:00.000Z"
  };
  const blockedItem = {
    ...workItem,
    id: "wrk_blocked",
    title: "Blocked task",
    status: "blocked" as const,
    result: { error: "worker lease expired" }
  };

  it("renders mission control without inventing agent health", () => {
    const html = renderDashboard({
      workItems: [workItem, blockedItem],
      events: [],
      approvalActionHashesByWorkItem: { wrk_test: ["hash-one", "hash-two"] },
      now: new Date("2026-07-05T00:01:00.000Z")
    });

    expect(html).toContain("ACS Mission Control");
    expect(html).toContain("Inspect me");
    expect(html).toContain("Live state comes from the registry");
    expect(html).toContain("Create task");
    expect(html).toContain("authenticated session");
    expect(html).not.toContain("ACS_GATEWAY_TOKEN");
    expect(html).toContain("agent.prompt");
    expect(html).toContain(`data-approve="wrk_test"`);
    expect(html).toContain(`data-action-hash="hash-one"`);
    expect(html).toContain(`data-action-hash="hash-two"`);
    expect(html).toContain("payload.actionHash = button.dataset.actionHash;");
    expect(html).toContain(`data-reject="wrk_test"`);
    expect(html).toContain(`data-unblock="wrk_blocked"`);
    expect(html).toContain(`data-reason="wrk_test"`);
    expect(html).toContain("worker lease expired");
    expect(html).not.toContain(`data-agent="/repo"`);
    expect(html).toContain("refreshAgentRoster()");
    expect(html).toContain("fetchJson('/agents')");
    expect(html).toContain("fetchJson('/api/agents/' + encodeURIComponent(id))");
    expect(html).not.toContain("fetchJson('/agents/' + encodeURIComponent(id)");
    expect(html).not.toContain("fetchJson('/api/agents/' + encodeURIComponent(id) + '/capabilities')");
    expect(html).toContain('data-nav="executors"');
    expect(html).toContain('id="executors"');
    expect(html).toContain("fetchJson('/api/executors')");
    expect(html).toContain("fetchJson('/api/executors/' + encodeURIComponent(id))");
    expect(html).toContain("fetchJson('/api/executors/' + encodeURIComponent(id) + '/capabilities')");
    expect(html).toContain("Agent capabilities");
    expect(html).toContain("Recent ACP sessions");
    expect(html).toContain("Current ACP session");
    expect(html).toContain("agent-card-grid");
    expect(html).toContain("agent-summary");
    expect(html).toContain("Identity, role, activity, and runtime presence");
    expect(html).toContain("fetchJson('/api/connectors')");
    expect(html).toContain("fetchJson('/api/connectors/' + encodeURIComponent(id))");
    expect(html).toContain("Registered connector identities + tunnel sessions");
    expect(html).not.toContain("No agents or connectors observed.");
    expect(html).not.toContain("No connectors observed.");
    expect(html).not.toContain("JSON.stringify(await res.json(), null, 2)");
    expect(html).not.toContain("data-approve-all");
    expect(html).toContain("Execution Mode");
    expect(html).toContain("Admin / YOLO");
    expect(html).toContain('data-execution-mode="strict"');
  });

  it("renders registered agents as status cards with roster summaries", () => {
    const html = renderDashboard({
      workItems: [],
      events: [],
      agents: [
        {
          id: "hermes-local",
          displayName: "Hermes Agent",
          kind: "service",
          status: "online",
          health: "healthy",
          currentTask: "Coordinate implementation",
          lastHeartbeatAt: "2026-07-05T00:00:30.000Z",
          capabilities: ["orchestrate", "delegate"],
          metadata: {
            registered: "true",
            acpRole: "ORCHESTRATION_LAYER",
            provider: "local",
            model: "hermes"
          }
        },
        {
          id: "codex-cli",
          displayName: "Codex CLI",
          kind: "cli",
          status: "offline",
          health: "unknown",
          capabilities: ["code:implement"],
          metadata: { registered: "true", acpRole: "IMPLEMENTATION_AGENT" }
        }
      ],
      now: new Date("2026-07-05T00:01:00.000Z")
    });

    expect(html).toContain('class="agent-summary"');
    expect(html).toContain("<span>Registered</span><strong>2</strong>");
    expect(html).toContain("<span>Online</span><strong>1</strong>");
    expect(html).toContain("<span>Active tasks</span><strong>1</strong>");
    expect(html).toContain("<span>Stale / offline</span><strong>1</strong>");
    expect(html).toContain('class="agent-card" data-agent="hermes-local"');
    expect(html).toContain("Orchestration Layer");
    expect(html).toContain("service · local · hermes");
    expect(html).toContain("Coordinate implementation");
    expect(html).toContain("2 capabilities");
    expect(html).toContain('class="agent-card" data-agent="codex-cli"');
  });

  it("keeps agents, executors, connectors, and admission as distinct overview and system domains", () => {
    const html = renderDashboard({
      workItems: [workItem],
      events: [],
      executionBackend: "desktop-commander",
      infrastructure: {
        agents: { registered: 8, online: 3 },
        executors: { total: 2, configured: 2, attestedRuntimes: 1 },
        connectors: { registered: 2, enabled: 1, activeSessions: 4 },
        admission: { active: 2, capacity: 3, queued: 1, saturated: false }
      },
      now: new Date("2026-07-05T00:01:00.000Z")
    });

    expect(html).toContain("<span>Agents</span><strong>3 / 8</strong>");
    expect(html).toContain("<span>Executors</span><strong>2 / 2</strong>");
    expect(html).toContain("<span>Connectors</span><strong>4</strong>");
    expect(html).toContain('data-dashboard-view="agents"');
    expect(html).toContain('data-dashboard-view="executors"');
    expect(html).toContain('data-dashboard-view="connectors"');
    expect(html).toContain('data-dashboard-view="execution" data-dashboard-statuses="running"');
    expect(html).toContain('data-dashboard-view="queue" data-dashboard-statuses="failed,blocked"');
    expect(html).toContain('data-dashboard-view="approvals"');
    expect(html).toContain("1 / 2 registered connectors enabled");
    expect(html).toContain("Agent heartbeats online");
    expect(html).toContain("Executors configured");
    expect(html).toContain("Attested executor runtimes");
    expect(html).toContain("Connectors enabled");
    expect(html).toContain("Active tunnel sessions");
    expect(html).toContain("Execution admission");
    expect(html).toContain("2 / 3 active");
    expect(html).toContain("Admission queue");
    expect(html).toContain("System Status");
    expect(html).toContain("Dependency checks");
    expect(html).not.toContain("Total Agents");
    expect(html).not.toContain("Online Agents");
  });

  it("renders an operator metrics panel with lease age, approval wait, and /metrics scrape notes", () => {
    const lease = {
      leaseId: "lease_ops",
      attemptId: "attempt_ops",
      workItemId: "wrk_test",
      admissionId: "admission_ops",
      workerId: "worker-ops",
      planHash: "a".repeat(64),
      inputHash: "b".repeat(64),
      fencingEpoch: 1,
      protocolVersion: "acs.worker.v2" as const,
      policyVersion: "policy-v1",
      policyDecisionHash: "c".repeat(64),
      issuedAt: "2026-07-05T00:00:00.000Z",
      expiresAt: "2026-07-05T00:10:00.000Z",
      maxExpiresAt: "2026-07-05T00:30:00.000Z",
      lastRenewedAt: "2026-07-05T00:00:00.000Z",
      status: "active" as const
    };
    const html = renderDashboard({
      workItems: [workItem],
      events: [],
      attemptLeasesByWorkItem: { wrk_test: [lease] },
      now: new Date("2026-07-05T00:01:30.000Z")
    });

    expect(html).toContain('id="operator-metrics"');
    expect(html).toContain("Operator metrics");
    expect(html).toContain("Oldest lease age");
    expect(html).toContain("1m 30s");
    expect(html).toContain("Oldest approval wait");
    expect(html).toContain('href="/metrics"');
    expect(html).toContain("acs_rate_limit_rejected_total");
    expect(html).toContain("docs/runbooks/operator-metrics.md");
  });

  it("does not hard-reload the dashboard for SSE audit events", () => {
    const html = renderDashboard({ workItems: [workItem], events: [], now: new Date("2026-07-05T00:01:00.000Z") });

    expect(html).toContain("new EventSource('/events')");
    expect(html).toContain("'work_item.rejected'");
    expect(html).not.toContain("location.reload");
  });

  it("backs off EventSource reconnect delays up to 30s", () => {
    expect(nextSseReconnectDelayMs(0)).toBe(1_000);
    expect(nextSseReconnectDelayMs(1)).toBe(2_000);
    expect(nextSseReconnectDelayMs(2)).toBe(4_000);
    expect(nextSseReconnectDelayMs(3)).toBe(8_000);
    expect(nextSseReconnectDelayMs(4)).toBe(16_000);
    expect(nextSseReconnectDelayMs(5)).toBe(30_000);
    expect(nextSseReconnectDelayMs(8)).toBe(30_000);
    expect(nextSseReconnectDelayMs(-2)).toBe(1_000);
  });

  it("renders the stale banner and disables sensitive actions until reconciled", () => {
    const html = renderDashboard({
      workItems: [workItem, blockedItem],
      events: [],
      approvalActionHashesByWorkItem: { wrk_test: ["hash-one"] },
      now: new Date("2026-07-05T00:01:00.000Z")
    });

    expect(html).toContain('id="sse-stale-banner"');
    expect(html).toContain("Displayed work items may be stale");
    expect(html).toContain("function connectSse()");
    expect(html).toContain("nextSseReconnectDelayMs(sseReconnectAttempt)");
    expect(html).toContain("addEventListener('error'");
    expect(html).toContain("!snapshotCurrent || !sseConnected");

    const dom = new JSDOM(html);
    const { document } = dom.window;
    const button = (selector: string) =>
      document.querySelector(selector) as { disabled: boolean; getAttribute(name: string): string | null } | null;
    expect(document.querySelector("#sse-stale-banner")).not.toBeNull();
    expect(button('[data-approve="wrk_test"]')).not.toBeNull();
    expect(button('[data-reject="wrk_test"]')).not.toBeNull();
    expect(button('[data-unblock="wrk_blocked"]')).not.toBeNull();
  });

  it("posts reject actions to the reject route instead of cancellation", () => {
    const html = renderDashboard({ workItems: [workItem], events: [], now: new Date("2026-07-05T00:01:00.000Z") });

    expect(html).toContain("button.dataset.reject ? 'reject'");
    expect(html).not.toContain("button.dataset.reject ? 'cancel'");
  });

  it("does not promote connectors or work-item targets into the agent roster", () => {
    const model: MissionControlViewModel = {
      workItems: [workItem],
      now: new Date("2026-07-05T00:01:00.000Z"),
      events: [
        {
          sequence: 1,
          id: "evt_1",
          name: "tunnel_session.heartbeat",
          timeUnixNano: String(Date.parse("2026-07-05T00:00:30.000Z") * 1_000_000),
          attributes: { "connector.id": "chatgpt-prod" },
          body: { connectorId: "chatgpt-prod" },
          previousHash: "",
          eventHash: "hash"
        }
      ]
    };

    expect(projectAgents(model.workItems, model.events, model.now)).toEqual([]);
  });

  it("visually distinguishes work items that need operator attention from normally running ones", () => {
    const runningItem = { ...workItem, id: "wrk_running", status: "running" as const, title: "Running task" };
    const succeededItem = { ...workItem, id: "wrk_succeeded", status: "succeeded" as const, title: "Succeeded task" };
    const quarantinedItem = {
      ...workItem,
      id: "wrk_quarantined",
      status: "quarantined" as const,
      title: "Quarantined task"
    };

    const html = renderDashboard({
      workItems: [workItem, blockedItem, runningItem, succeededItem, quarantinedItem],
      events: [],
      now: new Date("2026-07-05T00:01:00.000Z")
    });

    expect(html).toContain(`class="queue-item attention" data-work-item="wrk_test"`);
    expect(html).toContain(`class="queue-item attention" data-work-item="wrk_blocked"`);
    expect(html).toContain(`class="queue-item attention" data-work-item="wrk_quarantined"`);
    expect(html).toContain(`class="queue-item" data-work-item="wrk_running"`);
    expect(html).toContain(`class="queue-item" data-work-item="wrk_succeeded"`);
    expect(html).toContain(`data-status="needs_approval"`);
    expect(html).toContain(`data-status="running"`);
    expect(html).toContain("Needs attention");
    expect(html).toContain(".quarantined");
  });

  it("surfaces execution plan admission status when a plan is available for a work item", () => {
    const plan = {
      planId: "plan_1",
      workItemId: "wrk_test",
      planNumber: 1,
      definition: {
        schemaVersion: "acs.execution-plan.v1" as const,
        workItemId: "wrk_test",
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
    const admittedRequiresApproval = {
      admissionId: "admission_1",
      workItemId: "wrk_test",
      planId: "plan_1",
      planHash: "b".repeat(64),
      policyVersion: "v1",
      policyDecisionHash: "c".repeat(64),
      requiresApproval: true,
      admittedByActorId: "policy-gate",
      admittedAt: "2026-07-05T00:00:30.000Z"
    };

    const admittedHtml = renderDashboard({
      workItems: [workItem],
      events: [],
      now: new Date("2026-07-05T00:01:00.000Z"),
      executionPlansByWorkItem: { wrk_test: plan },
      executionPlanAdmissionsByWorkItem: { wrk_test: admittedRequiresApproval }
    });
    expect(admittedHtml).toContain("Execution plan admitted");
    expect(admittedHtml).toContain("requires approval");

    const draftedOnlyHtml = renderDashboard({
      workItems: [workItem],
      events: [],
      now: new Date("2026-07-05T00:01:00.000Z"),
      executionPlansByWorkItem: { wrk_test: plan }
    });
    expect(draftedOnlyHtml).toContain("not yet admitted");
    expect(draftedOnlyHtml).not.toContain("Execution plan admitted");
  });

  it("renders unchanged when execution plan fields are omitted (additive, backward compatible)", () => {
    const html = renderDashboard({ workItems: [workItem], events: [], now: new Date("2026-07-05T00:01:00.000Z") });
    expect(html).not.toContain("Execution plan drafted");
    expect(html).not.toContain("Execution plan admitted");
  });

  it("keeps registered local agents offline without heartbeat evidence", () => {
    const agents = projectAgents([], [], new Date("2026-07-05T00:01:00.000Z"), [
      {
        id: "codex-cli",
        name: "Codex CLI",
        kind: "cli",
        acpRole: "IMPLEMENTATION_AGENT",
        capabilities: [
          {
            id: "cap_1",
            agentId: "codex-cli",
            name: "code:implement",
            createdAt: "2026-07-05T00:00:00.000Z",
            updatedAt: "2026-07-05T00:00:00.000Z",
            createdByActorId: "user",
            updatedByActorId: "user"
          },
          {
            id: "cap_2",
            agentId: "codex-cli",
            name: "code:test",
            createdAt: "2026-07-05T00:00:00.000Z",
            updatedAt: "2026-07-05T00:00:00.000Z",
            createdByActorId: "user",
            updatedByActorId: "user"
          },
          {
            id: "cap_3",
            agentId: "codex-cli",
            name: "repo:inspect",
            createdAt: "2026-07-05T00:00:00.000Z",
            updatedAt: "2026-07-05T00:00:00.000Z",
            createdByActorId: "user",
            updatedByActorId: "user"
          }
        ],
        status: "OFFLINE",
        createdAt: "2026-07-05T00:00:00.000Z",
        updatedAt: "2026-07-05T00:00:00.000Z",
        createdByActorId: "user",
        updatedByActorId: "user"
      }
    ]);

    expect(agents[0]).toMatchObject({
      id: "codex-cli",
      status: "offline",
      health: "unknown",
      capabilities: ["code:implement", "code:test", "repo:inspect"]
    });
  });

  it("projects registered agent role, runtime identity, and heartbeat task", () => {
    const agents = projectAgents([], [], new Date("2026-07-05T00:01:00.000Z"), [
      {
        id: "hermes-local",
        name: "Hermes Agent",
        kind: "service",
        acpRole: "ORCHESTRATION_LAYER",
        provider: "local",
        model: "hermes",
        capabilities: [],
        status: "AVAILABLE",
        lastHeartbeatAt: "2026-07-05T00:00:30.000Z",
        latestHeartbeat: {
          id: 1,
          agentId: "hermes-local",
          status: "AVAILABLE",
          currentTask: "coordinate implementation",
          observedAt: "2026-07-05T00:00:30.000Z",
          actorId: "actor_system_bootstrap"
        },
        createdAt: "2026-07-05T00:00:00.000Z",
        updatedAt: "2026-07-05T00:00:30.000Z",
        createdByActorId: "actor_system_bootstrap",
        updatedByActorId: "actor_system_bootstrap"
      }
    ]);

    expect(agents[0]).toMatchObject({
      id: "hermes-local",
      displayName: "Hermes Agent",
      kind: "service",
      status: "online",
      health: "healthy",
      currentTask: "coordinate implementation",
      metadata: {
        registered: "true",
        registryStatus: "AVAILABLE",
        acpRole: "ORCHESTRATION_LAYER",
        provider: "local",
        model: "hermes"
      }
    });
  });
});

describe("queue filter", () => {
  const items = [
    { id: "wrk_a", title: "Deploy gateway", status: "running", risk: "low", agentId: "codex-cli" },
    { id: "wrk_b", title: "Inspect policy", status: "needs_approval", risk: "high", agentId: "policy-bot" },
    { id: "wrk_c", title: "Blocked lease", status: "blocked", risk: "critical", agentId: "codex-cli" }
  ];

  it("returns the full queue when the filter is empty", () => {
    expect(filterWorkItems(items, emptyQueueFilter())).toEqual(items);
    expect(filterWorkItems(items, { statuses: [], risks: [], agentId: "  ", text: "" })).toEqual(items);
  });

  it("filters by status and updates the visible set", () => {
    const filtered = filterWorkItems(items, { statuses: ["blocked", "running"], risks: [], agentId: "", text: "" });
    expect(filtered.map((item) => item.id)).toEqual(["wrk_a", "wrk_c"]);
  });

  it("filters by risk chips and combines them with status chips", () => {
    expect(
      filterWorkItems(items, { statuses: [], risks: ["high"], agentId: "", text: "" }).map((item) => item.id)
    ).toEqual(["wrk_b"]);
    expect(
      filterWorkItems(items, { statuses: [], risks: ["low", "critical"], agentId: "", text: "" }).map((item) => item.id)
    ).toEqual(["wrk_a", "wrk_c"]);
    // Cross-group filters intersect: status AND risk.
    expect(
      filterWorkItems(items, { statuses: ["blocked"], risks: ["high"], agentId: "", text: "" }).map((item) => item.id)
    ).toEqual([]);
    // Risk matching is case-insensitive and ignores unknown risk chips.
    expect(
      filterWorkItems(items, { statuses: [], risks: ["HIGH"], agentId: "", text: "" }).map((item) => item.id)
    ).toEqual(["wrk_b"]);
    expect(filterWorkItems(items, { statuses: [], risks: ["not-a-risk"], agentId: "", text: "" })).toEqual(items);
  });

  it("excludes items with an unset risk while a risk chip is active", () => {
    const withoutRisk = [...items, { id: "wrk_d", title: "Untyped risk", status: "running", agentId: "" }];
    expect(
      filterWorkItems(withoutRisk, { statuses: [], risks: ["medium"], agentId: "", text: "" }).map((item) => item.id)
    ).toEqual([]);
  });

  it("filters by free-text on title and id", () => {
    expect(
      filterWorkItems(items, { statuses: [], risks: [], agentId: "", text: "policy" }).map((item) => item.id)
    ).toEqual(["wrk_b"]);
    expect(
      filterWorkItems(items, { statuses: [], risks: [], agentId: "", text: "wrk_c" }).map((item) => item.id)
    ).toEqual(["wrk_c"]);
  });

  it("treats unknown status chips as a no-op", () => {
    expect(filterWorkItems(items, { statuses: ["not-a-real-status"], risks: [], agentId: "", text: "" })).toEqual(
      items
    );
    expect(
      filterWorkItems(items, { statuses: ["not-a-real-status", "blocked"], risks: [], agentId: "", text: "" }).map(
        (item) => item.id
      )
    ).toEqual(["wrk_c"]);
  });

  it("parses and serializes filter state from URL search params and hash", () => {
    expect(parseQueueFilter("?status=running&status=blocked&risk=high&q=deploy&agent=codex")).toEqual({
      statuses: ["running", "blocked"],
      risks: ["high"],
      agentId: "codex",
      text: "deploy"
    });
    expect(parseQueueFilter("?risk=high,critical")).toEqual({
      statuses: [],
      risks: ["high", "critical"],
      agentId: "",
      text: ""
    });
    expect(parseQueueFilter("#queue?status=failed&risk=low&q=lease")).toEqual({
      statuses: ["failed"],
      risks: ["low"],
      agentId: "",
      text: "lease"
    });
    expect(
      serializeQueueFilter({ statuses: ["running"], risks: ["high", "critical"], agentId: "a1", text: "x" }).toString()
    ).toBe("status=running&risk=high&risk=critical&agent=a1&q=x");
    expect(WORK_ITEM_RISK_VALUES).toEqual(workItemRiskSchema.options);
  });

  it("hides non-matching queue items and updates the visible count in the DOM", () => {
    const html = renderDashboard({
      workItems: [
        {
          id: "wrk_a",
          title: "Deploy gateway",
          requester: "user",
          status: "running",
          intent: "ship",
          target: { services: ["codex-cli"] },
          requestedActions: [],
          risk: "low",
          createdAt: "2026-07-05T00:00:00.000Z",
          updatedAt: "2026-07-05T00:00:00.000Z"
        },
        {
          id: "wrk_b",
          title: "Inspect policy",
          requester: "user",
          status: "needs_approval",
          intent: "review",
          target: { services: ["policy-bot"] },
          requestedActions: [],
          risk: "medium",
          createdAt: "2026-07-05T00:00:00.000Z",
          updatedAt: "2026-07-05T00:00:00.000Z"
        },
        {
          id: "wrk_c",
          title: "Blocked lease",
          requester: "user",
          status: "blocked",
          intent: "recover",
          target: { services: ["codex-cli"] },
          requestedActions: [],
          risk: "high",
          createdAt: "2026-07-05T00:00:00.000Z",
          updatedAt: "2026-07-05T00:00:00.000Z"
        }
      ],
      events: [],
      now: new Date("2026-07-05T00:01:00.000Z")
    });

    expect(html).toContain('id="queue-filter"');
    expect(html).toContain('for="queue-filter-text"');
    expect(html).toContain('for="queue-filter-agent"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('data-status="running"');
    expect(html).toContain('data-agent-id="codex-cli"');
    expect(html).toContain('data-risk="high"');
    expect(html).toContain('data-queue-risk="high"');
    expect(html).toContain("bindQueueFilter()");
    expect(html).toContain('return new Set(["low","medium","high","critical"]);');
    expect(html).toContain("const filterKeys = ['status', 'risk', 'q', 'text', 'agent'];");
    expect(html).toContain("filterKeys.forEach(function (key) { hashParams.delete(key); });");
    expect(html).toContain("url.hash = '#' + anchor + (remainingHashParams ? delimiter + remainingHashParams : '');");

    const dom = new JSDOM(html);
    const root = dom.window.document;
    const visible = applyQueueFilterToDom(root, { statuses: ["blocked"], risks: [], agentId: "", text: "" });
    expect(visible).toBe(1);
    expect((root.querySelector('[data-work-item="wrk_c"]') as HTMLElement | null)?.hidden).toBe(false);
    expect((root.querySelector('[data-work-item="wrk_a"]') as HTMLElement | null)?.hidden).toBe(true);
    expect((root.querySelector('[data-work-item="wrk_b"]') as HTMLElement | null)?.hidden).toBe(true);
    expect(root.querySelector("#queue-filter-count")?.textContent).toBe("1 of 3 items");
    expect(root.querySelector("#queue-filter-live")?.textContent).toBe("Showing 1 of 3 work items");

    const byText = applyQueueFilterToDom(root, { statuses: [], risks: [], agentId: "", text: "policy" });
    expect(byText).toBe(1);
    expect((root.querySelector('[data-work-item="wrk_b"]') as HTMLElement | null)?.hidden).toBe(false);
    expect(root.querySelector("#queue-filter-count")?.textContent).toBe("1 of 3 items");

    const byRisk = applyQueueFilterToDom(root, { statuses: [], risks: ["high"], agentId: "", text: "" });
    expect(byRisk).toBe(1);
    expect((root.querySelector('[data-work-item="wrk_c"]') as HTMLElement | null)?.hidden).toBe(false);
    expect((root.querySelector('[data-work-item="wrk_a"]') as HTMLElement | null)?.hidden).toBe(true);
    expect(root.querySelector("#queue-filter-count")?.textContent).toBe("1 of 3 items");
    expect(root.querySelector("#queue-filter-live")?.textContent).toBe("Showing 1 of 3 work items");

    const cleared = applyQueueFilterToDom(root, emptyQueueFilter());
    expect(cleared).toBe(3);
    expect(root.querySelector("#queue-filter-count")?.textContent).toBe("3 items");

    const unknownOnly = applyQueueFilterToDom(root, {
      statuses: ["totally-unknown"],
      risks: [],
      agentId: "",
      text: ""
    });
    expect(unknownOnly).toBe(3);
    expect(root.querySelector("#queue-filter-count")?.textContent).toBe("3 items");

    const unknownRiskOnly = applyQueueFilterToDom(root, {
      statuses: [],
      risks: ["totally-unknown"],
      agentId: "",
      text: ""
    });
    expect(unknownRiskOnly).toBe(3);
    expect(root.querySelector("#queue-filter-count")?.textContent).toBe("3 items");
  });
});

describe("high-risk approval confirm", () => {
  const lowItem = {
    id: "wrk_low",
    title: "Low risk approve",
    requester: "user" as const,
    status: "needs_approval" as const,
    intent: "safe read",
    target: { cwd: "/repo" },
    requestedActions: [{ kind: "fs.read", description: "inspect", params: {} }],
    risk: "low" as const,
    createdAt: "2026-07-05T00:00:00.000Z",
    updatedAt: "2026-07-05T00:00:00.000Z"
  };
  const highItem = {
    ...lowItem,
    id: "wrk_high",
    title: "High risk approve",
    risk: "high" as const,
    requestedActions: [{ kind: "fs.write", description: "mutate", params: {} }]
  };

  it("treats high and critical as elevated; low and medium are one-click", () => {
    expect(isElevatedApprovalRisk("high")).toBe(true);
    expect(isElevatedApprovalRisk("critical")).toBe(true);
    expect(isElevatedApprovalRisk("HIGH")).toBe(true);
    expect(isElevatedApprovalRisk("low")).toBe(false);
    expect(isElevatedApprovalRisk("medium")).toBe(false);
    expect(approvalActionHashPrefix("abcdef0123456789ffff")).toBe("abcdef012345…");
    expect(approvalActionHashPrefix("short")).toBe("short");
  });

  it("renders data-risk on approve/deny controls and embeds confirm helpers in the client script", () => {
    const html = renderDashboard({
      workItems: [lowItem, highItem],
      events: [],
      approvalActionHashesByWorkItem: {
        wrk_low: ["lowhash0123456789"],
        wrk_high: ["highhash0123456789abcd"]
      },
      now: new Date("2026-07-05T00:01:00.000Z")
    });

    expect(html).toContain(`data-approve="wrk_high"`);
    expect(html).toContain(`data-risk="high"`);
    expect(html).toContain(`data-risk="low"`);
    expect(html).toContain(`data-reject="wrk_high"`);
    expect(html).toContain("function isElevatedApprovalRisk(risk)");
    expect(html).toContain("function requestApprovalConfirm(request)");
    expect(html).toContain("approval-confirm-dialog");
    expect(html).toContain("event.key === 'Escape'");
  });
});
