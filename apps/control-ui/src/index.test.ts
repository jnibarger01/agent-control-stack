import { describe, expect, it } from "vitest";
import { projectAgents, renderDashboard, type MissionControlViewModel } from "./index.js";

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

  it("does not hard-reload the dashboard for SSE audit events", () => {
    const html = renderDashboard({ workItems: [workItem], events: [], now: new Date("2026-07-05T00:01:00.000Z") });

    expect(html).toContain("new EventSource('/events')");
    expect(html).toContain("'work_item.rejected'");
    expect(html).not.toContain("location.reload");
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
    const quarantinedItem = { ...workItem, id: "wrk_quarantined", status: "quarantined" as const, title: "Quarantined task" };

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
