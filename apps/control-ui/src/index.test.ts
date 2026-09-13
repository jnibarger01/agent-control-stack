import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import {
  applySseConnectionState,
  nextSseReconnectDelayMs,
  projectAgents,
  renderDashboard,
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
    expect(html).toContain("New Task Composer");
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
    expect(html).toContain(`data-agent="/repo"`);
    expect(html).toContain(`data-agent-id="/repo"`);
    expect(html).toContain("refreshAgentRoster()");
    expect(html).toContain("fetchJson('/agents')");
    expect(html).toContain("fetchJson('/api/agents/' + encodeURIComponent(id) + '?limit=8')");
    expect(html).toContain("fetchJson('/api/agents/' + encodeURIComponent(id) + '/capabilities')");
    expect(html).not.toContain("JSON.stringify(await res.json(), null, 2)");
    expect(html).not.toContain("data-approve-all");
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

  it("shows a stale banner and disables approve/deny while SSE is disconnected", () => {
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
    expect(html).toContain("if (!sseConnected)");

    const dom = new JSDOM(html);
    const { document } = dom.window;
    const button = (selector: string) =>
      document.querySelector(selector) as { disabled: boolean; getAttribute(name: string): string | null } | null;
    const banner = document.querySelector("#sse-stale-banner") as {
      hidden: boolean;
      hasAttribute(name: string): boolean;
    } | null;
    const approve = button('[data-approve="wrk_test"]');
    const reject = button('[data-reject="wrk_test"]');
    const unblock = button('[data-unblock="wrk_blocked"]');
    const live = document.querySelector(".live") as {
      classList: { contains(name: string): boolean };
      textContent: string;
    } | null;

    expect(banner).not.toBeNull();
    expect(banner?.hasAttribute("hidden")).toBe(true);
    expect(approve?.disabled).toBe(false);
    expect(reject?.disabled).toBe(false);
    expect(unblock?.disabled).toBe(false);

    applySseConnectionState(document, false);
    expect(banner?.hidden).toBe(false);
    expect(live?.classList.contains("disconnected")).toBe(true);
    expect(live?.textContent).toContain("Disconnected");
    expect(approve?.disabled).toBe(true);
    expect(reject?.disabled).toBe(true);
    expect(unblock?.disabled).toBe(true);

    applySseConnectionState(document, true);
    expect(banner?.hidden).toBe(true);
    expect(live?.classList.contains("disconnected")).toBe(false);
    expect(live?.textContent).toContain("Live");
    expect(approve?.disabled).toBe(false);
    expect(reject?.disabled).toBe(false);
    expect(unblock?.disabled).toBe(false);
  });

  it("keeps hash-unavailable approve buttons disabled after SSE reconnect", () => {
    const html = renderDashboard({
      workItems: [workItem],
      events: [],
      now: new Date("2026-07-05T00:01:00.000Z")
    });
    const dom = new JSDOM(html);
    const approve = dom.window.document.querySelector('[data-approve="wrk_test"]') as {
      disabled: boolean;
      getAttribute(name: string): string | null;
    } | null;
    expect(approve?.disabled).toBe(true);
    applySseConnectionState(dom.window.document, false);
    expect(approve?.disabled).toBe(true);
    applySseConnectionState(dom.window.document, true);
    expect(approve?.disabled).toBe(true);
    expect(approve?.getAttribute("data-action-hash")).toBeNull();
  });

  it("posts reject actions to the reject route instead of cancellation", () => {
    const html = renderDashboard({ workItems: [workItem], events: [], now: new Date("2026-07-05T00:01:00.000Z") });

    expect(html).toContain("button.dataset.reject ? 'reject'");
    expect(html).not.toContain("button.dataset.reject ? 'cancel'");
  });

  it("projects online status only from recent heartbeat events", () => {
    const model: MissionControlViewModel = {
      workItems: [],
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

    expect(projectAgents(model.workItems, model.events, model.now)[0]).toMatchObject({
      id: "chatgpt-prod",
      status: "online",
      health: "healthy"
    });
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

    expect(html).toContain(`<button class="queue-item attention" data-work-item="wrk_test">`);
    expect(html).toContain(`<button class="queue-item attention" data-work-item="wrk_blocked">`);
    expect(html).toContain(`<button class="queue-item attention" data-work-item="wrk_quarantined">`);
    expect(html).toContain(`<button class="queue-item" data-work-item="wrk_running">`);
    expect(html).toContain(`<button class="queue-item" data-work-item="wrk_succeeded">`);
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
});
