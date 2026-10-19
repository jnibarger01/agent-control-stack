import { useEffect, useRef, useState } from "react";

/** Same schedule as the legacy console: 1s, 2s, 4s, 8s, 16s, then 30s cap. */
export function nextReconnectDelayMs(attempt: number): number {
  const n = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  return Math.min(30_000, 1_000 * 2 ** Math.min(n, 5));
}

/**
 * Audit events the overview depends on. The gateway emits each as a *named* SSE
 * event, so a listener must be registered per name (same mechanism as the legacy console).
 */
export const STREAM_EVENT_NAMES = [
  "work_item.created", "work_item.pending_policy", "work_item.needs_approval", "work_item.approved",
  "work_item.running", "work_item.blocked", "work_item.failed", "work_item.succeeded", "work_item.cancelled",
  "work_item.rejected", "work_item.cancelling", "work_item.unknown", "work_item.quarantined",
  "work_item.retried", "work_item.cloned",
  "agent.created", "agent.updated", "agent.heartbeat", "agent.capabilities_replaced",
  "connector.registered", "connector.key_rotated",
  "tunnel_session.registered", "tunnel_session.revoked", "tunnel_session.reconciled", "tunnel_session.heartbeat",
  "execution_attempt.created", "execution_attempt.transitioned", "execution_attempt.result_accepted",
  "attempt_lease.issued", "attempt_lease.renewed", "attempt_lease.stolen", "attempt_lease.expired",
  "execution_mode.changed", "approval.granted", "policy.decided",
  "agent_run.requested", "agent_run.started", "agent_run.finished", "agent_run.cancel_requested", "agent_run.interrupted"
] as const;

export type StreamState = "connecting" | "live" | "stale";

export interface EventSourceLike {
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  close(): void;
}
export type EventSourceFactory = (url: string) => EventSourceLike;

const defaultFactory: EventSourceFactory = (url) => new EventSource(url) as unknown as EventSourceLike;

/**
 * Subscribes to the existing GET /events stream. `onEvent` fires for every named
 * audit event; `onReconnect` fires when the stream recovers after a loss so the
 * caller can catch up on anything missed. The server's per-principal connection
 * cap is respected: a 503 surfaces as an error, which is reported as `stale`.
 */
export function useEventStream(
  onEvent: (name: string) => void,
  onReconnect: () => void,
  factory: EventSourceFactory = defaultFactory
): StreamState {
  const [state, setState] = useState<StreamState>("connecting");
  const handlers = useRef({ onEvent, onReconnect });
  handlers.current = { onEvent, onReconnect };
  // The factory is read once: an unstable function identity must never tear the stream down.
  const factoryRef = useRef(factory);

  useEffect(() => {
    let source: EventSourceLike | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let everOpened = false;
    let connected = false;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      source?.close();
      const next = factoryRef.current("/events");
      source = next;
      next.addEventListener("open", () => {
        const reconnected = everOpened && !connected;
        attempt = 0;
        everOpened = true;
        connected = true;
        setState("live");
        if (reconnected) handlers.current.onReconnect();
      });
      next.addEventListener("error", () => {
        next.close();
        if (source === next) source = null;
        connected = false;
        setState("stale");
        if (disposed || timer) return;
        const delay = nextReconnectDelayMs(attempt);
        attempt += 1;
        timer = setTimeout(() => {
          timer = null;
          connect();
        }, delay);
      });
      for (const name of STREAM_EVENT_NAMES) next.addEventListener(name, () => handlers.current.onEvent(name));
    };
    connect();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      source?.close();
    };
  }, []);

  return state;
}
