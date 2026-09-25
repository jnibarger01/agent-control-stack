import { afterEach, describe, expect, it } from "vitest";
import { JSDOM, VirtualConsole } from "jsdom";
import { renderDashboard, type MissionControlViewModel } from "./index.js";

const item = {
  id: "wrk_ui",
  title: "Inspect service",
  requester: "user" as const,
  status: "needs_approval" as const,
  intent: "Read service status",
  target: { services: ["agent-a"] },
  requestedActions: [{ kind: "fs.read", description: "Inspect service", params: {} }],
  risk: "low" as const,
  createdAt: "2026-09-23T00:00:00.000Z",
  updatedAt: "2026-09-23T00:00:00.000Z"
};
const agent = (id: string) => ({
  id,
  displayName: id,
  kind: "worker",
  status: "online" as const,
  health: "healthy" as const,
  capabilities: [],
  metadata: {}
});
const initial: MissionControlViewModel = {
  workItems: [item],
  events: [],
  agents: [agent("agent-a"), agent("agent-b")],
  executionMode: "strict",
  approvalActionsByWorkItem: { wrk_ui: [{ actionHash: "bound-action-hash", kind: "fs.read" }] }
};
function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => String(body) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, no) => {
    resolve = ok;
    reject = no;
  });
  return { promise, resolve, reject };
}
const windows: JSDOM[] = [];
afterEach(() => {
  for (const dom of windows.splice(0)) dom.window.close();
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
function harness(model = initial) {
  let snapshot = model;
  let handler:
    | ((
        url: string,
        init: RequestInit
      ) => Promise<ReturnType<typeof response>> | ReturnType<typeof response> | undefined)
    | undefined;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const listeners = new Map<string, (event?: unknown) => void>();
  const errors: Error[] = [];
  const console = new VirtualConsole();
  console.on("jsdomError", (error) => {
    if (("type" in error ? error.type : "") !== "css-parsing") errors.push(error);
  });
  const dom = new JSDOM(renderDashboard(model), {
    url: "http://acs.test/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole: console,
    beforeParse(window) {
      Object.assign(window, {
        fetch: async (url: string, init: RequestInit = {}) => {
          calls.push({ url, init });
          const custom = handler?.(url, init);
          if (custom !== undefined) return custom;
          if (url === "/") return response(renderDashboard(snapshot));
          if (url === "/readyz") return response({ ready: true });
          if (url === "/api/visualizer/status") {
            return response({
              schemaVersion: 1,
              configured: false,
              reachable: false,
              state: "not_configured",
              sampledAt: "2026-09-23T00:00:00.000Z",
              sourceGeneratedAt: null,
              database: null,
              activeExecutions: null,
              queueDepth: null,
              pendingApprovals: null,
              eventStreamClients: null,
              runtimes: []
            });
          }
          if (url.startsWith("/api/visualizer/projection")) {
            return response({
              schemaVersion: 1,
              configured: false,
              generatedAt: "2026-09-23T00:00:00.000Z",
              items: []
            });
          }
          if (url.endsWith("/capabilities")) return response({ capabilities: [] });
          if (url.startsWith("/agents/") || url.startsWith("/api/agents/")) {
            const id = url.split("/").at(-1)!.split("?")[0]!;
            return response({ agent: agent(id), events: [] });
          }
          if (url.startsWith("/work-items/") && !init.method)
            return response({ workItem: snapshot.workItems[0], events: [] });
          return response({ error: "Unexpected request" }, 404);
        },
        EventSource: class {
          addEventListener(name: string, callback: (event?: unknown) => void) {
            listeners.set(name, callback);
          }
          close() {}
        }
      });
    }
  });
  windows.push(dom);
  const doc = dom.window.document;
  const get = <T extends Element = HTMLElement>(selector: string) => doc.querySelector<T>(selector)!;
  return {
    dom,
    doc,
    get,
    calls,
    errors,
    handle: (fn: typeof handler) => {
      handler = fn;
    },
    snapshot: (next: MissionControlViewModel) => {
      snapshot = next;
    },
    emit: (name: string, event?: unknown) => listeners.get(name)?.(event),
    ready: async () => {
      listeners.get("open")?.();
      await tick();
      expect(errors).toEqual([]);
    },
    refresh: async () => {
      await dom.window.eval("reconcileSnapshot()");
    }
  };
}

describe("emitted Mission Control client", () => {
  it("keeps a connected stream separate from reconciled approval state", async () => {
    const h = harness();
    const pending = deferred<ReturnType<typeof response>>();
    h.handle((url) => (url === "/" ? pending.promise : undefined));
    expect(h.get<HTMLButtonElement>("[data-approve]").disabled).toBe(true);
    h.emit("open");
    await tick();
    expect(h.get(".live").textContent).toContain("reconciling");
    expect(h.get<HTMLButtonElement>("[data-approve]").disabled).toBe(true);
    pending.resolve(response(renderDashboard(initial)));
    await tick();
    expect(h.get<HTMLButtonElement>("[data-approve]").disabled).toBe(false);
    h.emit("error");
    expect(h.get<HTMLButtonElement>("[data-approve]").disabled).toBe(true);
  });

  it("reconciles SSE work events while preserving drafts, filter, selection, and node identity", async () => {
    const h = harness();
    await h.ready();
    h.get<HTMLAnchorElement>('a[data-nav="queue"]').click();
    h.get<HTMLInputElement>("#queue-filter-text").value = "Inspect";
    h.get<HTMLInputElement>("#queue-filter-text").dispatchEvent(new h.dom.window.Event("input"));
    h.get<HTMLInputElement>("[data-reason]").value = "my reason";
    h.get<HTMLInputElement>('[name="title"]').value = "unsent draft";
    const row = h.get("[data-work-item]");
    (row as HTMLButtonElement).click();
    await tick();
    h.snapshot({ ...initial, workItems: [{ ...item, status: "running" }] });
    h.emit("work_item.running", {
      data: JSON.stringify({
        id: "evt_ui",
        name: "work_item.running",
        timeUnixNano: "1790121600000000000",
        attributes: {}
      })
    });
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(h.get("[data-work-item]")).toBe(row);
    expect(row.getAttribute("data-status")).toBe("running");
    expect(h.get("#overview").textContent).toContain("Running");
    expect(h.get("#overview").textContent).toContain("1");
    expect(h.get<HTMLInputElement>('[name="title"]').value).toBe("unsent draft");
    expect(h.get<HTMLInputElement>("#queue-filter-text").value).toBe("Inspect");
    expect(h.dom.window.location.hash).toBe("#queue");
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(h.errors).toEqual([]);
  });

  it("rolls mode selection back after rejection and never claims an unconfirmed active mode", async () => {
    const h = harness();
    await h.ready();
    const pending = deferred<ReturnType<typeof response>>();
    h.handle((url, init) => (url === "/execution-mode" && init.method === "POST" ? pending.promise : undefined));
    h.get<HTMLInputElement>('[data-execution-mode="admin"]').click();
    expect(h.get("#execution-mode-active").textContent).toBe("strict");
    const apply = h.get<HTMLButtonElement>("#execution-mode-apply");
    apply.click();
    apply.click();
    expect(apply.disabled).toBe(true);
    expect(h.calls.filter((c) => c.url === "/execution-mode")).toHaveLength(1);
    pending.resolve(response({ error: "denied" }, 403));
    await tick();
    expect(h.get<HTMLInputElement>('[data-execution-mode="strict"]').checked).toBe(true);
    expect(h.get("#execution-mode-result").textContent).toContain("Rejected: denied");
    expect(h.get("#admin-mode-banner").hasAttribute("hidden")).toBe(true);
  });

  it("contains mutation pending state and reconciles uncertain outcomes without replay", async () => {
    const h = harness();
    await h.ready();
    h.get<HTMLInputElement>("[data-reason]").value = "reviewed";
    const pending = deferred<ReturnType<typeof response>>();
    h.handle((url, init) => (init.method === "POST" ? pending.promise : undefined));
    const approve = h.get<HTMLButtonElement>("[data-approve]");
    approve.click();
    approve.click();
    expect(approve.disabled).toBe(true);
    expect(h.get(".approval-item").getAttribute("aria-busy")).toBe("true");
    expect(h.calls.filter((c) => c.init.method === "POST")).toHaveLength(1);
    pending.reject(new Error("offline"));
    await tick();
    expect(h.get(".approval-result").textContent).toContain("Outcome uncertain");
    expect(h.calls.filter((c) => c.init.method === "POST")).toHaveLength(1);
    expect(h.calls.at(-1)?.url).toBe("/");
    expect(h.get<HTMLInputElement>("[data-reason]").value).toBe("reviewed");
  });

  it("renders current Visualizer health in Overview and the Visualizer page", async () => {
    const h = harness();
    await h.ready();
    h.handle((url) =>
      url === "/api/visualizer/status"
        ? response({
            schemaVersion: 1,
            configured: true,
            reachable: true,
            state: "degraded",
            sampledAt: "2026-09-23T16:20:00.000Z",
            sourceGeneratedAt: "2026-09-23T16:19:59.000Z",
            database: "available",
            activeExecutions: 2,
            queueDepth: 1,
            pendingApprovals: 3,
            eventStreamClients: 1,
            runtimes: []
          })
        : undefined
    );

    await h.dom.window.eval("loadVisualizerStatus(true)");

    expect(h.get("[data-visualizer-health]").textContent).toBe("Degraded");
    expect(h.get(".visualizer-health-dot").classList.contains("degraded")).toBe(true);
    expect(h.get("#visualizer-health-state").textContent).toBe("Degraded");
    expect(h.get("#visualizer-health-detail").textContent).toContain("2 active");
    expect(h.get("#visualizer-health-detail").textContent).toContain("3 approvals");
  });

  it("routes to the Visualizer and renders only canonical Visualizer graph evidence", async () => {
    const h = harness();
    await h.ready();
    h.handle((url) =>
      url.startsWith("/api/visualizer/projection")
        ? response({
            schemaVersion: 1,
            configured: true,
            generatedAt: "2026-09-23T00:00:00.000Z",
            items: [{
              workItemId: "wrk_ui",
              title: "Inspect service",
              risk: "low",
              acsStatus: "needs_approval",
              executionId: "11111111-1111-5111-8111-111111111111",
              state: "available",
              projection: {
                revision: 3,
                eventPosition: 3,
                sourceRuntime: "codex",
                status: "waiting_approval",
                rootNodeId: "22222222-2222-5222-8222-222222222222",
                finalOutputNodeId: null,
                nodes: [
                  {
                    id: "22222222-2222-5222-8222-222222222222",
                    nodeType: "user_request",
                    status: "waiting_approval",
                    label: "user request attempt 1",
                    parentNodeId: null
                  },
                  {
                    id: "33333333-3333-5333-8333-333333333333",
                    nodeType: "approval_gate",
                    status: "waiting_approval",
                    label: "approval gate attempt 1",
                    parentNodeId: "22222222-2222-5222-8222-222222222222"
                  }
                ],
                edges: [{
                  id: "44444444-4444-5444-8444-444444444444",
                  fromNodeId: "22222222-2222-5222-8222-222222222222",
                  toNodeId: "33333333-3333-5333-8333-333333333333",
                  edgeType: "approval",
                  status: "active"
                }]
              }
            }]
          })
        : undefined
    );
    h.get<HTMLAnchorElement>('a[data-nav="visualizer"]').click();
    await tick();
    expect(h.dom.window.location.hash).toBe("#visualizer");
    expect(h.get("#view-heading").textContent).toBe("Visualizer");
    expect(h.get("#visualizer").hasAttribute("hidden")).toBe(false);
    expect(h.get("#visualizer").textContent).toContain("Canonical Execution Graph");
    expect(h.get("#visualizer-source-status").textContent).toContain("1 canonical");
    expect(h.doc.querySelectorAll("#visualizer .viz-canonical-node")).toHaveLength(2);
    expect(h.get("#visualizer").textContent).toContain("approval gate attempt 1");
    expect(h.get("#visualizer").textContent).toContain("approval");
    expect(h.doc.querySelectorAll("#visualizer [data-work-item]")).toHaveLength(0);
    expect(h.doc.querySelectorAll("#visualizer [data-viz-work-item]")).toHaveLength(1);
    expect(h.doc.querySelectorAll("#visualizer .viz-stage")).toHaveLength(0);
    expect(h.get("#viz-summary-canonical").textContent).toBe("1");
    expect(h.get("#viz-summary-active").textContent).toBe("1");
    expect(h.get("#viz-summary-not-projected").textContent).toBe("0");
    const runtimeFilter = h.get<HTMLSelectElement>("#visualizer-filter-runtime");
    runtimeFilter.value = "hermes";
    runtimeFilter.dispatchEvent(new h.dom.window.Event("change", { bubbles: true }));
    expect(h.get<HTMLElement>("[data-viz-work-item]").hidden).toBe(true);
    expect(h.get("#visualizer-filter-live").textContent).toContain("0 of 1");
    runtimeFilter.value = "codex";
    runtimeFilter.dispatchEvent(new h.dom.window.Event("change", { bubbles: true }));
    expect(h.get<HTMLElement>("[data-viz-work-item]").hidden).toBe(false);
    const projectionCalls = () =>
      h.calls.filter((call) => call.url === "/api/visualizer/projection?limit=20").length;
    const beforeEvent = projectionCalls();
    expect(beforeEvent).toBeGreaterThan(0);

    h.emit("work_item.running", {
      data: JSON.stringify({
        id: "evt_viz_refresh",
        name: "work_item.running",
        timeUnixNano: "1790121600000000000",
        attributes: { "work_item.id": "wrk_ui" }
      })
    });
    await new Promise((resolve) => setTimeout(resolve, 260));
    await tick();
    expect(projectionCalls()).toBeGreaterThan(beforeEvent);
  });

  it("sends global search into the existing Work Queue filter", async () => {
    const h = harness();
    await h.ready();
    const search = h.get<HTMLInputElement>("#global-search");
    search.value = "Inspect";
    search.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(h.dom.window.location.hash).toBe("#queue");
    expect(h.dom.window.location.search).toBe("?q=Inspect");
    expect(h.get("#view-heading").textContent).toBe("Work Queue");
    expect(h.get<HTMLInputElement>("#queue-filter-text").value).toBe("Inspect");
  });

  it("restores distinct destinations and filter parameters on Back and Forward", async () => {
    const h = harness();
    await h.ready();
    h.dom.window.history.replaceState(null, "", "/?status=running#queue");
    h.dom.window.dispatchEvent(new h.dom.window.PopStateEvent("popstate"));
    h.get<HTMLAnchorElement>('a[data-nav="execution"]').click();
    expect(h.dom.window.location.hash).toBe("#execution");
    expect(h.get("#view-heading").textContent).toBe("Execution");
    const currentNav = h.get('nav [aria-current="page"]');
    // The visible label is the text outside the decorative aria-hidden glyph span.
    expect(
      [...currentNav.childNodes]
        .filter((node) => node.nodeType === 3 && node.parentElement !== null && !node.parentElement.hasAttribute("aria-hidden"))
        .map((node) => node.textContent)
        .join("")
    ).toBe("Execution");
    expect(currentNav.querySelector("span[aria-hidden]")?.textContent).toBe("▷");
    h.dom.window.history.back();
    await tick();
    expect(h.get("#view-heading").textContent).toBe("Work Queue");
    expect(h.dom.window.location.search).toBe("?status=running");
    h.dom.window.history.forward();
    await tick();
    expect(h.get("#view-heading").textContent).toBe("Execution");
  });

  it("ignores late selected-agent responses and distinguishes unavailable capabilities", async () => {
    const h = harness();
    await h.ready();
    const old = deferred<ReturnType<typeof response>>();
    h.handle((url) =>
      url === "/agents/agent-a?limit=8"
        ? old.promise
        : url === "/api/agents/agent-b/capabilities"
          ? response({ error: "unavailable" }, 503)
          : undefined
    );
    h.get<HTMLButtonElement>('[data-agent="agent-a"] button').click();
    h.get<HTMLButtonElement>('[data-agent="agent-b"] button').click();
    await tick();
    expect(h.get("#agent-detail h3").textContent).toBe("agent-b");
    expect(h.get("#agent-detail").textContent).toContain("Capability data unavailable");
    old.resolve(response({ agent: agent("agent-a") }));
    await tick();
    expect(h.get("#agent-detail h3").textContent).toBe("agent-b");
    expect(h.get('[data-agent="agent-b"]').classList.contains("selected")).toBe(true);
  });

  it("contains modal focus, restores the trigger, uses Reject, and redacts summaries", async () => {
    const h = harness({ ...initial, workItems: [{ ...item, risk: "high", title: "Review Bearer abcdefghijklmnop" }] });
    await h.ready();
    h.get<HTMLAnchorElement>('a[data-nav="approvals"]').click();
    h.get<HTMLInputElement>("[data-reason]").value = "TOKEN=do-not-display";
    const reject = h.get<HTMLButtonElement>("[data-reject]");
    reject.focus();
    reject.click();
    await tick();
    const dialog = h.get("[role=dialog]");
    expect(dialog.textContent).toContain("Reject high-risk");
    expect(dialog.textContent).not.toContain("Deny");
    expect(dialog.textContent).not.toContain("do-not-display");
    expect((h.get("main") as HTMLElement).inert).toBe(true);
    expect(h.doc.activeElement?.id).toBe("approval-confirm-cancel");
    h.get<HTMLButtonElement>("#approval-confirm-ok").focus();
    h.doc.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "Tab", cancelable: true }));
    expect(h.doc.activeElement?.tagName).toBe("SUMMARY");
    h.doc.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, cancelable: true }));
    expect(h.doc.activeElement?.id).toBe("approval-confirm-ok");
    h.doc.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "Escape" }));
    await tick();
    expect(h.doc.activeElement).toBe(reject);
    expect((h.get("main") as HTMLElement).inert).toBeFalsy();
    expect(h.calls.some((c) => c.init.method === "POST")).toBe(false);
  });

  it("keeps paused audit content stable while collecting bounded pending events", async () => {
    const h = harness();
    await h.ready();
    const follow = h.get<HTMLInputElement>("#audit-follow");
    follow.checked = false;
    follow.dispatchEvent(new h.dom.window.Event("change"));
    h.emit("work_item.running", {
      data: JSON.stringify({
        id: "evt_a",
        name: "work_item.running",
        timeUnixNano: "1790121600000000000",
        attributes: { token: "private-value", "work_item.id": "wrk_ui" }
      })
    });
    expect(h.get("#events .timeline").children).toHaveLength(0);
    expect(h.get("#audit-new").textContent).toBe("1 new events");
    h.get<HTMLButtonElement>("#audit-new").click();
    expect(h.get("#events .timeline").children).toHaveLength(1);
    expect(h.get("#events .timeline").textContent).not.toContain("private-value");
    expect(h.get("#events details summary").textContent).toBe("Event attributes");
  });

  it("keeps actions disabled after failed reconciliation and renders no-match and unavailable separately", async () => {
    const h = harness();
    h.handle((url) => (url === "/" ? response({}, 503) : undefined));
    await h.ready();
    expect(h.get<HTMLButtonElement>("[data-approve]").disabled).toBe(true);
    expect(h.get('[data-freshness="approvals"]').textContent).toContain("Unavailable");
    const input = h.get<HTMLInputElement>("#queue-filter-text");
    input.value = "not-found";
    input.dispatchEvent(new h.dom.window.Event("input"));
    expect(h.get("#queue-no-matches").hasAttribute("hidden")).toBe(false);
    expect(h.get("#queue-empty").hasAttribute("hidden")).toBe(true);
  });
});
