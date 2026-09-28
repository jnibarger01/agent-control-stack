import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { renderDashboard, renderDashboardFragments, type MissionControlViewModel } from "./index.js";
import { DEFAULT_APPROVAL_SLA_MS } from "./operator-workflow.js";
import { operatorMetricsPanel } from "./render/panels.js";

const NOW = new Date("2026-07-05T00:40:00.000Z");

function minutesBefore(now: Date, minutes: number): string {
  return new Date(now.getTime() - minutes * 60 * 1000).toISOString();
}

const baseItem = {
  requester: "user" as const,
  intent: "verify metrics",
  target: { cwd: "/repo", files: ["src/index.ts"] },
  requestedActions: [{ kind: "fs.read", description: "inspect source", params: { paths: ["src/index.ts"] } }],
  risk: "low" as const,
  createdAt: "2026-07-05T00:00:00.000Z"
};

function item(
  id: string,
  status: "needs_approval" | "blocked",
  waitingMinutes: number
): MissionControlViewModel["workItems"][number] {
  return {
    ...baseItem,
    id,
    title: id,
    status,
    updatedAt: minutesBefore(NOW, waitingMinutes)
  };
}

/** Flattens the metrics panel into dt → dd rows, flagging flagged rows. */
function metricRows(html: string): Record<string, string> {
  const dom = new JSDOM(html);
  const rows: Record<string, string> = {};
  for (const row of dom.window.document.querySelectorAll(".operator-metrics > dl > div")) {
    const label = row.querySelector("dt")?.textContent ?? "";
    rows[label] = row.querySelector("dd")?.textContent ?? "";
    if (row.classList.contains("overdue")) rows[`${label}#overdue`] = "true";
  }
  return rows;
}

describe("operator metrics approval SLA", () => {
  it("counts approvals and blocked items that breached the SLA", () => {
    const rows = metricRows(
      operatorMetricsPanel(
        [
          item("wrk_over", "needs_approval", 40),
          item("wrk_blocked_over", "blocked", 45),
          item("wrk_fresh", "needs_approval", 5)
        ],
        {},
        NOW
      )
    );

    expect(rows["Approvals over SLA"]).toBe("2 of 3");
    expect(rows["Approvals over SLA#overdue"]).toBe("true");
  });

  it("reports zero breaches without flagging the row", () => {
    const rows = metricRows(
      operatorMetricsPanel([item("wrk_a", "needs_approval", 5), item("wrk_b", "blocked", 20)], {}, NOW)
    );

    expect(rows["Approvals over SLA"]).toBe("0 of 2");
    expect(rows["Approvals over SLA#overdue"]).toBeUndefined();
    // Only rows waiting on an operator are counted, not every work item.
    expect(rows["Pending approvals"]).toBe("1");
  });

  it("honours a custom SLA and treats a non-positive SLA as disabled", () => {
    const waiting = [item("wrk_waiting", "needs_approval", 40)];

    expect(metricRows(operatorMetricsPanel(waiting, {}, NOW, 60 * 60 * 1000))["Approvals over SLA"]).toBe("0 of 1");
    const hour = metricRows(operatorMetricsPanel(waiting, {}, NOW, 60 * 60 * 1000));
    expect(hour["Approvals over SLA#overdue"]).toBeUndefined();
    expect(metricRows(operatorMetricsPanel(waiting, {}, NOW, DEFAULT_APPROVAL_SLA_MS))["Approvals over SLA"]).toBe(
      "1 of 1"
    );
    expect(metricRows(operatorMetricsPanel(waiting, {}, NOW, 0))["Approvals over SLA"]).toBe("0 of 1");
  });

  it("agrees with the per-card over-SLA badges for the same SLA", () => {
    const model: MissionControlViewModel = {
      workItems: [item("wrk_old", "needs_approval", 15), item("wrk_new", "blocked", 2)],
      events: [],
      approvalSlaMs: 10 * 60 * 1000,
      now: NOW
    };
    const fragments = renderDashboardFragments(model);

    expect(metricRows(fragments.metrics)["Approvals over SLA"]).toBe("1 of 2");
    expect(fragments.approvalsList.match(/over SLA/g) ?? []).toHaveLength(1);
    expect(fragments.approvalsList.match(/class="approval-item overdue"/g) ?? []).toHaveLength(1);

    // The default SLA (30m) makes the same two cards agree at zero breaches.
    const relaxed = renderDashboardFragments({ ...model, approvalSlaMs: undefined });
    expect(metricRows(relaxed.metrics)["Approvals over SLA"]).toBe("0 of 2");
    expect(relaxed.approvalsList).not.toContain("over SLA");
  });

  it("renders the row in the dashboard with the breach styling", () => {
    const html = renderDashboard({
      workItems: [item("wrk_over", "needs_approval", 40)],
      events: [],
      now: NOW
    });

    expect(html).toContain("<dt>Approvals over SLA</dt><dd>1 of 1</dd>");
    expect(html).toContain(".operator-metrics div.overdue dt, .operator-metrics div.overdue dd");
  });
});
