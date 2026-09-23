import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { bootLive } from "./live-harness.test-support.js";
import {
  DASHBOARD_FRAGMENT_TARGETS,
  PERIODIC_REFRESH_MS,
  renderDashboard,
  renderDashboardFragments,
  type MissionControlViewModel
} from "./index.js";

type Item = MissionControlViewModel["workItems"][number];

function item(id: string, overrides: Partial<Item> = {}): Item {
  return {
    id,
    title: `Task ${id}`,
    requester: "user",
    status: "needs_approval",
    intent: `do ${id}`,
    target: {},
    requestedActions: [{ kind: "shell", description: "run", params: {} }],
    risk: "low",
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
    ...overrides
  } as Item;
}

const NOW = new Date("2026-09-22T00:01:00.000Z");

describe("dashboard fragments", () => {
  it("embeds exactly the fragment markup in the page, so there is one renderer per section", () => {
    const model: MissionControlViewModel = {
      workItems: [item("wrk_a"), item("wrk_b", { status: "running" })],
      events: [],
      approvalActionsByWorkItem: { wrk_a: [{ actionHash: "hash-a", kind: "shell" }] },
      now: NOW
    };
    const { document } = new JSDOM(renderDashboard(model)).window;
    const fragments = renderDashboardFragments(model);
    for (const [name, selector] of Object.entries(DASHBOARD_FRAGMENT_TARGETS)) {
      const expected = new JSDOM(
        `<div id="x">${fragments[name as keyof typeof fragments]}</div>`
      ).window.document.querySelector("#x")?.innerHTML;
      expect(document.querySelector(selector)?.innerHTML, name).toBe(expected);
    }
  });
});

describe("live dashboard client (#6, #7, #8, #9)", () => {
  it("contains no hard-reload paths in the client script (#7)", () => {
    const html = renderDashboard({ workItems: [item("wrk_a")], events: [], now: NOW });
    expect(html).not.toContain("location.assign");
    expect(html).not.toContain("location.reload");
  });

  it("shows connecting, live with last-event age, and a reconnect countdown (#9)", async () => {
    const app = bootLive({ workItems: [], events: [], now: NOW });
    await app.flush();
    expect(app.liveText()).toBe("Connecting…");

    app.open();
    await app.flush();
    expect(app.liveText()).toBe("Live");
    app.emit("agent.heartbeat");
    await app.advance(3_000);
    expect(app.liveText()).toBe("Live · last event 3s ago");

    app.error();
    await app.flush();
    expect(app.liveText()).toBe("Disconnected · reconnecting in 1s (attempt 1)");
    expect(app.document.querySelector(".live")?.getAttribute("data-state")).toBe("disconnected");
    await app.advance(1_000); // reconnect fires, new EventSource
    app.error();
    await app.flush();
    expect(app.liveText()).toBe("Disconnected · reconnecting in 2s (attempt 2)");
    await app.advance(1_000);
    expect(app.liveText()).toBe("Disconnected · reconnecting in 1s (attempt 2)");
  });

  it("patches the queue, approvals, and cards from SSE events without reloading (#6, #8)", async () => {
    const app = bootLive({ workItems: [item("wrk_a")], events: [], now: NOW });
    app.open();
    await app.advance(0);
    const baseline = app.fragmentFetches();
    expect(app.text("#approvals-count")).toBe("1 waiting");

    app.setModel({
      workItems: [item("wrk_a"), item("wrk_new", { title: "Fresh task", status: "running" })],
      events: [],
      now: NOW
    });
    app.emit("work_item.running", { "work_item.id": "wrk_new" });
    await app.advance(1_500);

    expect(app.fragmentFetches()).toBe(baseline + 1);
    expect(app.document.querySelector('[data-work-item="wrk_new"]')?.textContent).toContain("Fresh task");
    expect(app.text("#queue-filter-count")).toBe("2 items");
    const runningCard = [...app.document.querySelectorAll("#overview .card")].find((card) =>
      card.textContent?.includes("Running Tasks")
    );
    expect(runningCard?.querySelector("strong")?.textContent).toBe("1");
    expect(app.assigned).toEqual([]);
  });

  it("coalesces a burst of work-item events into a single fragment fetch", async () => {
    const app = bootLive({ workItems: [item("wrk_a")], events: [], now: NOW });
    app.open();
    await app.advance(2_000);
    const baseline = app.fragmentFetches();
    for (let i = 0; i < 8; i += 1) app.emit("work_item.running", { "work_item.id": `wrk_${i}` });
    await app.advance(2_000);
    expect(app.fragmentFetches()).toBe(baseline + 1);
  });

  it("keeps typed reasons, focus, selection, and the queue filter across a patch", async () => {
    const app = bootLive({
      workItems: [item("wrk_a"), item("wrk_b"), item("wrk_c", { status: "running" })],
      events: [],
      now: NOW
    });
    app.open();
    await app.advance(2_000);

    (app.document.querySelector('[data-work-item="wrk_c"]') as HTMLElement).click();
    await app.flush(); // detail load finishes and takes focus
    const filter = app.document.querySelector("#queue-filter-text") as HTMLInputElement;
    filter.value = "wrk_c";
    filter.dispatchEvent(new app.window.Event("input", { bubbles: true }));
    const reason = app.document.querySelector('[data-reason="wrk_b"]') as HTMLInputElement;
    reason.value = "half-typed justification";
    reason.focus();
    await app.flush();

    app.setModel({
      workItems: [item("wrk_a", { status: "approved" }), item("wrk_b"), item("wrk_c", { status: "running" })],
      events: [],
      now: NOW
    });
    app.emit("work_item.approved", { "work_item.id": "wrk_a" });
    await app.advance(1_500);

    const reasonAfter = app.document.querySelector('[data-reason="wrk_b"]') as HTMLInputElement;
    expect(reasonAfter).not.toBe(reason); // the section really was re-rendered
    expect(reasonAfter.value).toBe("half-typed justification");
    expect(app.document.activeElement).toBe(reasonAfter);
    expect(app.document.querySelector('[data-reason="wrk_a"]')).toBeNull();
    expect(app.document.querySelector('[data-work-item="wrk_c"]')?.classList.contains("selected")).toBe(true);
    expect((app.document.querySelector('[data-work-item="wrk_a"]') as HTMLElement).hidden).toBe(true);
    expect(app.text("#queue-filter-count")).toBe("1 of 3 items");
  });

  it("refreshes in place after an approval instead of hard-reloading (#7)", async () => {
    const app = bootLive({
      workItems: [item("wrk_a")],
      events: [],
      approvalActionsByWorkItem: { wrk_a: [{ actionHash: "hash-a", kind: "shell" }] },
      now: NOW
    });
    app.open();
    await app.advance(2_000);
    const baseline = app.fragmentFetches();

    (app.document.querySelector('[data-reason="wrk_a"]') as HTMLInputElement).value = "looks right";
    app.setModel({ workItems: [item("wrk_a", { status: "approved" })], events: [], now: NOW });
    (app.document.querySelector('[data-approve="wrk_a"]') as HTMLButtonElement).click();
    await app.advance(1_500);

    expect(app.calls.find((call) => call.method === "POST")).toEqual({
      url: "/work-items/wrk_a/approve",
      method: "POST",
      body: { reason: "looks right", actionHash: "hash-a" }
    });
    expect(app.text("#action-status")).toBe("approve accepted for wrk_a");
    expect(app.fragmentFetches()).toBe(baseline + 1);
    expect(app.text("#approvals-count")).toBe("0 waiting");
    expect(app.assigned).toEqual([]);
  });

  it("catches up after a reconnect by re-fetching sections, not reloading (#7)", async () => {
    const app = bootLive({ workItems: [item("wrk_a")], events: [], now: NOW });
    app.open();
    await app.advance(2_000);
    app.error();
    app.setModel({
      workItems: [item("wrk_a"), item("wrk_missed", { title: "Missed while offline" })],
      events: [],
      now: NOW
    });
    await app.advance(1_000);
    app.open();
    await app.advance(1_000);

    expect(app.document.querySelector('[data-work-item="wrk_missed"]')).not.toBeNull();
    expect(app.text("#action-status")).toBe("Live stream reconnected");
    expect(app.assigned).toEqual([]);
  });

  it("re-loads the open work-item detail for its own events and keeps the typed control reason", async () => {
    const app = bootLive({ workItems: [item("wrk_a", { status: "running" })], events: [], now: NOW });
    app.open();
    await app.advance(2_000);
    (app.document.querySelector('[data-work-item="wrk_a"]') as HTMLElement).click();
    await app.flush();
    (app.document.querySelector('[data-control-reason="wrk_a"]') as HTMLInputElement).value = "about to cancel";

    app.setModel({ workItems: [item("wrk_a", { status: "blocked" })], events: [], now: NOW });
    app.emit("work_item.blocked", { "work_item.id": "wrk_a" });
    await app.flush();

    expect(app.text("#work-detail .detail-head")).toContain("blocked");
    expect((app.document.querySelector('[data-control-reason="wrk_a"]') as HTMLInputElement).value).toBe(
      "about to cancel"
    );
  });

  it("clears the composer and refreshes after creating a work item (#7)", async () => {
    const app = bootLive({ workItems: [], events: [], now: NOW });
    app.open();
    await app.advance(2_000);
    app.setPostResponse({ status: 201, body: { id: "wrk_made" } });
    const form = app.document.querySelector("#task-form") as HTMLFormElement;
    (form.querySelector('[name="title"]') as HTMLInputElement).value = "Composer task";
    (form.querySelector('[name="intent"]') as HTMLTextAreaElement).value = "do the thing";
    form.dispatchEvent(new app.window.Event("submit", { bubbles: true, cancelable: true }));
    await app.advance(1_500);

    expect(app.text("#task-result")).toBe("Created wrk_made");
    expect(app.text("#action-status")).toBe("Created wrk_made");
    expect((form.querySelector('[name="title"]') as HTMLInputElement).value).toBe("");
    expect(app.assigned).toEqual([]);
  });
});

describe("live dashboard review fixes", () => {
  it("refreshes periodically while connected so agent freshness ages out without events", async () => {
    const app = bootLive({ workItems: [item("wrk_a")], events: [], now: NOW });
    app.open();
    await app.advance(2_000);
    const baseline = app.fragmentFetches();
    await app.advance(PERIODIC_REFRESH_MS);
    expect(app.fragmentFetches()).toBe(baseline + 1);
    app.error();
    await app.advance(500);
    const whileDown = app.fragmentFetches();
    await app.advance(PERIODIC_REFRESH_MS);
    // Reconnect attempts may catch up, but the periodic timer itself is idle while down.
    expect(app.fragmentFetches() - whileDown).toBeLessThanOrEqual(1);
  });

  it("refreshes for execution attempt and lease events", async () => {
    const app = bootLive({ workItems: [item("wrk_a", { status: "running" })], events: [], now: NOW });
    app.open();
    await app.advance(2_000);
    for (const name of ["attempt_lease.renewed", "attempt_lease.expired", "execution_attempt.transitioned"]) {
      const before = app.fragmentFetches();
      app.emit(name, { "work_item.id": "wrk_a" });
      await app.advance(1_500);
      expect(app.fragmentFetches(), name).toBe(before + 1);
    }
  });

  it("ignores a superseded work-detail response for the same item", async () => {
    const app = bootLive({ workItems: [item("wrk_a", { status: "running" })], events: [], now: NOW });
    app.open();
    await app.advance(2_000);
    const releases: Array<() => void> = [];
    app.setDetailGate(() => new Promise<void>((resolve) => releases.push(resolve)));

    (app.document.querySelector('[data-work-item="wrk_a"]') as HTMLElement).click(); // snapshot: running
    await app.flush();
    app.setModel({ workItems: [item("wrk_a", { status: "blocked" })], events: [], now: NOW });
    app.emit("work_item.blocked", { "work_item.id": "wrk_a" }); // snapshot: blocked
    await app.flush();
    expect(releases).toHaveLength(2);

    releases[1]!(); // newer response lands first
    await app.flush();
    releases[0]!(); // stale response lands last
    await app.flush();
    expect(app.text("#work-detail .detail-head")).toContain("blocked");
    expect(app.text("#work-detail .detail-head")).not.toContain("running");
  });

  it("catches up the timeline, connectors, policy, and agent roster after a reconnect", async () => {
    const app = bootLive({ workItems: [], events: [], now: NOW });
    app.open();
    await app.advance(2_000);
    app.error();
    app.setModel({
      workItems: [],
      events: [
        {
          sequence: 1,
          name: "policy.decided",
          timeUnixNano: "1790000000000000000",
          attributes: { "work_item.id": "wrk_missed", "policy.decision": "deny" },
          body: { workItemId: "wrk_missed", decision: "deny", reason: "denied while offline", matchedRules: [] }
        } as unknown as MissionControlViewModel["events"][number]
      ],
      now: NOW
    });
    const rosterFetchesBefore = app.calls.filter((call) => call.url === "/agents").length;
    await app.advance(1_000);
    app.open();
    await app.advance(1_500);

    expect(app.text("#events-timeline")).toContain("policy.decided");
    expect(app.text("#policy-body .decision-deny dd")).toBe("1");
    expect(app.calls.filter((call) => call.url === "/agents").length).toBeGreaterThan(rosterFetchesBefore);
  });

  it("does not replace the live timeline on ordinary refreshes", async () => {
    const app = bootLive({ workItems: [item("wrk_a")], events: [], now: NOW });
    app.open();
    await app.advance(2_000);
    app.emit("work_item.running", { "work_item.id": "wrk_a" });
    await app.advance(1_500);
    expect(app.text("#events-timeline")).toContain("work_item.running");
  });

  it("retries failed fragment fetches with backoff and only marks successful updates", async () => {
    const app = bootLive({ workItems: [item("wrk_a")], events: [], now: NOW });
    app.failNextFragments(2);
    app.open();
    await app.advance(0);
    expect(app.fragmentFetches()).toBe(1);
    expect(app.liveText()).toContain("refresh failed, retrying");
    expect(app.text("#dashboard-updated")).toBe("");

    await app.advance(1_000); // first retry after 1s, fails again
    expect(app.fragmentFetches()).toBe(2);
    await app.advance(1_999);
    expect(app.fragmentFetches()).toBe(2);
    app.setModel({ workItems: [item("wrk_a"), item("wrk_b")], events: [], now: NOW });
    await app.advance(1); // second retry after 2s succeeds
    expect(app.fragmentFetches()).toBe(3);
    expect(app.document.querySelector('[data-work-item="wrk_b"]')).not.toBeNull();
    expect(app.liveText()).not.toContain("refresh failed");
    expect(app.text("#dashboard-updated")).toMatch(/^Updated /);
  });
});
