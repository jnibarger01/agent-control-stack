import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import {
  DEFAULT_APPROVAL_SLA_MS,
  formatWait,
  renderDashboard,
  renderWorkItemDetailHtml,
  sortApprovalItems,
  type MissionControlViewModel
} from "./index.js";
import { bootLive } from "./live-harness.test-support.js";

type Item = MissionControlViewModel["workItems"][number];

const HARNESS_NOW = 1_800_000_000_000;
const minutesAgo = (minutes: number, from = HARNESS_NOW) => new Date(from - minutes * 60_000).toISOString();

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
    createdAt: minutesAgo(120),
    updatedAt: minutesAgo(5),
    ...overrides
  } as Item;
}

describe("approval triage (#14)", () => {
  const now = new Date(HARNESS_NOW);

  it("orders by risk, then longest wait, keeping ties stable", () => {
    const sorted = sortApprovalItems(
      [
        item("low_old", { risk: "low", updatedAt: minutesAgo(90) }),
        item("high_new", { risk: "high", updatedAt: minutesAgo(1) }),
        item("critical", { risk: "critical", updatedAt: minutesAgo(2) }),
        item("high_old", { risk: "high", updatedAt: minutesAgo(40) }),
        item("tie_a", { risk: "medium", updatedAt: minutesAgo(10) }),
        item("tie_b", { risk: "medium", updatedAt: minutesAgo(10) })
      ],
      now
    );
    expect(sorted.map((entry) => entry.id)).toEqual(["critical", "high_old", "high_new", "tie_a", "tie_b", "low_old"]);
  });

  it("formats waits compactly", () => {
    expect(formatWait(45_000)).toBe("45s");
    expect(formatWait(12 * 60_000)).toBe("12m");
    expect(formatWait(185 * 60_000)).toBe("3h 5m");
    expect(formatWait(52 * 3_600_000)).toBe("2d 4h");
  });

  it("renders approvals in triage order with wait badges and an over-SLA flag", () => {
    const html = renderDashboard({
      workItems: [
        item("fresh_low", { updatedAt: minutesAgo(3) }),
        item("stale_medium", { risk: "medium", updatedAt: minutesAgo(45) }),
        item("blocked_high", { risk: "high", status: "blocked", updatedAt: minutesAgo(10) })
      ],
      events: [],
      now
    });
    const { document } = new JSDOM(html).window;
    const cards = [...document.querySelectorAll("#approvals-list .approval-item")];
    expect(cards.map((card) => card.getAttribute("data-work-item-ref"))).toEqual([
      "blocked_high",
      "stale_medium",
      "fresh_low"
    ]);
    expect(cards[1]?.classList.contains("overdue")).toBe(true);
    expect(cards[1]?.querySelector(".wait-badge")?.textContent).toBe("waiting 45m · over SLA");
    expect(cards[2]?.classList.contains("overdue")).toBe(false);
    expect(cards[2]?.querySelector(".wait-badge")?.textContent).toBe("waiting 3m");
    expect(cards[0]?.getAttribute("data-status")).toBe("blocked");
  });

  it("honours a custom SLA and measures metrics wait from the same timestamp", () => {
    const html = renderDashboard({
      workItems: [item("wrk_a", { createdAt: minutesAgo(600), updatedAt: minutesAgo(7) })],
      events: [],
      approvalSlaMs: 5 * 60_000,
      now
    });
    const { document } = new JSDOM(html).window;
    expect(document.querySelector(".approval-item")?.classList.contains("overdue")).toBe(true);
    expect(document.querySelector("#operator-metrics-body")?.textContent).toContain("7m 0s");
    expect(DEFAULT_APPROVAL_SLA_MS).toBe(30 * 60_000);
  });

  it("ticks wait badges forward between refreshes", async () => {
    const app = bootLive({
      workItems: [item("wrk_a", { updatedAt: minutesAgo(29) })],
      events: [],
      now: new Date(HARNESS_NOW)
    });
    expect(app.text(".wait-badge")).toBe("waiting 29m");
    await app.advance(75_000);
    expect(app.text(".wait-badge")).toBe("waiting 30m · over SLA");
    expect(app.document.querySelector(".approval-item")?.classList.contains("overdue")).toBe(true);
  });
});

describe("title badge (#16)", () => {
  it("counts waiting approvals in the tab title and follows live patches", async () => {
    const app = bootLive({
      workItems: [item("wrk_a"), item("wrk_b"), item("wrk_c", { status: "blocked" })],
      events: [],
      now: new Date(HARNESS_NOW)
    });
    expect(app.document.title).toBe("(2) ACS Mission Control");
    app.open();
    app.setModel({ workItems: [item("wrk_b")], events: [], now: new Date(HARNESS_NOW) });
    app.emit("work_item.approved", { "work_item.id": "wrk_a" });
    await app.advance(1_500);
    expect(app.document.title).toBe("(1) ACS Mission Control");
    app.setModel({ workItems: [], events: [], now: new Date(HARNESS_NOW) });
    app.emit("work_item.approved", { "work_item.id": "wrk_b" });
    await app.advance(1_500);
    expect(app.document.title).toBe("ACS Mission Control");
  });
});

describe("approval notifications (#16)", () => {
  function bootWithNotifications(visibility: () => DocumentVisibilityState) {
    const shown: Array<{ title: string; options: { body?: string; tag?: string } }> = [];
    let permission: NotificationPermission = "default";
    const app = bootLive(
      { workItems: [], events: [], now: new Date(HARNESS_NOW) },
      {},
      {
        beforeParse(window) {
          class FakeNotification {
            static get permission() {
              return permission;
            }
            static async requestPermission() {
              permission = "granted";
              return permission;
            }
            onclick: (() => void) | null = null;
            constructor(title: string, options: { body?: string; tag?: string }) {
              shown.push({ title, options });
            }
            close() {}
          }
          window.Notification = FakeNotification;
          Object.defineProperty((window as unknown as Window).document, "visibilityState", { get: visibility });
        }
      }
    );
    return { app, shown };
  }

  it("is opt-in, remembers the choice, and only notifies while the tab is hidden", async () => {
    let visibility: DocumentVisibilityState = "visible";
    const { app, shown } = bootWithNotifications(() => visibility);
    const toggle = app.document.getElementById("notifications-toggle") as HTMLButtonElement;
    expect(toggle.textContent).toBe("Notify me");
    app.open();

    app.emit("work_item.needs_approval", { "work_item.id": "wrk_1", "work_item.risk": "high" });
    visibility = "hidden";
    app.emit("work_item.needs_approval", { "work_item.id": "wrk_2" });
    expect(shown).toHaveLength(0); // not opted in yet

    toggle.click();
    await app.flush();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.textContent).toBe("Notifications on");
    expect(app.window.localStorage.getItem("acs.mc.notifications")).toBe("on");

    app.emit("work_item.needs_approval", { "work_item.id": "wrk_3", "work_item.risk": "high" });
    visibility = "visible";
    app.emit("work_item.needs_approval", { "work_item.id": "wrk_4" });
    expect(shown).toEqual([
      {
        title: "Approval needed",
        options: { body: "Work item wrk_3 (high risk) is waiting on an operator.", tag: "acs-approval-wrk_3" }
      }
    ]);

    toggle.click();
    await app.flush();
    expect(app.window.localStorage.getItem("acs.mc.notifications")).toBe("off");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("deep links (#15)", () => {
  it("opens ?item= on load in the queue view and keeps the URL in sync with selection", async () => {
    const app = bootLive(
      {
        workItems: [item("wrk_a", { status: "running" }), item("wrk_b", { status: "running" })],
        events: [],
        now: new Date(HARNESS_NOW)
      },
      {},
      { url: "https://acs.local/?item=wrk_b" }
    );
    await app.flush();
    expect(app.document.body.dataset.activeView).toBe("queue");
    expect(app.document.querySelector('[data-work-item="wrk_b"]')?.classList.contains("selected")).toBe(true);
    expect(app.text("#work-detail h3")).toBe("Task wrk_b");
    expect(app.document.querySelector("#work-detail .permalink")?.getAttribute("href")).toBe("?item=wrk_b#queue");

    (app.document.querySelector('[data-work-item="wrk_a"]') as HTMLElement).click();
    await app.flush();
    expect(app.window.location.search).toBe("?item=wrk_a");
  });

  it("puts the same permalink in the server-rendered detail and advertises shortcut help", () => {
    expect(renderWorkItemDetailHtml(item("wrk a/b"))).toContain('href="?item=wrk%20a%2Fb#queue"');
    const html = renderDashboard({ workItems: [], events: [], now: new Date(HARNESS_NOW) });
    expect(html).toContain("Press <kbd>?</kbd> for keyboard shortcuts");
  });
});

describe("keyboard shortcuts (#13)", () => {
  function boot() {
    return bootLive(
      {
        workItems: [
          item("wrk_a", { status: "running" }),
          item("wrk_b", { status: "needs_approval" }),
          item("wrk_c", { status: "running" })
        ],
        events: [],
        now: new Date(HARNESS_NOW)
      },
      {},
      { url: "https://acs.local/#queue" }
    );
  }

  it("moves through the queue with j/k and keeps focus on the row", async () => {
    const app = boot();
    app.key("j", { target: app.document.body });
    await app.flush();
    expect(app.document.activeElement?.getAttribute("data-work-item")).toBe("wrk_a");
    app.key("j");
    await app.flush();
    expect(app.document.activeElement?.getAttribute("data-work-item")).toBe("wrk_b");
    expect(app.document.querySelector('[data-work-item="wrk_b"]')?.classList.contains("selected")).toBe(true);
    app.key("k");
    await app.flush();
    expect(app.document.activeElement?.getAttribute("data-work-item")).toBe("wrk_a");
    expect(app.window.location.search).toBe("?item=wrk_a");
  });

  it("skips filtered-out rows", async () => {
    const app = boot();
    const filter = app.document.querySelector("#queue-filter-text") as HTMLInputElement;
    filter.value = "wrk_c";
    filter.dispatchEvent(new app.window.Event("input", { bubbles: true }));
    app.document.body.focus();
    app.key("j", { target: app.document.body });
    await app.flush();
    expect(app.document.activeElement?.getAttribute("data-work-item")).toBe("wrk_c");
  });

  it("jumps with / and g-sequences, and focuses the first waiting approval with a", () => {
    const app = boot();
    app.key("/", { target: app.document.body });
    expect(app.document.activeElement?.id).toBe("queue-filter-text");

    app.document.body.focus();
    app.key("g", { target: app.document.body });
    app.key("a", { target: app.document.body });
    expect(app.document.body.dataset.activeView).toBe("approvals");
    expect(app.window.location.hash).toBe("#approvals");

    app.key("g", { target: app.document.body });
    app.key("s", { target: app.document.body });
    expect(app.document.body.dataset.activeView).toBe("system");

    app.key("a", { target: app.document.body });
    expect(app.document.activeElement?.getAttribute("data-reason")).toBe("wrk_b");
  });

  it("ignores shortcuts while typing or with modifiers", async () => {
    const app = boot();
    const reason = app.document.querySelector('[data-reason="wrk_b"]') as HTMLInputElement;
    reason.focus();
    app.key("j");
    app.key("/");
    await app.flush();
    expect(app.document.activeElement).toBe(reason);
    app.document.body.focus();
    app.key("j", { target: app.document.body, ctrlKey: true });
    await app.flush();
    expect(app.document.querySelector(".queue-item.selected")).toBeNull();
  });

  it("opens and closes an accessible help dialog, restoring focus", () => {
    const app = boot();
    const search = app.document.querySelector("#queue-filter-text") as HTMLInputElement;
    const row = app.document.querySelector('[data-work-item="wrk_a"]') as HTMLElement;
    row.focus();
    app.key("?");
    const dialog = app.document.getElementById("shortcut-help");
    expect(dialog?.hidden).toBe(false);
    expect(dialog?.getAttribute("role")).toBe("dialog");
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.textContent).toContain("Next / previous work item");
    expect(app.document.activeElement?.id).toBe("shortcut-help-close");

    app.key("j");
    expect(app.document.querySelector(".queue-item.selected")).toBeNull();
    app.key("Escape");
    expect(dialog?.hidden).toBe(true);
    expect(app.document.activeElement).toBe(row);
    expect(search).toBeDefined();
  });
});
