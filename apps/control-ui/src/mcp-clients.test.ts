import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { renderDashboard } from "./index.js";
import { styles } from "./styles.js";

type Json = Record<string, any>;
const client = (over: Json = {}): Json => ({
  clientId: "client-muse-1",
  status: "unrecognized",
  lanes: ["jc"],
  subjects: ["chatgpt:jacen"],
  claims: [{ name: "Muse", version: "1.4", userAgent: "Muse/1.4 (Linux)" }],
  firstSeenAt: "2026-10-02T10:00:00.000Z",
  lastSeenAt: new Date().toISOString(),
  connects: 3,
  issued: 2,
  denied: 1,
  lastTool: "acs_read",
  suggestedKind: "muse",
  live: true,
  ...over
});
const payload = (clients: Json[], policy = "observe", legacy: Json[] = []) => ({
  summary: {
    total: clients.length,
    labelled: clients.filter((c) => c.status === "labelled").length,
    unrecognized: clients.filter((c) => c.status === "unrecognized").length,
    liveUnrecognized: clients.filter((c) => c.status === "unrecognized" && c.live).length,
    policy
  },
  clients,
  legacy
});

function boot(initial: Json, handlers: Record<string, (body?: Json) => { status?: number; body: unknown }> = {}) {
  const calls: Array<{ url: string; method: string; body?: Json }> = [];
  const listeners = new Map<string, (event: { data: string; type: string }) => void>();
  let current = initial;
  const dom = new JSDOM(renderDashboard({ workItems: [], events: [], now: new Date() }), {
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
        if (method === "GET" && url === "/api/mcp-clients") return { ok: true, status: 200, json: async () => current };
        const handler = handlers[`${method} ${url}`];
        const out = handler ? handler(body) : { body: {} };
        const status = out.status ?? 200;
        return { ok: status < 400, status, json: async () => out.body };
      };
    }
  });
  const document = dom.window.document;
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
  };
  return {
    dom,
    document,
    calls,
    settle,
    set: (next: Json) => {
      current = next;
    },
    connect: () => listeners.get("open")?.({ data: "", type: "open" }),
    emit: (name: string, data: unknown) => listeners.get(name)?.({ data: JSON.stringify(data), type: name }),
    rows: () => [...document.querySelectorAll("#mcp-clients-body tr[data-mcp-client]")] as HTMLElement[]
  };
}

describe("MCP clients panel", () => {
  it("sits on the Connectors page and is not blank under the view rules", () => {
    expect(styles()).toContain('body[data-active-view="connectors"] [data-view-panel~="connectors"]');
    const ctx = boot(payload([]));
    expect(ctx.document.getElementById("mcp-clients-panel")?.getAttribute("data-view-panel")).toBe("connectors");
  });

  it("lists clients with verified id and unverified claims, and suggests but never applies a kind", async () => {
    const ctx = boot(
      payload([
        client(),
        client({
          clientId: "client-chatgpt",
          status: "labelled",
          label: "ChatGPT (work)",
          kind: "chatgpt",
          note: "main account",
          claims: [],
          suggestedKind: undefined,
          live: false,
          lastSeenAt: "2026-10-01T10:00:00.000Z"
        })
      ])
    );
    await ctx.settle();
    const rows = ctx.rows();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Unrecognized");
    expect(rows[0]!.textContent).toContain("Looks like Muse (unverified)");
    expect(rows[0]!.textContent).toContain("Muse 1.4");
    expect(rows[0]!.textContent).toContain("Muse/1.4 (Linux)");
    expect(rows[0]!.textContent).toContain("3 connects · 2 issued · 1 denied");
    expect(rows[0]!.textContent).toContain("Jace Commander");
    expect(rows[0]!.querySelector("[data-mcp-label]")).not.toBeNull();
    expect(rows[1]!.textContent).toContain("ChatGPT (work)");
    expect(rows[1]!.textContent).toContain("main account");
    expect(rows[1]!.textContent).toContain("nothing declared");
    expect(rows[1]!.querySelector("[data-mcp-clear]")).not.toBeNull();
    expect(ctx.document.getElementById("mcp-clients-count")?.textContent).toBe("2 clients · 1 unrecognized");
    expect(ctx.document.getElementById("mcp-clients-policy")?.textContent).toBe("Observe only");
  });

  it("treats hostile client ids, names and user agents as text", async () => {
    const evil = '<img src=x onerror="alert(1)">';
    const ctx = boot(
      payload(
        [client({ clientId: evil, claims: [{ name: evil, userAgent: evil }], subjects: [evil], lastTool: evil })],
        "observe",
        [
          {
            subject: evil,
            lane: "jc",
            issued: 1,
            denied: 0,
            firstSeenAt: "2026-10-01T00:00:00Z",
            lastSeenAt: "2026-10-01T00:00:00Z"
          }
        ]
      )
    );
    await ctx.settle();
    expect(ctx.document.querySelector("#mcp-clients-body img, #mcp-legacy-body img, #mcp-client-alert img")).toBeNull();
    expect(ctx.rows()[0]!.textContent).toContain(evil);
    expect((ctx.document.getElementById("mcp-legacy") as HTMLElement).hidden).toBe(false);
  });

  it("raises a global alert only for live unrecognized clients, worded for the active policy", async () => {
    const observe = boot(payload([client()]));
    await observe.settle();
    const alert = observe.document.getElementById("mcp-client-alert") as HTMLElement;
    expect(alert.hidden).toBe(false);
    expect(alert.textContent).toContain("Unrecognized MCP client active: 1");
    expect(alert.textContent).toContain("Muse?");
    expect(alert.getAttribute("href")).toBe("#connectors");

    const blocking = boot(payload([client()], "require_label"));
    await blocking.settle();
    expect(blocking.document.getElementById("mcp-client-alert")?.textContent).toContain("Blocked: 1");
    expect(blocking.document.getElementById("mcp-clients-policy")?.textContent).toBe("Unlabelled clients are blocked");
    expect(blocking.document.getElementById("mcp-clients-notice")?.textContent).toContain(
      "blocked from ACS capability issuance"
    );

    const quiet = boot(
      payload([client({ live: false }), client({ clientId: "b", status: "labelled", label: "Grok", kind: "grok" })])
    );
    await quiet.settle();
    expect((quiet.document.getElementById("mcp-client-alert") as HTMLElement).hidden).toBe(true);
  });

  it("explains the empty state and a load failure", async () => {
    const empty = boot(payload([]));
    await empty.settle();
    expect(empty.document.getElementById("mcp-clients-body")?.textContent).toContain("No MCP client has connected yet");
    expect((empty.document.getElementById("mcp-legacy") as HTMLElement).hidden).toBe(true);

    const dom = new JSDOM(renderDashboard({ workItems: [], events: [], now: new Date() }), {
      runScripts: "dangerously",
      beforeParse(window) {
        (window as unknown as { EventSource: unknown }).EventSource = class {
          addEventListener() {}
          close() {}
        };
        (window as unknown as { fetch: unknown }).fetch = async () => ({
          ok: false,
          status: 500,
          json: async () => ({})
        });
      }
    });
    for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
    expect(dom.window.document.getElementById("mcp-clients-body")?.textContent).toContain("Could not load MCP clients");
  });

  it("labels a client through a dialog and sends exactly what the operator chose", async () => {
    const ctx = boot(payload([client()]), { "POST /api/mcp-clients/label": () => ({ body: { client: {} } }) });
    await ctx.settle();
    ctx.connect();
    (ctx.document.querySelector("[data-mcp-label]") as HTMLElement).click();
    await ctx.settle();
    const dialog = ctx.document.getElementById("mcp-client-dialog")!;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain("client-muse-1");
    expect((dialog.querySelector("#mcp-dialog-kind") as HTMLSelectElement).value).toBe("muse");
    expect((dialog.querySelector("#mcp-dialog-label") as HTMLInputElement).value).toBe("Muse");
    (dialog.querySelector("#mcp-dialog-label") as HTMLInputElement).value = "Muse (Jacen)";
    (dialog.querySelector("#mcp-dialog-note") as HTMLInputElement).value = "personal account";
    (dialog.querySelector("#mcp-dialog-ok") as HTMLElement).click();
    await ctx.settle();
    const posts = ctx.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      url: "/api/mcp-clients/label",
      body: { clientId: "client-muse-1", kind: "muse", label: "Muse (Jacen)", note: "personal account" }
    });
    expect(ctx.document.getElementById("mcp-client-dialog")).toBeNull();
  });

  it("cancelling the dialog sends nothing, and changes are refused while disconnected", async () => {
    const ctx = boot(payload([client()]));
    await ctx.settle();
    (ctx.document.querySelector("[data-mcp-label]") as HTMLElement).click();
    await ctx.settle();
    expect(ctx.document.getElementById("mcp-client-dialog")).toBeNull();
    expect(ctx.calls.some((c) => c.method === "POST")).toBe(false);
    ctx.connect();
    (ctx.document.querySelector("[data-mcp-label]") as HTMLElement).click();
    await ctx.settle();
    (ctx.document.getElementById("mcp-dialog-cancel") as HTMLElement).click();
    await ctx.settle();
    expect(ctx.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("warns that clearing a label blocks the client when the policy requires labels", async () => {
    const labelled = client({ status: "labelled", label: "Muse", kind: "muse" });
    const ctx = boot(payload([labelled], "require_label"), {
      "POST /api/mcp-clients/label/clear": () => ({ body: { client: {} } })
    });
    await ctx.settle();
    ctx.connect();
    (ctx.document.querySelector("[data-mcp-clear]") as HTMLElement).click();
    await ctx.settle();
    expect(ctx.document.getElementById("mcp-client-dialog")?.textContent).toContain(
      "will be blocked from ACS capability issuance"
    );
    (ctx.document.getElementById("mcp-dialog-ok") as HTMLElement).click();
    await ctx.settle();
    expect(ctx.calls.find((c) => c.method === "POST")).toMatchObject({
      url: "/api/mcp-clients/label/clear",
      body: { clientId: "client-muse-1" }
    });
  });

  it("refreshes from live audit events without a reload", async () => {
    const ctx = boot(payload([]));
    await ctx.settle();
    expect(ctx.rows()).toHaveLength(0);
    ctx.set(payload([client()]));
    ctx.emit("mcp_client.seen", { name: "mcp_client.seen", body: {} });
    await new Promise((r) => setTimeout(r, 1000));
    expect(ctx.rows()).toHaveLength(1);
    expect((ctx.document.getElementById("mcp-client-alert") as HTMLElement).hidden).toBe(false);
  });
});
