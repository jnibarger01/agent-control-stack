import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { assertCanTransition, type WorkItemStatus } from "@agent-control-stack/work-items";
import {
  renderDashboard,
  renderWorkItemDetailHtml,
  WORK_ITEM_STATUS_VALUES,
  workItemControlsFor,
  workItemControlsHtml
} from "./index.js";

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "rejected"]);

function canTransition(from: WorkItemStatus, to: WorkItemStatus): boolean {
  try {
    assertCanTransition(from, to);
    return true;
  } catch {
    return false;
  }
}

const workItem = {
  id: "wrk_ctl",
  title: "Control fixture",
  requester: "user" as const,
  status: "running" as const,
  intent: "exercise controls",
  target: { cwd: "/repo" },
  requestedActions: [{ kind: "shell", description: "run tests", params: {} }],
  risk: "low" as const,
  createdAt: "2026-09-22T00:00:00.000Z",
  updatedAt: "2026-09-22T00:00:00.000Z"
};

type FetchCall = { url: string; method: string; body?: unknown };

function bootDashboard(
  item: typeof workItem | (Omit<typeof workItem, "status" | "risk"> & { status: string; risk: string }),
  responses: Record<string, { status: number; body: unknown }> = {}
) {
  const listeners = new Map<string, (event: { data: string; type: string }) => void>();
  const calls: FetchCall[] = [];
  const dom = new JSDOM(
    renderDashboard({ workItems: [item as typeof workItem], events: [], now: new Date("2026-09-22T00:01:00.000Z") }),
    {
      runScripts: "dangerously",
      beforeParse(window) {
        (window as unknown as { EventSource: unknown }).EventSource = class {
          addEventListener(name: string, listener: (event: { data: string; type: string }) => void) {
            listeners.set(name, listener);
          }
          close() {}
        };
        (window as unknown as { fetch: unknown }).fetch = async (
          url: string,
          init?: { method?: string; body?: string }
        ) => {
          const method = init?.method ?? "GET";
          calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
          const canned = responses[`${method} ${url}`];
          if (canned) return { ok: canned.status < 400, status: canned.status, json: async () => canned.body };
          if (method === "GET" && url === `/work-items/${item.id}`) {
            return { ok: true, status: 200, json: async () => ({ workItem: item, events: [] }) };
          }
          return { ok: true, status: 200, json: async () => ({ agents: [] }) };
        };
      }
    }
  );
  const window = dom.window as unknown as Window & { onWorkItemControlSucceeded: (...args: unknown[]) => void };
  const succeeded: unknown[][] = [];
  window.onWorkItemControlSucceeded = (...args: unknown[]) => {
    succeeded.push(args);
  };
  const document = window.document;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    document,
    calls,
    succeeded,
    tick,
    connect: () => listeners.get("open")?.({ data: "", type: "open" }),
    disconnect: () => listeners.get("error")?.({ data: "", type: "error" }),
    async openDetail() {
      (document.querySelector(`[data-work-item="${item.id}"]`) as HTMLElement).click();
      await tick();
      await tick();
    },
    control: (name: string) => document.querySelector(`[data-work-control="${name}"]`) as HTMLButtonElement | null,
    output: () => document.getElementById(`control-result-${item.id}`)?.textContent ?? "",
    posts: () => calls.filter((call) => call.method === "POST")
  };
}

describe("work-item control eligibility (#3)", () => {
  it("offers cancel exactly where the state machine allows an operator cancel", () => {
    for (const status of WORK_ITEM_STATUS_VALUES) {
      const offered = workItemControlsFor(status).includes("cancel");
      // `cancelling` -> `cancelled` is the worker finishing a cancel, not an operator action.
      const expected = status !== "cancelling" && canTransition(status, "cancelled");
      expect(offered, status).toBe(expected);
    }
  });

  it("offers retry only for terminal items and clone for every item", () => {
    for (const status of WORK_ITEM_STATUS_VALUES) {
      const controls = workItemControlsFor(status);
      expect(controls.includes("retry"), status).toBe(TERMINAL.has(status));
      expect(controls.includes("clone"), status).toBe(true);
    }
  });

  it("renders the controls section in server detail markup, with a reason field only when needed", () => {
    const running = renderWorkItemDetailHtml({ ...workItem });
    expect(running).toContain('data-work-control="cancel"');
    expect(running).toContain('data-work-control="clone"');
    expect(running).not.toContain('data-work-control="retry"');
    expect(running).toContain('data-control-reason="wrk_ctl"');

    const cloneOnly = workItemControlsHtml({ ...workItem, status: "quarantined" });
    expect(cloneOnly).toContain('data-work-control="clone"');
    expect(cloneOnly).not.toContain("data-control-reason");

    expect(workItemControlsHtml({ ...workItem }, false)).toContain("disabled");
  });
});

describe("work-item controls in the live client (#3)", () => {
  it("renders the same controls markup client-side as the server helper", async () => {
    const app = bootDashboard(workItem);
    app.connect();
    await app.openDetail();
    const clientMarkup = app.document.querySelector("[data-work-controls]")?.outerHTML;
    const serverMarkup = new JSDOM(workItemControlsHtml(workItem)).window.document.querySelector(
      "[data-work-controls]"
    )?.outerHTML;
    expect(clientMarkup).toBeDefined();
    expect(clientMarkup).toBe(serverMarkup);
  });

  it("requires a reason and an explicit confirm before cancelling, and never POSTs on dismiss", async () => {
    const app = bootDashboard(workItem, {
      "POST /work-items/wrk_ctl/cancel": { status: 200, body: { workItem: { ...workItem, status: "cancelled" } } }
    });
    app.connect();
    await app.openDetail();

    app.control("cancel")?.click();
    await app.tick();
    expect(app.output()).toBe("Reason required");
    expect(app.posts()).toHaveLength(0);

    (app.document.querySelector('[data-control-reason="wrk_ctl"]') as HTMLInputElement).value = "stuck on lease";
    app.control("cancel")?.click();
    await app.tick();
    const dialog = app.document.getElementById("approval-confirm-dialog");
    expect(dialog?.textContent).toContain("Cancel this work item?");
    expect(app.document.getElementById("approval-confirm-cancel")?.textContent).toBe("Keep work item");
    (app.document.getElementById("approval-confirm-cancel") as HTMLButtonElement).click();
    await app.tick();
    expect(app.posts()).toHaveLength(0);

    app.control("cancel")?.click();
    await app.tick();
    (app.document.getElementById("approval-confirm-ok") as HTMLButtonElement).click();
    await app.tick();
    await app.tick();
    expect(app.posts()).toEqual([
      { url: "/work-items/wrk_ctl/cancel", method: "POST", body: { reason: "stuck on lease" } }
    ]);
    expect(app.output()).toBe("cancel accepted");
    expect(app.succeeded).toHaveLength(1);
  });

  it("retries a low-risk terminal item without a confirm and reports the new item id", async () => {
    const failed = { ...workItem, status: "failed" };
    const app = bootDashboard(failed, {
      "POST /work-items/wrk_ctl/retry": { status: 201, body: { workItem: { ...workItem, id: "wrk_retry" } } }
    });
    app.connect();
    await app.openDetail();
    expect(app.control("cancel")).toBeNull();

    (app.document.querySelector('[data-control-reason="wrk_ctl"]') as HTMLInputElement).value = "flaky network";
    app.control("retry")?.click();
    await app.tick();
    await app.tick();
    expect(app.document.getElementById("approval-confirm-dialog")).toBeNull();
    expect(app.posts()).toEqual([
      { url: "/work-items/wrk_ctl/retry", method: "POST", body: { reason: "flaky network" } }
    ]);
    expect(app.output()).toBe("retry created wrk_retry");
  });

  it("confirms clone for elevated risk and sends an empty body", async () => {
    const app = bootDashboard(
      { ...workItem, risk: "critical" },
      {
        "POST /work-items/wrk_ctl/clone": { status: 201, body: { workItem: { ...workItem, id: "wrk_clone" } } }
      }
    );
    app.connect();
    await app.openDetail();

    app.control("clone")?.click();
    await app.tick();
    expect(app.document.getElementById("approval-confirm-dialog")?.textContent).toContain("Clone this work item");
    (app.document.getElementById("approval-confirm-ok") as HTMLButtonElement).click();
    await app.tick();
    await app.tick();
    expect(app.posts()).toEqual([{ url: "/work-items/wrk_ctl/clone", method: "POST", body: {} }]);
    expect(app.output()).toBe("clone created wrk_clone");
  });

  it("surfaces backend rejections without reloading", async () => {
    const app = bootDashboard(
      { ...workItem, status: "failed" },
      {
        "POST /work-items/wrk_ctl/retry": { status: 429, body: { error: "pending work-item limit reached" } }
      }
    );
    app.connect();
    await app.openDetail();
    (app.document.querySelector('[data-control-reason="wrk_ctl"]') as HTMLInputElement).value = "again";
    app.control("retry")?.click();
    await app.tick();
    await app.tick();
    expect(app.output()).toBe("Rejected: pending work-item limit reached");
    expect(app.succeeded).toHaveLength(0);
    expect(app.control("retry")?.disabled).toBe(false);
  });

  it("disables controls while the live stream is down and ignores clicks", async () => {
    const app = bootDashboard(workItem);
    await app.openDetail();
    expect(app.control("cancel")?.disabled).toBe(true);

    app.connect();
    expect(app.control("cancel")?.disabled).toBe(false);
    app.disconnect();
    expect(app.control("cancel")?.disabled).toBe(true);
    expect(app.control("clone")?.disabled).toBe(true);
    expect(app.posts()).toHaveLength(0);
  });
});
