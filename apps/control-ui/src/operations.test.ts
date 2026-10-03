import { describe, expect, it } from "vitest";
import { type WorkItem } from "@agent-control-stack/work-items";
import { renderDashboardFragments } from "./index.js";
import { bootLive } from "./live-harness.test-support.js";
import { executionStage, throughputChart } from "./render/operations.js";
const now = new Date("2026-09-30T12:00:00Z");
const item: WorkItem = {
  id: "wrk_ops",
  title: "Investigate connector timeout",
  requester: "user",
  status: "running",
  risk: "medium",
  intent: "inspect",
  target: {},
  requestedActions: [],
  createdAt: now.toISOString(),
  updatedAt: now.toISOString()
};
const model = { workItems: [item], events: [], now, executionMode: "strict" as const };

describe("Mission Control operational slices", () => {
  it("opens immutable audit metadata and keeps advanced payload keyboard accessible", async () => {
    const app = bootLive({
      ...model,
      events: [
        {
          sequence: 1,
          id: "evt_review",
          name: "policy.decided",
          timeUnixNano: String(now.getTime() * 1e6),
          attributes: { "actor.id": "operator" },
          body: { outcome: "allow" },
          previousHash: "prior",
          eventHash: "current"
        }
      ]
    });
    const button = app.document.querySelector("[data-inspect-audit]") as HTMLElement;
    button.focus();
    button.click();
    expect((app.document.querySelector("#audit-drawer") as HTMLElement).hidden).toBe(false);
    expect(app.text("#audit-detail")).toContain("evt_review");
    const summary = app.document.querySelector("#audit-detail summary") as HTMLElement;
    (app.document.querySelector("#audit-drawer-close") as HTMLElement).focus();
    app.document.dispatchEvent(new app.window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    expect(app.document.activeElement).toBe(summary);
    app.key("Escape");
    expect((app.document.querySelector("#audit-drawer") as HTMLElement).hidden).toBe(true);
    expect(app.document.activeElement).toBe(button);
  });
  it("opens a meaningful work drawer from the board without changing views, closes with focus restored", async () => {
    const app = bootLive(model);
    const card = app.document.querySelector('[data-inspect-work="wrk_ops"]') as HTMLElement;
    card.focus();
    card.click();
    await app.flush();
    expect(app.document.body.dataset.activeView).toBe("overview");
    expect((app.document.querySelector("#work-drawer") as HTMLElement).hidden).toBe(false);
    expect(app.text("#work-detail h3")).toBe(item.title);
    expect(app.calls.some((c) => c.url === "/work-items/wrk_ops")).toBe(true);
    app.key("Escape");
    expect((app.document.querySelector("#work-drawer") as HTMLElement).hidden).toBe(true);
    expect(app.document.activeElement).toBe(card);
    expect(app.window.location.search).toBe("");
  });
  it("renders execution on a direct hash URL and keeps the correct heading during history navigation", async () => {
    const app = bootLive(model, {}, { url: "https://acs.local/#execution" });
    expect(app.document.body.dataset.activeView).toBe("execution");
    expect(app.text("#page-title")).toBe("Execution");
    (app.document.querySelector('[data-nav="audit"]') as HTMLElement).click();
    expect(app.window.location.hash).toBe("#audit");
    expect(app.text("#page-title")).toBe("Audit");
    app.window.location.hash = "#agents";
    await app.flush();
    expect(app.text("#page-title")).toBe("Agents");
  });
  it("preserves execution search and stage filters across backend refresh", async () => {
    const app = bootLive(model);
    const input = app.document.querySelector("#execution-search") as HTMLInputElement;
    input.value = "timeout";
    input.dispatchEvent(new app.window.Event("input", { bubbles: true }));
    app.open();
    await app.advance(1100);
    app.setModel({ ...model, workItems: [item, { ...item, id: "wrk_other", title: "Other" }] });
    app.emit("work_item.created");
    await app.advance(1100);
    expect((app.document.querySelector("#execution-search") as HTMLInputElement).value).toBe("timeout");
    expect(app.text("#execution-filter-count")).toBe("1 / 2 work items");
  });
  it("does not invent tool waiting, health percentages, or throughput when data is absent", () => {
    expect(executionStage(item)).toBe("Running");
    expect(executionStage({ ...item, status: "quarantined" })).toBe("Quarantined");
    expect(throughputChart(undefined)).toContain("unavailable");
    const fragments = renderDashboardFragments(model);
    expect(fragments.overviewOperations).toContain("Unknown");
    expect(fragments.executionOperations).not.toContain("92%");
    expect(fragments.executionOperations).toContain("Tool wait is not a persisted ACS stage");
  });
  it("renders exact supplied chart values and redacts audit secrets", () => {
    const chart = throughputChart({
      windowStart: now.toISOString(),
      windowEnd: now.toISOString(),
      succeeded: 2,
      failed: 1,
      averageRunMs: 12000,
      averageQueueMs: 1000,
      throughput: [{ at: now.toISOString(), started: 3, completed: 2, failed: 1 }]
    });
    expect(chart).toContain("3 started, 2 completed, 1 failed");
    const fragments = renderDashboardFragments({
      ...model,
      events: [
        {
          sequence: 1,
          id: "evt_a",
          name: "policy.decided",
          timeUnixNano: String(now.getTime() * 1e6),
          attributes: { "actor.id": "operator", "work_item.id": item.id, api_key: "private-test-value" },
          body: {},
          previousHash: "",
          eventHash: "hash"
        }
      ]
    });
    expect(fragments.auditOperations).toContain("[REDACTED]");
    expect(fragments.auditOperations).not.toContain("private-test-value");
  });
  it("refreshes the canonical execution mode from another operator and rolls back a rejected change", async () => {
    const app = bootLive(model);
    app.open();
    await app.advance(1100);
    app.setModel({ ...model, executionMode: "admin" });
    app.emit("execution_mode.changed");
    await app.advance(1100);
    expect((app.document.querySelector('input[value="admin"]') as HTMLInputElement).checked).toBe(true);
    app.setPostResponse({ status: 403, body: { error: "forbidden" } });
    const strict = app.document.querySelector('input[value="strict"]') as HTMLInputElement;
    strict.checked = true;
    strict.dispatchEvent(new app.window.Event("change", { bubbles: true }));
    await app.flush();
    expect((app.document.querySelector('input[value="admin"]') as HTMLInputElement).checked).toBe(true);
    expect(app.text("#execution-mode-result")).toContain("Rejected: forbidden");
  });
});

describe("throughput chart escaping (#25)", () => {
  const at = "2026-09-22T00:00:00.000Z";
  const telemetry = (throughput: unknown[]) =>
    ({
      windowStart: at,
      windowEnd: at,
      succeeded: 1,
      failed: 0,
      averageRunMs: 1000,
      averageQueueMs: 100,
      throughput
    }) as Parameters<typeof throughputChart>[0];

  it("escapes every interpolated value rather than assuming telemetry is well formed", () => {
    const chart = throughputChart(
      telemetry([
        {
          at: '</title></g><text x="0" y="0">&lt;img src=x onerror=alert(1)&gt;',
          started: "</text><script>alert(1)</script>",
          completed: 1,
          failed: 0
        }
      ])
    );
    // No markup from the payload may survive: escaping means the angle brackets are
    // entities, so no new element or attribute can be introduced.
    expect(chart).not.toContain("<script>");
    expect(chart).not.toContain("<img");
    expect(chart).not.toContain("</text></g>");
    expect(chart).not.toContain('<text x="0" y="0">');
    // The payload is still shown, fully escaped. The bucket label already contained
    // entities, so escaping it again is expected and still safe.
    expect(chart).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(chart).toContain("&amp;lt;img src=x onerror=alert(1)&amp;gt;");
  });

  it("escapes the bucket label in the chart tooltip and the detail table", () => {
    const chart = throughputChart(telemetry([{ at: "<b>bucket</b>", started: 2, completed: 1, failed: 0 }]));
    expect(chart).not.toContain("<b>bucket</b>");
    expect(chart).toContain("&lt;b&gt;bucket&lt;/b&gt;");
  });

  it("still renders when counts are non-finite, without emitting raw markup", () => {
    const chart = throughputChart(
      telemetry([{ at, started: Number.NaN, completed: Number.POSITIVE_INFINITY, failed: 0 }])
    );
    // Non-finite counts are a data-quality problem rather than an escaping one; the
    // chart must still render as markup rather than throw or leak markup.
    expect(chart).toContain("<svg");
    expect(chart).not.toContain("<script>");
    expect(chart).toContain("</svg>");
  });
});
