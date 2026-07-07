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
    const html = renderDashboard({ workItems: [workItem, blockedItem], events: [], now: new Date("2026-07-05T00:01:00.000Z") });

    expect(html).toContain("AgentOS Mission Control");
    expect(html).toContain("Inspect me");
    expect(html).toContain("No fake green lights");
    expect(html).toContain("New Task Composer");
    expect(html).toContain("requires bearer token");
    expect(html).toContain("agent.prompt");
    expect(html).toContain(`data-approve="wrk_test"`);
    expect(html).toContain(`data-reject="wrk_test"`);
    expect(html).toContain(`data-unblock="wrk_blocked"`);
    expect(html).toContain(`data-reason="wrk_test"`);
    expect(html).toContain("worker lease expired");
    expect(html).toContain(`data-agent="/repo"`);
    expect(html).not.toContain("data-approve-all");
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
});
