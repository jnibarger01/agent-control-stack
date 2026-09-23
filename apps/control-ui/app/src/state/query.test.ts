import { describe, expect, it, vi } from "vitest";
import { AcsApiError } from "../api/errors";
import { QueryCache } from "./query";

const noSleep = () => Promise.resolve();
const make = () => new QueryCache({ sleep: noSleep });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("QueryCache", () => {
  it("de-duplicates concurrent fetches for one key into a single request", async () => {
    const cache = make();
    const fetcher = vi.fn(async () => "value");
    await Promise.all([cache.fetch("k", fetcher), cache.fetch("k", fetcher), cache.fetch("k", fetcher)]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cache.getState<string>("k").data).toBe("value");
  });

  it("keeps entries isolated per key so one record's data never renders under another", async () => {
    const cache = make();
    await cache.fetch("work-item:a", async () => "A");
    await cache.fetch("work-item:b", async () => "B");
    expect(cache.getState("work-item:a").data).toBe("A");
    expect(cache.getState("work-item:b").data).toBe("B");
    expect(cache.getState("work-item:c").data).toBeUndefined();
  });

  it("aborts the request when the last subscriber leaves", async () => {
    const cache = make();
    let signal!: AbortSignal;
    const gate = deferred<string>();
    const unsubscribe = cache.subscribe("k", () => undefined);
    void cache.fetch("k", (s) => {
      signal = s;
      return gate.promise;
    });
    expect(signal.aborted).toBe(false);
    unsubscribe();
    expect(signal.aborted).toBe(true);
  });

  it("REGRESSION: a remount after unsubscribe starts a fresh request instead of joining the aborted one", async () => {
    const cache = make();
    const first = deferred<string>();
    const unsubscribe = cache.subscribe("work-item:x", () => undefined);
    const firstFetch = vi.fn((signal: AbortSignal) => {
      signal.addEventListener("abort", () => first.reject(new DOMException("aborted", "AbortError")));
      return first.promise;
    });
    void cache.fetch("work-item:x", firstFetch);
    unsubscribe(); // navigation away aborts it…
    cache.subscribe("work-item:x", () => undefined); // …and immediately back
    const secondFetch = vi.fn(async () => "fresh");
    await cache.fetch("work-item:x", secondFetch);
    expect(secondFetch).toHaveBeenCalledTimes(1);
    expect(cache.getState("work-item:x")).toMatchObject({ data: "fresh", hasData: true, isFetching: false });
  });

  it("retries transient failures a bounded number of times, then reports the error", async () => {
    const cache = make();
    const fetcher = vi.fn(async () => {
      throw new AcsApiError("network", "down");
    });
    await cache.fetch("k", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(3); // 1 attempt + 2 retries
    expect(cache.getState("k").error).toBeInstanceOf(AcsApiError);
  });

  it("does not retry authorization or conflict failures", async () => {
    for (const kind of ["unauthorized", "forbidden", "conflict", "invalid", "not_found"] as const) {
      const cache = make();
      const fetcher = vi.fn(async () => {
        throw new AcsApiError(kind, "no");
      });
      await cache.fetch("k", fetcher);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect((cache.getState("k").error as AcsApiError).kind).toBe(kind);
    }
  });

  it("recovers on a retry and clears the error", async () => {
    const cache = make();
    let calls = 0;
    await cache.fetch("k", async () => {
      calls += 1;
      if (calls < 2) throw new AcsApiError("server", "500");
      return "ok";
    });
    expect(cache.getState("k")).toMatchObject({ data: "ok", error: undefined });
  });

  it("invalidate marks stale and refetches views that are on screen", async () => {
    const cache = make();
    let n = 0;
    const fetcher = vi.fn(async () => ++n);
    cache.subscribe("work-items", () => undefined);
    await cache.fetch("work-items", fetcher);
    cache.invalidate("work-items");
    await vi.waitFor(() => expect(cache.getState("work-items").data).toBe(2));
    expect(cache.getState("work-items").isStale).toBe(false);
  });

  it("invalidate by prefix matches namespaced keys only", async () => {
    const cache = make();
    await cache.fetch("executions:a", async () => 1);
    await cache.fetch("work-items", async () => 1);
    cache.invalidate("executions");
    expect(cache.getState("executions:a").isStale).toBe(true);
    expect(cache.getState("work-items").isStale).toBe(false);
  });

  it("markAllStale flags data without refetching (event stream lost)", async () => {
    const cache = make();
    const fetcher = vi.fn(async () => 1);
    await cache.fetch("a", fetcher);
    cache.markAllStale();
    expect(cache.getState("a").isStale).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("a superseded (aborted) request can never overwrite newer data", async () => {
    const cache = make();
    cache.subscribe("k", () => undefined);
    const calls: Array<ReturnType<typeof deferred<string>>> = [];
    const fetcher = () => {
      const d = deferred<string>();
      calls.push(d);
      return d.promise;
    };
    const first = cache.fetch("k", fetcher);
    cache.invalidate("k"); // supersedes the first request with a fresh one
    expect(calls).toHaveLength(2);
    calls[1]!.resolve("new");
    await vi.waitFor(() => expect(cache.getState("k").data).toBe("new"));
    calls[0]!.resolve("old"); // the superseded request finishes late
    await first;
    expect(cache.getState("k").data).toBe("new");
  });

  it("clear() cancels in-flight work", async () => {
    const cache = make();
    let signal!: AbortSignal;
    void cache.fetch("k", (s) => {
      signal = s;
      return new Promise(() => undefined);
    });
    cache.clear();
    expect(signal.aborted).toBe(true);
  });
});
