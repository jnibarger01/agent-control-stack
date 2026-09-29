import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { renderDashboard, renderDashboardFragments, type MissionControlViewModel } from "./index.js";

const NOW = new Date("2026-07-05T00:40:00.000Z");

const baseItem = {
  requester: "user" as const,
  intent: "verify the operator attention card",
  target: { cwd: "/repo" },
  requestedActions: [{ kind: "fs.read", description: "inspect source", params: {} }],
  risk: "low" as const,
  createdAt: "2026-07-05T00:00:00.000Z",
  updatedAt: "2026-07-05T00:20:00.000Z"
};

type Status = MissionControlViewModel["workItems"][number]["status"];

function item(id: string, status: Status): MissionControlViewModel["workItems"][number] {
  return { ...baseItem, id, title: id, status };
}

/** label → value for the overview cards (works on a fragment or a full page). */
function cardValues(html: string): Record<string, string> {
  const dom = new JSDOM(html);
  const values: Record<string, string> = {};
  for (const card of dom.window.document.querySelectorAll(".card")) {
    const label = card.querySelector("span")?.textContent ?? "";
    values[label] = card.querySelector("strong")?.textContent ?? "";
  }
  return values;
}

const ATTENTION_LABEL = "Needs Operator Attention";

describe("overview operator attention card", () => {
  it("counts approvals, blocked, and quarantined items derived from the work items", () => {
    const values = cardValues(
      renderDashboardFragments({
        workItems: [
          item("wrk_approval", "needs_approval"),
          item("wrk_blocked", "blocked"),
          item("wrk_quarantined", "quarantined"),
          item("wrk_running", "running"),
          item("wrk_failed", "failed"),
          item("wrk_done", "succeeded")
        ],
        events: [],
        now: NOW
      }).cards
    );

    expect(values[ATTENTION_LABEL]).toBe("3");
    // A plain failure is not operator attention: nothing an operator can unblock.
    expect(values["Failed / Blocked"]).toBe("2");
    expect(values["Pending Approvals"]).toBe("1");
    expect(values["Running Tasks"]).toBe("1");
  });

  it("uses the store-wide status counts when the caller supplies them", () => {
    const values = cardValues(
      renderDashboardFragments({
        workItems: [item("wrk_running", "running")],
        events: [],
        statusCounts: { running: 3, needs_approval: 0, blocked: 1, quarantined: 2, failed: 5 },
        now: NOW
      }).cards
    );

    // The window only shows one running item; the card reports the store truth.
    expect(values[ATTENTION_LABEL]).toBe("3");
    expect(values["Running Tasks"]).toBe("3");
    expect(values["Failed / Blocked"]).toBe("6");
  });

  it("agrees with the queue's attention badges for the same model", () => {
    const fragments = renderDashboardFragments({
      workItems: [
        item("wrk_quarantined", "quarantined"),
        item("wrk_approval", "needs_approval"),
        item("wrk_running", "running")
      ],
      events: [],
      now: NOW
    });

    const queueBadges = fragments.queueList.match(/class="queue-item attention"/g) ?? [];
    expect(queueBadges).toHaveLength(2);
    expect(cardValues(fragments.cards)[ATTENTION_LABEL]).toBe(String(queueBadges.length));
    expect(fragments.queueList).toContain('data-status="quarantined"');
  });

  it("renders the card on the page and documents what it counts", () => {
    const html = renderDashboard({
      workItems: [item("wrk_quarantined", "quarantined")],
      events: [],
      now: NOW
    });

    expect(html).toContain(`<span>${ATTENTION_LABEL}</span><strong>1</strong>`);
    expect(html).toContain("Approvals, blocked, and quarantined work; the same set the queue marks for attention");
    // The old help text claimed the failed/blocked card was the attention set.
    expect(html).not.toContain("Items that need operator attention");

    // A bare work-item array (no statusCounts) still renders the card.
    const legacy = cardValues(renderDashboard([item("wrk_blocked", "blocked")]));
    expect(legacy[ATTENTION_LABEL]).toBe("1");
  });
});
