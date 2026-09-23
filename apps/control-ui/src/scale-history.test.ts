import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import {
  LIVE_TIMELINE_CAP,
  PROBE_INTERVAL_MS,
  renderDashboard,
  renderDashboardFragments,
  type MissionControlViewModel
} from "./index.js";
import { bootLive } from "./live-harness.test-support.js";

type Item = MissionControlViewModel["workItems"][number];
type AuditEvent = MissionControlViewModel["events"][number];

const NOW = new Date("2026-09-22T00:01:00.000Z");

function item(id: string, status: Item["status"] = "succeeded"): Item {
  return {
    id,
    title: `Task ${id}`,
    requester: "user",
    status,
    intent: `do ${id}`,
    target: {},
    requestedActions: [{ kind: "shell", description: "run", params: {} }],
    risk: "low",
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z"
  } as Item;
}

function event(sequence: number, name = "work_item.created"): AuditEvent {
  return {
    sequence,
    timeUnixNano: String(BigInt(1_790_000_000_000 + sequence) * 1_000_000n),
    name,
    attributes: { "work_item.id": `wrk_${sequence}` }
  } as unknown as AuditEvent;
}

/** A store of `total` finished items, windowed like the gateway does. */
function windowedModel(total: number, limit = 50): MissionControlViewModel {
  const finished = Array.from({ length: total }, (_, index) => item(`wrk_done_${index}`));
  const shown = finished.slice(0, limit);
  return {
    workItems: [item("wrk_live", "running"), ...shown],
    events: [],
    statusCounts: { running: 1, succeeded: total - 3, failed: 3 },
    finishedWorkItems: { shown: shown.length, total, limit },
    now: NOW
  };
}

describe("bounded work queue (#11)", () => {
  it("uses exact status counts for cards even when finished items are windowed", () => {
    const html = renderDashboard(windowedModel(312));
    const { document } = new JSDOM(html).window;
    const card = (label: string) =>
      [...document.querySelectorAll("#overview .card")]
        .find((node) => node.textContent?.includes(label))
        ?.querySelector("strong")?.textContent;
    expect(card("Failed / Blocked")).toBe("3");
    expect(card("Running Tasks")).toBe("1");
    expect(document.querySelectorAll("[data-work-item]")).toHaveLength(51);
    expect(document.querySelector("#queue-footer")?.textContent).toContain(
      "Showing the 50 most recent of 312 finished items"
    );
    expect(document.querySelector("[data-load-more-finished]")?.textContent).toBe("Show 50 more finished");
  });

  it("says when every finished item is shown, and renders no footer without history", () => {
    expect(renderDashboardFragments(windowedModel(20)).queueFooter).toBe(
      '<p class="queue-footer-note">All 20 finished items shown.</p>'
    );
    expect(renderDashboardFragments({ workItems: [], events: [], now: NOW }).queueFooter).toBe("");
  });

  it("widens the finished window on 'show more' and keeps it for later refreshes", async () => {
    const app = bootLive(windowedModel(120));
    app.setModel((finished) => windowedModel(120, finished ?? 50));
    app.open();
    await app.advance(2_000);

    (app.document.querySelector("[data-load-more-finished]") as HTMLButtonElement).click();
    await app.advance(1_500);
    expect(app.calls.at(-1)?.url).toBe("/dashboard/fragments?finished=100");
    expect(app.window.location.search).toBe("?finished=100");
    expect(app.document.querySelectorAll("[data-work-item]")).toHaveLength(101);

    app.emit("work_item.succeeded", { "work_item.id": "wrk_live" });
    await app.advance(1_500);
    expect(app.calls.at(-1)?.url).toBe("/dashboard/fragments?finished=100");
  });
});

describe("audit history (#12)", () => {
  it("keeps up to the live cap instead of 10 events", async () => {
    const app = bootLive({ workItems: [], events: [], now: NOW });
    app.open();
    for (let index = 0; index < LIVE_TIMELINE_CAP + 15; index += 1)
      app.emit("agent.heartbeat", { "agent.id": `a${index}` });
    await app.flush();
    expect(app.document.querySelectorAll("#events-timeline li")).toHaveLength(LIVE_TIMELINE_CAP);
  });

  it("buffers live events while paused and inserts them on resume", async () => {
    const app = bootLive({ workItems: [], events: [event(1)], now: NOW });
    app.open();
    const pause = app.document.getElementById("events-pause") as HTMLButtonElement;
    pause.click();
    expect(pause.getAttribute("aria-pressed")).toBe("true");
    app.emit("work_item.created", { "work_item.id": "wrk_x" });
    app.emit("work_item.running", { "work_item.id": "wrk_x" });
    await app.flush();
    expect(app.document.querySelectorAll("#events-timeline li")).toHaveLength(1);
    expect(pause.textContent).toBe("Resume (2 new)");

    pause.click();
    const names = [...app.document.querySelectorAll("#events-timeline li strong")].map((node) => node.textContent);
    expect(names).toEqual(["work_item.running", "work_item.created", "work_item.created"]);
    expect(pause.textContent).toBe("Pause");
    expect(pause.getAttribute("aria-pressed")).toBe("false");
  });

  it("loads older events below the current ones using the oldest sequence", async () => {
    const olderPage = Array.from({ length: 50 }, (_, index) => event(41 + index - 40)).map((entry, index) =>
      Object.assign(entry, { sequence: index + 1 })
    );
    const requested: string[] = [];
    const app = bootLive(
      { workItems: [], events: [event(51), event(52)], now: NOW },
      {
        "/dashboard/events": (url) => {
          requested.push(url);
          return { body: { events: requested.length === 1 ? olderPage : [] } };
        }
      }
    );
    app.open();
    const button = app.document.getElementById("events-load-older") as HTMLButtonElement;
    button.click();
    await app.flush();

    expect(requested[0]).toBe("/dashboard/events?beforeSequence=51&limit=50");
    const sequences = [...app.document.querySelectorAll("#events-timeline li")].map((node) =>
      Number(node.getAttribute("data-sequence"))
    );
    expect(sequences.slice(0, 3)).toEqual([52, 51, 50]);
    expect(sequences.at(-1)).toBe(1);
    expect(app.text("#action-status")).toBe("Loaded 50 older events");
    expect(button.disabled).toBe(false);

    button.click();
    await app.flush();
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("No older events");
  });
});

describe("periodic system probes (#10)", () => {
  it("probes /readyz only while the System view is open, repeats on an interval, and keeps history", async () => {
    let status = 200;
    const probes: string[] = [];
    const app = bootLive(
      { workItems: [], events: [], now: NOW },
      {
        "/readyz": (url) => {
          probes.push(url);
          return { status, body: {} };
        }
      }
    );
    app.open();
    await app.advance(PROBE_INTERVAL_MS * 2);
    expect(probes).toHaveLength(0);

    (app.document.querySelector('nav a[data-nav="system"]') as HTMLElement).click();
    await app.flush();
    expect(probes).toHaveLength(1);
    await app.advance(PROBE_INTERVAL_MS * 2);
    expect(probes).toHaveLength(3);
    expect(app.text("#system-probes")).toContain("Failures (last 3)0");
    expect(app.document.querySelector("#system-probes")?.getAttribute("data-state")).toBe("ok");

    status = 503;
    await app.advance(PROBE_INTERVAL_MS);
    expect(app.document.querySelector("#system-probes")?.getAttribute("data-state")).toBe("failing");
    expect(app.text("#action-status")).toBe("Gateway readiness degraded");
    expect(app.document.querySelector(".probe-trend")?.textContent).toBe("▮▮▮▯");

    (app.document.querySelector('nav a[data-nav="overview"]') as HTMLElement).click();
    await app.advance(PROBE_INTERVAL_MS * 3);
    expect(probes).toHaveLength(4);
  });
});
