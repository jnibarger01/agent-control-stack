import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import {
  LIVE_TIMELINE_BUFFER_CAP,
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

  it("caps the pause buffer, dropping the oldest and surfacing the count", async () => {
    const app = bootLive({ workItems: [], events: [], now: NOW });
    app.open();
    const pause = app.document.getElementById("events-pause") as HTMLButtonElement;
    pause.click();
    for (let index = 0; index < LIVE_TIMELINE_BUFFER_CAP + 25; index += 1)
      app.emit("agent.heartbeat", { "agent.id": `a${index}` });
    await app.flush();
    expect(pause.textContent).toBe(`Resume (${LIVE_TIMELINE_BUFFER_CAP} new)`);
    expect(pause.title).toBe("25 older buffered events dropped to stay under the buffer cap");

    pause.click();
    // All 500 buffered events were flushed; the DOM keeps only the live cap.
    const names = [...app.document.querySelectorAll("#events-timeline li strong")].map((node) => node.textContent);
    expect(names).toHaveLength(LIVE_TIMELINE_CAP);
    // Oldest dropped: the first retained event is the cap-th emitted.
    expect(names[0]).toBe("agent.heartbeat");
    expect(names.at(-1)).toBe("agent.heartbeat");
    expect(pause.title).toBe("");
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
    let deepHealthCalls = 0;
    const app = bootLive(
      { workItems: [], events: [], now: NOW },
      {
        "/readyz": (url) => {
          probes.push(url);
          const failures = status >= 300 ? 1 : 0;
          return {
            status,
            headers: { "x-acs-readyz-ms": "0.4" },
            body: {
              ok: status === 200,
              checks: {
                read: { ok: true },
                write: { ok: status === 200, ...(status === 200 ? {} : { code: "write_unavailable" }) }
              },
              execution: { active: 1, capacity: 2, queued: 0, saturated: false },
              telemetry: {
                latestMs: 0.4,
                p50Ms: 0.35,
                p95Ms: 0.8,
                failures,
                sampleCount: probes.length,
                admission: {
                  jc: { service: { latestMs: 18, p50Ms: 14, p95Ms: 24, sampleCount: 3 } },
                  dc: { service: { latestMs: 42, p50Ms: 35, p95Ms: 65, sampleCount: 2 } }
                }
              },
              deepHealth: { ok: true, checkedAt: NOW.toISOString(), source: "startup" }
            }
          };
        },
        "/health": () => {
          deepHealthCalls += 1;
          return { status: 200, body: { ok: true } };
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
    const healthyText = app.text("#system-probes");
    expect(healthyText).toContain("Browser RTT");
    expect(healthyText).toContain("Gateway0.40ms");
    expect(healthyText).toContain("p50 gateway0.35ms");
    expect(healthyText).toContain("p95 gateway0.80ms");
    expect(healthyText).toContain("Jace Commander service18ms · p95 24ms · n=3");
    expect(healthyText).toContain("Desktop Commander service42ms · p95 65ms · n=2");
    expect(healthyText).toContain("Readinesshealthy");
    expect(healthyText).toContain("Dependency checks2 passing");
    expect(healthyText).toContain("Execution admission1 / 2 active · 0 queued");
    expect(healthyText).toContain("Failures0 / 3");
    expect(healthyText).toContain("Deep healthhealthy");
    expect(deepHealthCalls).toBe(0);
    expect(app.document.querySelector("#system-probes")?.getAttribute("data-state")).toBe("ok");

    status = 503;
    await app.advance(PROBE_INTERVAL_MS);
    expect(app.document.querySelector("#system-probes")?.getAttribute("data-state")).toBe("failing");
    expect(app.text("#system-probes")).toContain("Dependency checksfailed: write");
    expect(app.text("#system-probes")).toContain("Failures1 / 4");
    expect(app.text("#action-status")).toBe("Gateway readiness degraded");
    expect(app.document.querySelector(".probe-trend")?.textContent).toBe("▮▮▮▯");

    (app.document.querySelector('nav a[data-nav="overview"]') as HTMLElement).click();
    await app.advance(PROBE_INTERVAL_MS * 3);
    expect(probes).toHaveLength(4);
    expect(deepHealthCalls).toBe(0);
  });
});
