import { describe, expect, it } from "vitest";
import { JSDOM, VirtualConsole } from "jsdom";
import {
  DASHBOARD_FRAGMENT_TARGETS,
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

type SseListener = (event: { data: string; type: string }) => void;

/**
 * Boots the real dashboard client in JSDOM with a manual clock, so debounce,
 * throttle, and reconnect timing are exercised deterministically.
 */
function bootLive(initial: MissionControlViewModel) {
  let now = 1_800_000_000_000;
  let nextTimerId = 1;
  const timers = new Map<number, { due: number; fn: () => void; every?: number }>();
  const sources: Array<Map<string, SseListener>> = [];
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const assigned: string[] = [];
  let model = initial;
  let postResponse: { status: number; body: unknown } = { status: 200, body: {} };

  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error: Error) => {
    // jsdom reports location.assign/reload as unimplemented navigation.
    if (/navigation/i.test(error.message)) assigned.push(error.message);
    else throw error;
  });
  const dom = new JSDOM(renderDashboard(initial), {
    runScripts: "dangerously",
    virtualConsole,
    url: "https://acs.local/",
    beforeParse(window) {
      const w = window as unknown as Record<string, unknown> & { Date: DateConstructor };
      w.Date.now = () => now;
      w.setTimeout = (fn: () => void, ms = 0) => {
        const id = nextTimerId++;
        timers.set(id, { due: now + Math.max(0, ms), fn });
        return id;
      };
      w.clearTimeout = (id: number) => timers.delete(id);
      w.setInterval = (fn: () => void, ms = 0) => {
        const id = nextTimerId++;
        timers.set(id, { due: now + ms, fn, every: ms });
        return id;
      };
      w.clearInterval = (id: number) => timers.delete(id);
      w.EventSource = class {
        listeners = new Map<string, SseListener>();
        constructor() {
          sources.push(this.listeners);
        }
        addEventListener(name: string, listener: SseListener) {
          this.listeners.set(name, listener);
        }
        close() {}
      };
      w.fetch = async (url: string, init?: { method?: string; body?: string }) => {
        const method = init?.method ?? "GET";
        calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
        if (url === "/dashboard/fragments") {
          return { ok: true, status: 200, json: async () => ({ fragments: renderDashboardFragments(model) }) };
        }
        if (method === "POST") {
          return { ok: postResponse.status < 400, status: postResponse.status, json: async () => postResponse.body };
        }
        const detail = url.match(/^\/work-items\/([^/]+)$/);
        if (detail) {
          const found = model.workItems.find((candidate) => candidate.id === decodeURIComponent(detail[1] ?? ""));
          return { ok: true, status: 200, json: async () => ({ workItem: found, events: [] }) };
        }
        return { ok: true, status: 200, json: async () => ({ agents: [] }) };
      };
    }
  });
  const window = dom.window;
  const document = window.document;

  const flush = async () => {
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const advance = async (ms: number) => {
    const target = now + ms;
    for (;;) {
      await flush();
      let nextId: number | undefined;
      let nextDue = Infinity;
      for (const [id, timer] of timers) {
        if (timer.due <= target && timer.due < nextDue) {
          nextDue = timer.due;
          nextId = id;
        }
      }
      if (nextId === undefined) break;
      const timer = timers.get(nextId)!;
      now = Math.max(now, timer.due);
      if (timer.every) timer.due = now + timer.every;
      else timers.delete(nextId);
      timer.fn();
    }
    now = target;
    await flush();
  };
  const source = () => sources.at(-1)!;
  const emit = (name: string, attributes: Record<string, string> = {}) =>
    source().get(name)?.({
      type: name,
      data: JSON.stringify({ name, timeUnixNano: String(now * 1_000_000), attributes })
    });

  return {
    window,
    document,
    calls,
    assigned,
    advance,
    flush,
    emit,
    open: () => source().get("open")?.({ data: "", type: "open" }),
    error: () => source().get("error")?.({ data: "", type: "error" }),
    setModel(next: MissionControlViewModel) {
      model = next;
    },
    setPostResponse(next: { status: number; body: unknown }) {
      postResponse = next;
    },
    fragmentFetches: () => calls.filter((call) => call.url === "/dashboard/fragments").length,
    liveText: () => document.querySelector(".live")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    text: (selector: string) => document.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() ?? ""
  };
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
