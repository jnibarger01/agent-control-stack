import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { isAcsApiError } from "../api/errors";

export type Fetcher<T> = (signal: AbortSignal) => Promise<T>;

export interface QueryState<T> {
  data: T | undefined;
  error: unknown;
  /** True once any fetch for this key has settled successfully. */
  hasData: boolean;
  isFetching: boolean;
  updatedAt: number | undefined;
  /** Set by invalidation / disconnected event stream: data is shown but must not be trusted for mutations. */
  isStale: boolean;
}

interface Entry<T> {
  state: QueryState<T>;
  fetcher: Fetcher<T> | undefined;
  controller: AbortController | undefined;
  inflight: Promise<void> | undefined;
  listeners: Set<() => void>;
  generation: number;
}

const EMPTY: QueryState<never> = Object.freeze({
  data: undefined,
  error: undefined,
  hasData: false,
  isFetching: false,
  updatedAt: undefined,
  isStale: false
});

const MAX_RETRIES = 2;
const MAX_ENTRIES = 200;

export interface QueryCacheOptions {
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

/**
 * Small request cache: in-flight de-duplication per key, cancellation when the
 * last subscriber leaves, bounded retry for transient failures only, and
 * explicit invalidation used by both mutations and live-event reconciliation.
 * Data is keyed, so a detail view can never render another record's state.
 */
export class QueryCache {
  private readonly entries = new Map<string, Entry<unknown>>();
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(options: QueryCacheOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
  }

  private evict(): void {
    if (this.entries.size <= MAX_ENTRIES) return;
    // Drop unobserved entries, oldest first; entries with subscribers are never evicted.
    const idle = [...this.entries.entries()]
      .filter(([, e]) => e.listeners.size === 0 && !e.inflight)
      .sort(([, a], [, b]) => (a.state.updatedAt ?? 0) - (b.state.updatedAt ?? 0));
    for (const [key] of idle) {
      if (this.entries.size <= MAX_ENTRIES) break;
      this.entries.delete(key);
    }
  }

  private entry<T>(key: string): Entry<T> {
    let entry = this.entries.get(key) as Entry<T> | undefined;
    if (!entry) {
      this.evict();
      entry = {
        state: EMPTY as QueryState<T>,
        fetcher: undefined,
        controller: undefined,
        inflight: undefined,
        listeners: new Set(),
        generation: 0
      };
      this.entries.set(key, entry as Entry<unknown>);
    }
    return entry;
  }

  getState<T>(key: string): QueryState<T> {
    return (this.entries.get(key) as Entry<T> | undefined)?.state ?? (EMPTY as QueryState<T>);
  }

  subscribe(key: string, listener: () => void): () => void {
    const entry = this.entry(key);
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
      // Nobody is looking: stop work instead of racing into an unmounted view.
      if (entry.listeners.size === 0) this.cancel(entry);
    };
  }

  /**
   * Abort and forget the in-flight request. The generation bump makes the
   * aborted run's late writes no-ops, and clearing `inflight` guarantees the
   * next subscriber starts a fresh request rather than joining a dead one.
   */
  private cancel<T>(entry: Entry<T>): void {
    entry.controller?.abort();
    entry.controller = undefined;
    entry.inflight = undefined;
    entry.generation += 1;
    if (entry.state.isFetching) entry.state = { ...entry.state, isFetching: false };
  }

  private set<T>(entry: Entry<T>, patch: Partial<QueryState<T>>): void {
    entry.state = { ...entry.state, ...patch };
    for (const listener of [...entry.listeners]) listener();
  }

  /** Start (or join) a fetch. Concurrent callers for one key share one request. */
  fetch<T>(key: string, fetcher: Fetcher<T>, options: { force?: boolean; staleMs?: number } = {}): Promise<void> {
    const entry = this.entry<T>(key);
    entry.fetcher = fetcher;
    if (entry.inflight && !entry.controller?.signal.aborted) return entry.inflight;
    const fresh =
      entry.state.hasData &&
      !entry.state.isStale &&
      entry.state.updatedAt !== undefined &&
      this.now() - entry.state.updatedAt < (options.staleMs ?? 0);
    if (fresh && !options.force) return Promise.resolve();

    const controller = new AbortController();
    entry.controller = controller;
    const generation = ++entry.generation;
    this.set(entry, { isFetching: true });
    entry.inflight = this.run(entry, fetcher, controller, generation).finally(() => {
      if (entry.generation === generation) {
        entry.inflight = undefined;
        entry.controller = undefined;
      }
    });
    return entry.inflight;
  }

  private async run<T>(entry: Entry<T>, fetcher: Fetcher<T>, controller: AbortController, generation: number) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const data = await fetcher(controller.signal);
        if (entry.generation !== generation) return;
        this.set(entry, {
          data,
          error: undefined,
          hasData: true,
          isFetching: false,
          updatedAt: this.now(),
          isStale: false
        });
        return;
      } catch (error) {
        if (controller.signal.aborted || (isAcsApiError(error) && error.kind === "aborted")) {
          if (entry.generation === generation) this.set(entry, { isFetching: false });
          return;
        }
        const retryable = isAcsApiError(error) && error.retryable && attempt < MAX_RETRIES;
        if (retryable) {
          try {
            await this.sleep(500 * 2 ** attempt, controller.signal);
            continue;
          } catch {
            if (entry.generation === generation) this.set(entry, { isFetching: false });
            return;
          }
        }
        if (entry.generation === generation) this.set(entry, { error, isFetching: false });
        return;
      }
    }
  }

  /** Mark matching entries stale and refetch the ones currently on screen. */
  invalidate(match: string | ((key: string) => boolean)): void {
    const predicate = typeof match === "string" ? (key: string) => key === match || key.startsWith(`${match}:`) : match;
    for (const [key, entry] of this.entries) {
      if (!predicate(key)) continue;
      this.set(entry, { isStale: entry.state.hasData });
      if (entry.listeners.size > 0 && entry.fetcher) {
        this.cancel(entry);
        void this.fetch(key, entry.fetcher as Fetcher<unknown>, { force: true });
      }
    }
  }

  /** Flag everything stale without refetching (event stream lost: data may have drifted). */
  markAllStale(): void {
    for (const entry of this.entries.values()) {
      if (entry.state.hasData && !entry.state.isStale) this.set(entry, { isStale: true });
    }
  }

  clear(): void {
    for (const entry of this.entries.values()) this.cancel(entry);
    this.entries.clear();
  }
}

export const queryCache = new QueryCache();

export interface UseQueryOptions {
  enabled?: boolean;
  staleMs?: number;
  cache?: QueryCache;
}

export interface UseQueryResult<T> extends QueryState<T> {
  refetch: () => void;
}

export function useQuery<T>(key: string | null, fetcher: Fetcher<T>, options: UseQueryOptions = {}): UseQueryResult<T> {
  const cache = options.cache ?? queryCache;
  const enabled = options.enabled !== false && key !== null;
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const stableFetcher = useCallback<Fetcher<T>>((signal) => fetcherRef.current(signal), []);

  const activeKey = enabled ? key : null;
  const subscribe = useCallback(
    (listener: () => void) => (activeKey === null ? () => undefined : cache.subscribe(activeKey, listener)),
    [cache, activeKey]
  );
  const getSnapshot = useCallback(
    () => (activeKey === null ? (EMPTY as QueryState<T>) : cache.getState<T>(activeKey)),
    [cache, activeKey]
  );
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const staleMs = options.staleMs;
  useEffect(() => {
    if (activeKey === null) return;
    void cache.fetch(activeKey, stableFetcher, staleMs === undefined ? {} : { staleMs });
  }, [cache, activeKey, stableFetcher, staleMs]);

  const refetch = useCallback(() => {
    if (activeKey !== null) void cache.fetch(activeKey, stableFetcher, { force: true });
  }, [cache, activeKey, stableFetcher]);

  return { ...state, refetch };
}
