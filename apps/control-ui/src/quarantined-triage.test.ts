import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { renderDashboard, renderDashboardFragments, type MissionControlViewModel } from "./index.js";

// Quarantined items (crash/recovery reclassification) are flagged "needs
// attention" in the queue and recover through an operator-only
// `quarantined -> pending_policy` transition, but the gateway exposes no
// approve/reject/unblock route for them. These tests pin that they are listed
// for triage with no mutating control, while waiting/blocked rows keep theirs.

const baseItem = {
  requester: "user" as const,
  intent: "verify rendering",
  target: { cwd: "/repo" },
  requestedActions: [{ kind: "fs.read", description: "inspect source", params: {} }],
  risk: "medium" as const,
  createdAt: "2026-07-05T00:00:00.000Z",
  updatedAt: "2026-07-05T00:00:00.000Z"
};

const waiting = {
  ...baseItem,
  id: "wrk_waiting",
  title: "Waiting approval",
  status: "needs_approval" as const,
  risk: "high" as const
};
const blocked = { ...baseItem, id: "wrk_blocked", title: "Blocked task", status: "blocked" as const };
const quarantined = {
  ...baseItem,
  id: "wrk_quarantined",
  title: "Quarantined task",
  status: "quarantined" as const,
  result: { error: "worker crashed during recovery" }
};
const succeeded = { ...baseItem, id: "wrk_done", title: "Finished task", status: "succeeded" as const };

const model: MissionControlViewModel = {
  workItems: [waiting, blocked, quarantined, succeeded],
  events: [],
  approvalActionsByWorkItem: {
    wrk_waiting: [{ actionHash: "hash-one", kind: "fs.read" }],
    wrk_blocked: [{ actionHash: "hash-two", kind: "fs.read" }]
  },
  now: new Date("2026-07-05T00:01:00.000Z")
};

function documentFrom(html: string): Document {
  return new JSDOM(html).window.document;
}

describe("quarantined work items in the operator triage", () => {
  it("lists a quarantined item for triage with no approve, reject, or unblock control", () => {
    const { approvalsList } = renderDashboardFragments(model);
    const document = documentFrom(`<div id="root">${approvalsList}</div>`);
    const card = document.querySelector('[data-work-item-ref="wrk_quarantined"]');

    expect(card).not.toBeNull();
    expect(card?.getAttribute("data-status")).toBe("quarantined");
    expect(card?.textContent).toContain("Quarantined task");
    expect(card?.querySelector("[data-approve], [data-reject], [data-unblock]")).toBeNull();
    expect(card?.querySelector("[data-reason]")).toBeNull();
    expect(card?.textContent).toContain("no approval is pending");
  });

  it("keeps the approve, reject, and unblock controls on waiting and blocked items", () => {
    const { approvalsList } = renderDashboardFragments(model);
    const document = documentFrom(`<div id="root">${approvalsList}</div>`);
    const waitingCard = document.querySelector('[data-work-item-ref="wrk_waiting"]');
    const blockedCard = document.querySelector('[data-work-item-ref="wrk_blocked"]');

    expect(waitingCard?.querySelector('[data-approve="wrk_waiting"]')).not.toBeNull();
    expect(waitingCard?.querySelector('[data-reject="wrk_waiting"]')).not.toBeNull();
    expect(blockedCard?.querySelector('[data-unblock="wrk_blocked"]')).not.toBeNull();
    expect(blockedCard?.querySelector('[data-reject="wrk_blocked"]')).not.toBeNull();
  });

  it("counts waiting and quarantined items separately in the header", () => {
    expect(renderDashboardFragments(model).approvalsCount).toBe("2 waiting · 1 quarantined");
    expect(renderDashboardFragments({ ...model, workItems: [waiting, blocked] }).approvalsCount).toBe("2 waiting");
    expect(renderDashboardFragments({ ...model, workItems: [quarantined] }).approvalsCount).toBe("0 waiting · 1 quarantined");
  });

  it("renders the same quarantined triage row in the full page", () => {
    const document = documentFrom(renderDashboard(model));

    expect(document.querySelector('#approvals-list [data-work-item-ref="wrk_quarantined"]')).not.toBeNull();
    expect(document.querySelector("#approvals-count")?.textContent).toBe("2 waiting · 1 quarantined");
  });
});