import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { bootLive } from "./live-harness.test-support.js";
import {
  applyMutationGate,
  applySseConnectionState,
  MUTATING_CONTROL_SELECTOR,
  MUTATING_CONTROL_SELECTORS,
  renderDashboard,
  renderWorkItemDetailHtml,
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

const gateModel: MissionControlViewModel = {
  workItems: [item("wrk_gate"), item("wrk_blocked", { status: "blocked" })],
  events: [],
  approvalActionsByWorkItem: { wrk_gate: [{ actionHash: "a".repeat(64), kind: "shell" }] },
  composerActionKinds: ["fs.read"],
  executionMode: "strict",
  now: NOW
};

/**
 * The full server-rendered page plus the work-item detail fragment, because
 * cancel/retry/clone controls only exist once an item is selected.
 */
function fixtureDocument(): Document {
  const dom = new JSDOM(renderDashboard(gateModel));
  const detail = dom.window.document.querySelector("#work-detail");
  if (detail) detail.innerHTML = renderWorkItemDetailHtml(item("wrk_running", { status: "running" }));
  return dom.window.document;
}

function gatedControls(document: Document): Array<{ disabled: boolean }> {
  return Array.from(document.querySelectorAll(MUTATING_CONTROL_SELECTOR)) as unknown as Array<{ disabled: boolean }>;
}

function control<T>(document: Document, selector: string): T {
  const found = document.querySelector(selector);
  expect(found, selector).not.toBeNull();
  return found as unknown as T;
}

describe("stale-stream mutation gate (wave-2 item #18)", () => {
  it("declares a selector for every mutating control the rendered page has", () => {
    const document = fixtureDocument();
    for (const selector of MUTATING_CONTROL_SELECTORS) {
      expect(document.querySelectorAll(selector).length, selector).toBeGreaterThan(0);
    }
  });

  it("disables every mutating control while the stream is stale", () => {
    const document = fixtureDocument();
    const before = gatedControls(document);
    expect(before.length).toBeGreaterThanOrEqual(MUTATING_CONTROL_SELECTORS.length);
    expect(before.some((control) => control.disabled)).toBe(false);

    applyMutationGate(document, false);

    for (const control of gatedControls(document)) {
      expect(control.disabled).toBe(true);
    }
    // The composer submit and the execution-mode toggle are the two controls
    // wave-2 #18 called out as missing from the wave-1 gate.
    expect(control<HTMLButtonElement>(document, "#task-form button[type=submit]").disabled).toBe(true);
    expect(control<HTMLInputElement>(document, "input[data-execution-mode]").disabled).toBe(true);
  });

  it("restores the server-rendered state on reconnect and never enables a hashless approval", () => {
    const dom = new JSDOM(
      renderDashboard({ workItems: [item("wrk_nohash")], events: [], executionMode: "strict", now: NOW })
    );
    const document = dom.window.document;
    const approve = control<HTMLButtonElement>(document, '[data-approve="wrk_nohash"]');
    const submit = control<HTMLButtonElement>(document, "#task-form button[type=submit]");
    expect(approve.disabled).toBe(true); // rendered disabled: no action hash to approve

    applySseConnectionState(document, false);
    expect(approve.disabled).toBe(true);
    expect(submit.disabled).toBe(true);

    applySseConnectionState(document, true);
    expect(submit.disabled).toBe(false); // the gate's own disable is undone
    expect(approve.disabled).toBe(true); // the server-rendered disable is not
  });

  it("ships the same gate and the same fail-closed handler guards in the client script", () => {
    const html = renderDashboard(gateModel);
    expect(html).toContain(MUTATING_CONTROL_SELECTOR);
    expect(html).toContain("function applyMutationGate(root, enabled)");
    expect(html).toContain("Disconnected: submit disabled until reconnect");
    expect(html).toContain("Disconnected: execution mode change disabled until reconnect");
  });
});

describe("stale-stream mutation gate in the live client", () => {
  it("gates the composer and the execution-mode toggle across an SSE drop, and blocks the racing submissions", async () => {
    const app = bootLive({ workItems: [], events: [], executionMode: "strict", now: NOW });
    await app.flush();
    app.open();
    await app.flush();

    const submit = control<HTMLButtonElement>(app.document, "#task-form button[type=submit]");
    const radios = Array.from(
      app.document.querySelectorAll("input[data-execution-mode]")
    ) as unknown as HTMLInputElement[];
    expect(radios).toHaveLength(2);
    expect(submit.disabled).toBe(false);
    expect(radios.every((radio) => !radio.disabled)).toBe(true);

    app.error();
    await app.flush();
    expect(submit.disabled).toBe(true);
    expect(radios.every((radio) => radio.disabled)).toBe(true);

    // A submit that races the gate must not create a work item.
    app.document
      .getElementById("task-form")
      ?.dispatchEvent(new app.window.Event("submit", { bubbles: true, cancelable: true }));
    await app.flush();
    expect(app.calls.filter((call) => call.method === "POST" && call.url === "/work-items")).toHaveLength(0);
    expect(app.text("#task-result")).toBe("Disconnected: submit disabled until reconnect");

    // Same for an execution-mode change.
    const admin = radios[1] as HTMLInputElement;
    admin.checked = true;
    admin.dispatchEvent(new app.window.Event("change", { bubbles: true }));
    await app.flush();
    expect(app.calls.filter((call) => call.method === "POST" && call.url === "/execution-mode")).toHaveLength(0);
    expect(app.text("#execution-mode-result")).toBe("Disconnected: execution mode change disabled until reconnect");

    app.open();
    await app.flush();
    expect(submit.disabled).toBe(false);
    expect(radios.every((radio) => !radio.disabled)).toBe(true);
  });
});
