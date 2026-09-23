import { JSDOM, VirtualConsole } from "jsdom";
import { renderDashboard, renderDashboardFragments, type MissionControlViewModel } from "./index.js";

type SseListener = (event: { data: string; type: string }) => void;

/**
 * Boots the real dashboard client in JSDOM with a manual clock, so debounce,
 * throttle, and reconnect timing are exercised deterministically.
 */
export function bootLive(initial: MissionControlViewModel, extraRoutes: Record<string, (url: string) => unknown> = {}) {
  let now = 1_800_000_000_000;
  let nextTimerId = 1;
  const timers = new Map<number, { due: number; fn: () => void; every?: number }>();
  const sources: Array<Map<string, SseListener>> = [];
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const assigned: string[] = [];
  let model: MissionControlViewModel | ((finished?: number) => MissionControlViewModel) = initial;
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
        const path = url.split("?")[0] ?? url;
        if (path === "/dashboard/fragments") {
          const finished = new URL(url, "https://acs.local").searchParams.get("finished");
          const current = typeof model === "function" ? model(finished === null ? undefined : Number(finished)) : model;
          return { ok: true, status: 200, json: async () => ({ fragments: renderDashboardFragments(current) }) };
        }
        const extra = extraRoutes[path];
        if (extra) {
          const result = extra(url) as { status?: number; body?: unknown } | undefined;
          const status = result?.status ?? 200;
          return { ok: status < 400, status, json: async () => result?.body ?? {} };
        }
        if (method === "POST") {
          return { ok: postResponse.status < 400, status: postResponse.status, json: async () => postResponse.body };
        }
        const detail = url.match(/^\/work-items\/([^/]+)$/);
        if (detail) {
          const current = typeof model === "function" ? model() : model;
          const found = current.workItems.find((candidate) => candidate.id === decodeURIComponent(detail[1] ?? ""));
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
    setModel(next: MissionControlViewModel | ((finished?: number) => MissionControlViewModel)) {
      model = next;
    },
    setPostResponse(next: { status: number; body: unknown }) {
      postResponse = next;
    },
    fragmentFetches: () => calls.filter((call) => call.url.startsWith("/dashboard/fragments")).length,
    liveText: () => document.querySelector(".live")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    text: (selector: string) => document.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() ?? ""
  };
}
