import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { renderDashboard } from "./index.js";
import { PAGE_META } from "./render/page-meta.js";
import { styles as dashboardStyles } from "./styles.js";

type Json = Record<string, unknown>;
interface Call {
  url: string;
  method: string;
  body?: Json;
}

const agent = (over: Json = {}): Json => ({
  id: "claude",
  displayName: "Claude Code",
  provider: "anthropic",
  installed: true,
  version: "2.1.284",
  versionDrift: false,
  verifiedAgainst: "2.1.284",
  loginDetected: true,
  readOnlySupported: true,
  editContainment: "acceptEdits permission mode",
  registryId: "cli-claude",
  registered: false,
  dispatchable: true,
  ...over
});

const gatewayAgents = (over: Json = {}) => ({
  dispatch: {
    enabled: true,
    repoRoots: ["/repos"],
    repos: ["/repos/acs", "/repos/other"],
    maxConcurrent: 3,
    active: 0,
    ...over
  },
  agents: [
    agent(),
    agent({
      id: "hermes",
      displayName: "Hermes",
      readOnlySupported: false,
      registryId: "cli-hermes"
    }),
    agent({
      id: "gemini",
      displayName: "Gemini CLI",
      dispatchable: false,
      dispatchBlockedReason: "Google rejects this account",
      unavailableReason: "Google rejects this account"
    }),
    agent({
      id: "cline",
      displayName: "<img src=x onerror=alert(1)>",
      installed: false,
      dispatchable: false,
      unavailableReason: "not installed on this machine"
    })
  ]
});

function boot(handlers: Record<string, (body?: Json) => { status?: number; body: unknown }> = {}) {
  const calls: Call[] = [];
  const listeners = new Map<string, (event: { data: string; type: string }) => void>();
  const dom = new JSDOM(renderDashboard({ workItems: [], events: [], now: new Date("2026-10-02T00:00:00.000Z") }), {
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
        const body = init?.body ? (JSON.parse(init.body) as Json) : undefined;
        calls.push({ url, method, ...(body ? { body } : {}) });
        const handler = handlers[`${method} ${url}`];
        const out = handler ? handler(body) : { body: {} };
        const status = out.status ?? 200;
        return { ok: status < 400, status, json: async () => out.body };
      };
    }
  });
  const document = dom.window.document;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) await tick();
  };
  const open = async () => {
    (dom.window as unknown as { location: { hash: string } }).location.hash = "#dispatch";
    dom.window.dispatchEvent(new dom.window.HashChangeEvent("hashchange"));
    await settle();
  };
  return {
    dom,
    document,
    calls,
    settle,
    open,
    connect: () => listeners.get("open")?.({ data: "", type: "open" }),
    emit: (name: string, data: unknown) => listeners.get(name)?.({ data: JSON.stringify(data), type: name })
  };
}

describe("page visibility", () => {
  it("has a display rule for every navigable page, so none can render blank", () => {
    const css = dashboardStyles();
    for (const view of Object.keys(PAGE_META)) {
      expect(css, `missing visibility rule for #${view}`).toContain(
        `body[data-active-view="${view}"] [data-view-panel~="${view}"]`
      );
    }
  });
});

describe("Dispatch page", () => {
  it("is a first-class page in the navigation", () => {
    const { document } = boot();
    const link = document.querySelector('nav a[data-nav="dispatch"]');
    expect(link?.textContent).toContain("Dispatch");
    expect(document.getElementById("agent-dispatch")?.getAttribute("data-view-panel")).toBe("dispatch");
    // The Create Task composer keeps its own anchor so #dispatch is free for the page.
    expect(document.getElementById("create-task")).not.toBeNull();
  });

  it("lists every CLI with its real state, escapes names, and only offers dispatchable agents", async () => {
    const ctx = boot({
      "GET /api/agent-clis": () => ({ body: gatewayAgents() }),
      "GET /api/agent-runs": () => ({ body: { runs: [], active: 0 } })
    });
    await ctx.open();
    const cards = [...ctx.document.querySelectorAll("[data-cli-agent]")];
    expect(cards.map((c) => c.getAttribute("data-cli-agent"))).toEqual(["claude", "hermes", "gemini", "cline"]);
    expect(ctx.document.querySelector('[data-cli-agent="gemini"]')?.textContent).toContain(
      "Google rejects this account"
    );
    expect(ctx.document.querySelector('[data-cli-agent="gemini"] .pill.blocked')).not.toBeNull();
    expect(ctx.document.querySelector('[data-cli-agent="cline"] .pill.missing')).not.toBeNull();
    // Hostile display names are text, never markup.
    expect(ctx.document.querySelector("#cli-agent-grid img")).toBeNull();
    expect(ctx.document.querySelector('[data-cli-agent="cline"] h3')?.textContent).toContain("<img src=x");
    const options = [...ctx.document.querySelectorAll('#dispatch-form select[name="agentId"] option')].map(
      (o) => o.textContent
    );
    expect(options).toEqual(["Claude Code", "Hermes"]);
    expect((ctx.document.querySelector('input[name="repo"]') as HTMLInputElement).value).toBe("/repos/acs");
  });

  it("disables read-only for CLIs without a verified read-only mode", async () => {
    const ctx = boot({
      "GET /api/agent-clis": () => ({ body: gatewayAgents() }),
      "GET /api/agent-runs": () => ({ body: { runs: [] } })
    });
    await ctx.open();
    const select = ctx.document.querySelector('#dispatch-form select[name="agentId"]') as HTMLSelectElement;
    const readOnly = ctx.document.querySelector('input[name="mode"][value="read-only"]') as HTMLInputElement;
    expect(readOnly.disabled).toBe(false);
    readOnly.checked = true;
    select.value = "hermes";
    select.dispatchEvent(new ctx.dom.window.Event("change", { bubbles: true }));
    expect(readOnly.disabled).toBe(true);
    expect((ctx.document.querySelector('input[name="mode"][value="edit"]') as HTMLInputElement).checked).toBe(true);
  });

  it("explains when dispatch is off and refuses to offer a run", async () => {
    const ctx = boot({
      "GET /api/agent-clis": () => ({
        body: {
          dispatch: { enabled: false, repoRoots: [], maxConcurrent: 3, active: 0 },
          agents: [agent({ dispatchable: false, unavailableReason: "agent dispatch is off on this gateway" })]
        }
      }),
      "GET /api/agent-runs": () => ({ body: { runs: [] } })
    });
    await ctx.open();
    const banner = ctx.document.getElementById("dispatch-banner") as HTMLElement;
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain("ACS_AGENT_DISPATCH_ENABLED=1");
    expect((ctx.document.getElementById("dispatch-submit") as HTMLButtonElement).disabled).toBe(true);
    expect((ctx.document.querySelector("[data-cli-test]") as HTMLButtonElement).disabled).toBe(true);
  });

  it("previews, asks for confirmation, and only then dispatches the confirmed command", async () => {
    const preview = {
      agentId: "claude",
      displayName: "Claude Code",
      mode: "edit",
      repoRoot: "/repos/acs",
      timeoutSec: 600,
      containment: "acceptEdits permission mode",
      branchPattern: "acs/agent/claude-<run id>",
      promptChars: 14,
      confirmationHash: "a".repeat(64)
    };
    const run = {
      runId: "run_0123456789ab",
      agentId: "claude",
      mode: "edit",
      status: "queued",
      repoRoot: "/repos/acs",
      actorId: "user",
      requestedAt: "2026-10-02T00:00:00.000Z",
      promptPreview: "fix the bug"
    };
    const ctx = boot({
      "GET /api/agent-clis": () => ({ body: gatewayAgents() }),
      "GET /api/agent-runs": () => ({ body: { runs: [run] } }),
      "POST /api/agent-runs/preview": () => ({ body: { preview } }),
      "POST /api/agent-runs": () => ({ status: 202, body: { run } }),
      "GET /api/agent-runs/run_0123456789ab": () => ({ body: { run, output: "hello <b>world</b>" } })
    });
    await ctx.open();
    const form = ctx.document.getElementById("dispatch-form") as HTMLFormElement;
    (form.querySelector('textarea[name="prompt"]') as HTMLTextAreaElement).value = "fix the bug";
    const submit = () => form.dispatchEvent(new ctx.dom.window.Event("submit", { bubbles: true, cancelable: true }));

    // Not connected yet: nothing is sent.
    submit();
    await ctx.settle();
    expect(ctx.calls.some((c) => c.method === "POST")).toBe(false);
    expect(ctx.document.getElementById("dispatch-result")?.textContent).toContain("Disconnected");

    ctx.connect();
    // Declining the confirmation dispatches nothing.
    submit();
    await ctx.settle();
    const dialog = ctx.document.getElementById("dispatch-confirm-dialog");
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("acs/agent/claude-<run id>");
    expect(dialog?.textContent).toContain("aaaaaaaaaaaaaaaa");
    (ctx.document.getElementById("dispatch-confirm-cancel") as HTMLButtonElement).click();
    await ctx.settle();
    expect(ctx.calls.filter((c) => c.method === "POST" && c.url === "/api/agent-runs")).toHaveLength(0);

    // Confirming sends the hash the server returned, with the same fields that were previewed.
    submit();
    await ctx.settle();
    (ctx.document.getElementById("dispatch-confirm-ok") as HTMLButtonElement).click();
    await ctx.settle();
    const dispatched = ctx.calls.filter((c) => c.method === "POST" && c.url === "/api/agent-runs");
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.body).toMatchObject({
      agentId: "claude",
      repo: "/repos/acs",
      mode: "edit",
      prompt: "fix the bug",
      timeoutSec: 900,
      confirmationHash: "a".repeat(64)
    });
    expect(ctx.document.getElementById("dispatch-result")?.textContent).toContain("run_0123456789ab");

    // Output is shown as text, never as markup.
    const output = ctx.document.getElementById("agent-run-output") as HTMLElement;
    expect(output.textContent).toBe("hello <b>world</b>");
    expect(output.querySelector("b")).toBeNull();
    expect(ctx.document.querySelector("[data-agent-run-cancel]")).not.toBeNull();

    // A live audit event refreshes the list without a reload.
    const before = ctx.calls.filter((c) => c.url === "/api/agent-runs" && c.method === "GET").length;
    ctx.emit("agent_run.finished", { name: "agent_run.finished", body: { runId: "run_0123456789ab" } });
    await ctx.settle();
    expect(ctx.calls.filter((c) => c.url === "/api/agent-runs" && c.method === "GET").length).toBeGreaterThan(before);
  });
});

describe("governed mission dispatch UI", () => {
  it("reviews a snapshot, invalidates edited confirmation, and schedules only after a separate click", async () => {
    const hash = "a".repeat(64);
    const ctx = boot({
      "GET /work-items/mission-fixture/change-sets": () => ({ body: { manifestHash: hash } }),
      "POST /api/mission-dispatch/preview": () => ({
        body: {
          preview: {
            confirmationHash: "b".repeat(64),
            objective: "<script>untrusted</script>",
            executingActorId: "planner",
            operations: [{ toolName: "read_file" }],
            expiresAt: "2026-10-03T12:00:00Z"
          }
        }
      }),
      "POST /api/mission-dispatch": () => ({ body: { enabled: true, dispatches: [] } })
    });
    try {
      ctx.connect();
      const form = ctx.document.getElementById("mission-dispatch-form") as HTMLFormElement;
      (form.elements.namedItem("missionId") as HTMLInputElement).value = "mission-fixture";
      (form.elements.namedItem("approvalId") as HTMLInputElement).value = "approval-fixture";
      form.dispatchEvent(new ctx.dom.window.Event("submit", { bubbles: true, cancelable: true }));
      await ctx.settle();
      expect(ctx.calls.filter((call) => call.url === "/api/mission-dispatch" && call.method === "POST")).toHaveLength(
        0
      );
      expect(ctx.document.querySelector("#mission-dispatch-review script")).toBeNull();
      expect(ctx.document.getElementById("mission-dispatch-review")!.textContent).toContain(
        "<script>untrusted</script>"
      );
      const confirm = ctx.document.getElementById("mission-dispatch-confirm") as HTMLButtonElement;
      expect(confirm.hidden).toBe(false);
      form.dispatchEvent(new ctx.dom.window.Event("input", { bubbles: true }));
      expect(confirm.hidden).toBe(true);
      form.dispatchEvent(new ctx.dom.window.Event("submit", { bubbles: true, cancelable: true }));
      await ctx.settle();
      confirm.click();
      await ctx.settle();
      const requests = ctx.calls.filter((call) => call.url === "/api/mission-dispatch" && call.method === "POST");
      expect(requests).toHaveLength(1);
      expect(requests[0]!.body).toEqual({
        missionId: "mission-fixture",
        approvalId: "approval-fixture",
        expectedManifestHash: hash,
        confirmationHash: "b".repeat(64)
      });
      expect(ctx.document.getElementById("mission-dispatch-result")!.textContent).toContain(
        "does not mean execution completed"
      );
    } finally {
      ctx.dom.window.close();
    }
  });
});
