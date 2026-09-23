import { useSyncExternalStore } from "react";
import { isAcsApiError } from "../api/errors";
import type { StoredAuditEvent } from "../api/types";
import { QueryCache, queryCache } from "./query";
import { invalidationsFor } from "./reconcile";
import { SseParser } from "./sse-parse";

export type StreamStatus =
  | "connecting" // first connection attempt in progress
  | "live" // `ready` received and no gap detected
  | "reconnecting" // lost; waiting for backoff / retrying
  | "unauthorized" // gateway refused the session; retrying cannot help
  | "stopped";

export interface StreamSnapshot {
  status: StreamStatus;
  /** Last time any frame (event or ready) arrived. */
  lastFrameAt: number | undefined;
  reconnectAttempt: number;
  nextRetryAt: number | undefined;
  /** Bounded, oldest-first window of events seen by this tab. */
  events: readonly StoredAuditEvent[];
  totalReceived: number;
  /** Arrival timestamps of the last minute, for a real events/sec figure. */
  connectedSince: number | undefined;
  lastError: string | undefined;
}

/** 1s, 2s, 4s, 8s, 16s, then a 30s cap. Mirrors nextSseReconnectDelayMs in the legacy dashboard. */
export function nextReconnectDelayMs(attempt: number): number {
  const n = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  return Math.min(30_000, 1_000 * 2 ** Math.min(n, 5));
}

/** Data shown while this is false may be stale: sensitive mutation controls must fail closed. */
export function isStreamTrustworthy(status: StreamStatus): boolean {
  return status === "live";
}

export const MAX_BUFFERED_EVENTS = 500;
const INVALIDATION_FLUSH_MS = 250;
const GAP_CHECK_MS = 45_000;
const GAP_GRACE_MS = 5_000;

export interface EventStreamDeps {
  fetcher?: typeof fetch;
  cache?: QueryCache;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Newest events, used to backfill after (re)connecting so a gap can never go unnoticed. */
  backfill?: (signal: AbortSignal) => Promise<StoredAuditEvent[]>;
  /** Cheap check for events newer than the last one received. */
  headCheck?: (afterSequence: number, signal: AbortSignal) => Promise<StoredAuditEvent[]>;
  onUnauthorized?: () => void;
  url?: string;
}

/**
 * Authoritative live channel. The stream is the only source of "live" claims:
 * anything other than `live` marks cached data stale, which the UI turns into
 * a visible banner and disabled approve/reject/unblock controls.
 */
export class EventStream {
  private snapshot: StreamSnapshot = {
    status: "stopped",
    lastFrameAt: undefined,
    reconnectAttempt: 0,
    nextRetryAt: undefined,
    events: [],
    totalReceived: 0,
    connectedSince: undefined,
    lastError: undefined
  };
  private readonly listeners = new Set<() => void>();
  private controller: AbortController | undefined;
  private retryTimer: unknown;
  private flushTimer: unknown;
  private gapTimer: unknown;
  private pendingKeys = new Set<string>();
  private lastSequence = 0;
  private readonly seenIds = new Set<string>();
  private readonly fetcher: typeof fetch;
  private readonly cache: QueryCache;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly deps: EventStreamDeps;
  private started = false;

  constructor(deps: EventStreamDeps = {}) {
    this.deps = deps;
    this.fetcher = deps.fetcher ?? ((...args) => globalThis.fetch(...args));
    this.cache = deps.cache ?? queryCache;
    this.now = deps.now ?? (() => Date.now());
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  getSnapshot = (): StreamSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(patch: Partial<StreamSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.update({ status: "connecting" });
    void this.connect();
  }

  /** Full teardown: aborts the request and cancels every timer so nothing leaks after unmount. */
  stop(): void {
    this.started = false;
    this.controller?.abort();
    this.controller = undefined;
    for (const handle of [this.retryTimer, this.flushTimer, this.gapTimer]) {
      if (handle !== undefined) this.clearTimer(handle);
    }
    this.retryTimer = this.flushTimer = this.gapTimer = undefined;
    this.pendingKeys.clear();
    this.update({ status: "stopped", nextRetryAt: undefined });
  }

  /** Operator-initiated retry (also used when the tab regains network). */
  reconnectNow(): void {
    if (!this.started) return;
    if (this.retryTimer !== undefined) this.clearTimer(this.retryTimer);
    this.retryTimer = undefined;
    this.controller?.abort();
    this.update({ status: "connecting", nextRetryAt: undefined });
    void this.connect();
  }

  private async connect(): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    try {
      const response = await this.fetcher(this.deps.url ?? "/events", {
        headers: { accept: "text/event-stream" },
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal
      });
      if (response.status === 401 || response.status === 403) {
        this.loseConnection("unauthorized", `HTTP ${response.status}`);
        this.deps.onUnauthorized?.();
        return;
      }
      if (!response.ok || !response.body) {
        this.loseConnection("reconnecting", `HTTP ${response.status}`);
        return;
      }
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      const parser = new SseParser();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const frame of parser.push(value)) this.handleFrame(frame);
      }
      if (!controller.signal.aborted) this.loseConnection("reconnecting", "stream closed by gateway");
    } catch (error) {
      if (controller.signal.aborted) return;
      this.loseConnection("reconnecting", error instanceof Error ? error.message : "stream error");
    }
  }

  private loseConnection(status: "reconnecting" | "unauthorized", reason: string): void {
    if (!this.started) return;
    if (this.gapTimer !== undefined) this.clearTimer(this.gapTimer);
    this.gapTimer = undefined;
    // Anything cached may have drifted while we were blind.
    this.cache.markAllStale();
    if (status === "unauthorized") {
      this.update({ status, lastError: reason, connectedSince: undefined, nextRetryAt: undefined });
      return;
    }
    const attempt = this.snapshot.reconnectAttempt;
    const delay = nextReconnectDelayMs(attempt);
    this.update({
      status: "reconnecting",
      lastError: reason,
      connectedSince: undefined,
      reconnectAttempt: attempt + 1,
      nextRetryAt: this.now() + delay
    });
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = undefined;
      if (!this.started) return;
      void this.connect();
    }, delay);
  }

  private handleFrame(frame: { event: string; data: string }): void {
    const at = this.now();
    if (frame.event === "ready") {
      this.update({
        status: "live",
        lastFrameAt: at,
        reconnectAttempt: 0,
        nextRetryAt: undefined,
        connectedSince: at,
        lastError: undefined
      });
      void this.resync();
      this.scheduleGapCheck();
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame.data);
    } catch {
      return; // A malformed frame is dropped, never rendered.
    }
    if (!isAuditEvent(parsed)) return;
    this.ingest([parsed], at);
  }

  private ingest(events: StoredAuditEvent[], at: number): void {
    const fresh = events.filter((event) => !this.seenIds.has(event.id));
    if (fresh.length === 0) {
      this.update({ lastFrameAt: at });
      return;
    }
    for (const event of fresh) {
      this.seenIds.add(event.id);
      if (typeof event.sequence === "number" && event.sequence > this.lastSequence) this.lastSequence = event.sequence;
      for (const key of invalidationsFor(event)) this.pendingKeys.add(key);
    }
    const merged = [...this.snapshot.events, ...fresh]
      .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
      .slice(-MAX_BUFFERED_EVENTS);
    if (this.seenIds.size > MAX_BUFFERED_EVENTS * 4) {
      const keep = new Set(merged.map((event) => event.id));
      for (const id of this.seenIds) if (!keep.has(id)) this.seenIds.delete(id);
    }
    this.update({ events: merged, totalReceived: this.snapshot.totalReceived + fresh.length, lastFrameAt: at });
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) return;
    this.flushTimer = this.setTimer(() => {
      this.flushTimer = undefined;
      const keys = [...this.pendingKeys];
      this.pendingKeys.clear();
      for (const key of keys) this.cache.invalidate(key);
    }, INVALIDATION_FLUSH_MS);
  }

  /** After (re)connect, pull the newest window so events emitted while disconnected are not lost. */
  private async resync(): Promise<void> {
    const backfill = this.deps.backfill;
    if (!backfill) return;
    const controller = this.controller;
    try {
      const events = await backfill(controller?.signal ?? new AbortController().signal);
      if (!this.started) return;
      this.ingest(events, this.now());
      // The initial load may itself have been served from a stale cache.
      this.cache.invalidate(() => true);
    } catch (error) {
      if (isAcsApiError(error) && error.kind === "aborted") return;
      // Backfill failure means we cannot prove completeness: do not claim live.
      if (this.snapshot.status === "live") this.loseConnection("reconnecting", "backfill failed");
      this.controller?.abort();
    }
  }

  /**
   * The gateway sends no keepalive frames, so a half-open TCP connection would
   * otherwise look "live" forever. Periodically ask for events newer than the
   * last one delivered; if some exist that the stream failed to deliver, the
   * stream is not trustworthy and is torn down and re-established.
   */
  private scheduleGapCheck(): void {
    if (!this.deps.headCheck) return;
    if (this.gapTimer !== undefined) this.clearTimer(this.gapTimer);
    this.gapTimer = this.setTimer(async () => {
      this.gapTimer = undefined;
      if (!this.started || this.snapshot.status !== "live") return;
      try {
        const missed = await this.deps.headCheck!(
          this.lastSequence,
          this.controller?.signal ?? new AbortController().signal
        );
        const now = this.now();
        const undelivered = missed.filter((event) => !this.seenIds.has(event.id));
        const old = undelivered.filter((event) => now - Number(BigInt(event.timeUnixNano) / 1_000_000n) > GAP_GRACE_MS);
        if (old.length > 0) {
          this.controller?.abort();
          this.loseConnection("reconnecting", "event stream missed events");
          return;
        }
      } catch (error) {
        if (!(isAcsApiError(error) && error.kind === "aborted") && this.snapshot.status === "live") {
          this.controller?.abort();
          this.loseConnection("reconnecting", "event stream health check failed");
          return;
        }
      }
      this.scheduleGapCheck();
    }, GAP_CHECK_MS);
  }
}

function isAuditEvent(value: unknown): value is StoredAuditEvent {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    typeof record.timeUnixNano === "string" &&
    /^\d+$/u.test(record.timeUnixNano)
  );
}

export function useEventStream(stream: EventStream): StreamSnapshot {
  return useSyncExternalStore(stream.subscribe, stream.getSnapshot, stream.getSnapshot);
}
