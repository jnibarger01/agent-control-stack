import { describe, expect, it, vi } from "vitest";
import type { StoredAuditEvent } from "../api/types";
import { event } from "../test-fixtures";
import { EventStream, MAX_BUFFERED_EVENTS, isStreamTrustworthy } from "./events";
import { QueryCache } from "./query";

const encoder = new TextEncoder();

function frame(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function harness(
  overrides: {
    status?: number;
    backfill?: () => Promise<StoredAuditEvent[]>;
    headCheck?: () => Promise<StoredAuditEvent[]>;
  } = {}
) {
  const streams: Array<{ push: (text: string) => void; end: () => void; signal: AbortSignal }> = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  let now = Date.now();
  const statuses = [...(overrides.status ? [overrides.status] : [])];
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const status = statuses.shift() ?? 200;
    if (status !== 200) return new Response("no", { status });
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      }
    });
    init?.signal?.addEventListener("abort", () => {
      try {
        controller.error(new DOMException("aborted", "AbortError"));
      } catch {
        /* already closed */
      }
    });
    streams.push({
      push: (text) => controller.enqueue(encoder.encode(text)),
      end: () => controller.close(),
      signal: init!.signal!
    });
    return new Response(body, { status: 200 });
  });
  const cache = new QueryCache({ sleep: () => Promise.resolve() });
  const invalidate = vi.spyOn(cache, "invalidate");
  const markAllStale = vi.spyOn(cache, "markAllStale");
  const onUnauthorized = vi.fn();
  const stream = new EventStream({
    fetcher: fetcher as unknown as typeof fetch,
    cache,
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
    backfill: overrides.backfill ?? (async () => []),
    headCheck: overrides.headCheck ?? (async () => []),
    onUnauthorized
  });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const pending = () => timers.filter((t) => !t.cleared);
  return {
    stream,
    streams,
    timers,
    pending,
    fetcher,
    cache,
    invalidate,
    markAllStale,
    onUnauthorized,
    tick,
    advance: (ms: number) => (now += ms)
  };
}

describe("EventStream", () => {
  it("connecting → live on the gateway's ready frame, and only then", async () => {
    const h = harness();
    h.stream.start();
    expect(h.stream.getSnapshot().status).toBe("connecting");
    await h.tick();
    expect(h.stream.getSnapshot().status).toBe("connecting"); // HTTP 200 alone is not proof of a live stream
    h.streams[0]!.push("event: ready\ndata: {}\n\n");
    await h.tick();
    expect(h.stream.getSnapshot().status).toBe("live");
    expect(isStreamTrustworthy(h.stream.getSnapshot().status)).toBe(true);
  });

  it("ingests named audit events, de-duplicates by id, and reconciles caches in one batch", async () => {
    const h = harness();
    h.stream.start();
    await h.tick();
    h.streams[0]!.push("event: ready\ndata: {}\n\n");
    const e1 = event("work_item.needs_approval", { "work_item.id": "wrk_9" });
    const e2 = event("approval.granted", { "work_item.id": "wrk_9" });
    h.streams[0]!.push(frame(e1.name, e1) + frame(e2.name, e2) + frame(e1.name, e1));
    await h.tick();
    const snapshot = h.stream.getSnapshot();
    expect(snapshot.events.map((e) => e.id)).toEqual([e1.id, e2.id]);
    expect(snapshot.totalReceived).toBe(2);
    h.invalidate.mockClear();
    const flush = h.pending().find((t) => t.ms === 250);
    expect(flush).toBeDefined();
    flush!.fn();
    const keys = h.invalidate.mock.calls.map((c) => c[0]);
    expect(keys).toEqual(expect.arrayContaining(["events", "work-item:wrk_9", "work-items"]));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("drops malformed frames instead of rendering them", async () => {
    const h = harness();
    h.stream.start();
    await h.tick();
    h.streams[0]!.push('event: ready\ndata: {}\n\nevent: x\ndata: {not json\n\nevent: y\ndata: {"id":1}\n\n');
    await h.tick();
    expect(h.stream.getSnapshot().events).toHaveLength(0);
    expect(h.stream.getSnapshot().status).toBe("live");
  });

  it("bounds the buffered event window", async () => {
    const h = harness();
    h.stream.start();
    await h.tick();
    h.streams[0]!.push("event: ready\ndata: {}\n\n");
    const many = Array.from({ length: MAX_BUFFERED_EVENTS + 100 }, () => event("x.y"));
    h.streams[0]!.push(many.map((e) => frame(e.name, e)).join(""));
    await h.tick();
    expect(h.stream.getSnapshot().events).toHaveLength(MAX_BUFFERED_EVENTS);
    expect(h.stream.getSnapshot().totalReceived).toBe(MAX_BUFFERED_EVENTS + 100);
  });

  it("reconnects with bounded exponential backoff (1s,2s,4s,… cap 30s) and marks data stale while blind", async () => {
    const h = harness({ status: 503 });
    h.stream.start();
    await h.tick();
    expect(h.stream.getSnapshot().status).toBe("reconnecting");
    expect(h.markAllStale).toHaveBeenCalled();
    const delays: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const retry = h.pending().at(-1)!;
      delays.push(retry.ms);
      h.fetcher.mockImplementationOnce(async () => new Response("no", { status: 503 }));
      retry.fn();
      await h.tick();
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(h.stream.getSnapshot().status).toBe("reconnecting");
    expect(isStreamTrustworthy(h.stream.getSnapshot().status)).toBe(false);
  });

  it("a stream that ends after being live goes to reconnecting, then live again resets the backoff", async () => {
    const h = harness();
    h.stream.start();
    await h.tick();
    h.streams[0]!.push("event: ready\ndata: {}\n\n");
    await h.tick();
    h.streams[0]!.end();
    await h.tick();
    expect(h.stream.getSnapshot().status).toBe("reconnecting");
    expect(h.stream.getSnapshot().reconnectAttempt).toBe(1);
    h.pending().at(-1)!.fn();
    await h.tick();
    h.streams[1]!.push("event: ready\ndata: {}\n\n");
    await h.tick();
    expect(h.stream.getSnapshot()).toMatchObject({ status: "live", reconnectAttempt: 0 });
  });

  it("a 401 stops retrying and reports unauthorized (retrying cannot help)", async () => {
    const h = harness({ status: 401 });
    h.stream.start();
    await h.tick();
    expect(h.stream.getSnapshot().status).toBe("unauthorized");
    expect(h.onUnauthorized).toHaveBeenCalledTimes(1);
    expect(h.pending().filter((t) => t.ms >= 1000)).toHaveLength(0);
    expect(isStreamTrustworthy("unauthorized")).toBe(false);
  });

  it("backfills after ready and re-syncs every cached view", async () => {
    const missed = event("work_item.cancelled", { "work_item.id": "wrk_3" });
    const backfill = vi.fn(async () => [missed]);
    const h = harness({ backfill });
    h.stream.start();
    await h.tick();
    h.streams[0]!.push("event: ready\ndata: {}\n\n");
    await h.tick();
    await h.tick();
    expect(backfill).toHaveBeenCalledTimes(1);
    expect(h.stream.getSnapshot().events.map((e) => e.id)).toContain(missed.id);
    expect(h.invalidate).toHaveBeenCalled();
  });

  it("a failed backfill means completeness is unproven: it must not stay 'live'", async () => {
    const h = harness({ backfill: async () => Promise.reject(new Error("boom")) });
    h.stream.start();
    await h.tick();
    h.streams[0]!.push("event: ready\ndata: {}\n\n");
    await h.tick();
    await h.tick();
    expect(h.stream.getSnapshot().status).toBe("reconnecting");
  });

  it("detects a silently dead stream: undelivered old events force a reconnect", async () => {
    const stale = event("work_item.blocked", { "work_item.id": "wrk_4" }, {}, "2020-01-01T00:00:00.000Z");
    const h = harness({ headCheck: async () => [stale] });
    h.stream.start();
    await h.tick();
    h.streams[0]!.push("event: ready\ndata: {}\n\n");
    await h.tick();
    const gap = h.pending().find((t) => t.ms === 45_000);
    expect(gap).toBeDefined();
    gap!.fn();
    await h.tick();
    await h.tick();
    expect(h.stream.getSnapshot().status).toBe("reconnecting");
    expect(h.stream.getSnapshot().lastError).toMatch(/missed events/);
  });

  it("stop() aborts the request and cancels every timer (no leaks after unmount)", async () => {
    const h = harness();
    h.stream.start();
    await h.tick();
    h.streams[0]!.push("event: ready\ndata: {}\n\n" + frame("a.b", event("a.b")));
    await h.tick();
    expect(h.pending().length).toBeGreaterThan(0);
    h.stream.stop();
    expect(h.streams[0]!.signal.aborted).toBe(true);
    expect(h.pending()).toHaveLength(0);
    expect(h.stream.getSnapshot().status).toBe("stopped");
    const calls = h.fetcher.mock.calls.length;
    await h.tick();
    expect(h.fetcher.mock.calls.length).toBe(calls); // no reconnect after stop
  });

  it("start() twice opens one stream", async () => {
    const h = harness();
    h.stream.start();
    h.stream.start();
    await h.tick();
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });
});
