import { WebMcpError, WebMcpErrorCode } from "./contracts.js";
import type { CdpSession } from "./cdp.js";

/**
 * Minimal CDP client over the platform `WebSocket` (Node >= 24, no dependency).
 *
 * It is deliberately dumb: request/response correlation plus event fan-out.
 * All protocol semantics — fixed declarations, JSON-value discipline, stale
 * navigation handling — live in `cdp.ts`, not here.
 */

export interface CdpConnection extends CdpSession {
  close(): void;
  readonly url: string;
}

export interface ConnectCdpOptions {
  /** Per-request timeout. Defaults to 30s. */
  requestTimeoutMs?: number;
  /** Injected WebSocket constructor (test seam). */
  webSocketFactory?: (url: string) => WebSocketLike;
}

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener?(type: string, listener: (event: unknown) => void): void;
}

const OPEN = 1;

function messageText(event: unknown): string | undefined {
  if (typeof event === "string") return event;
  if (typeof event === "object" && event !== null) {
    const data = (event as { data?: unknown }).data;
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  }
  return undefined;
}

export async function connectCdp(
  websocketUrl: string,
  options: ConnectCdpOptions = {}
): Promise<CdpConnection> {
  const factory =
    options.webSocketFactory ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
  const socket = factory(websocketUrl);
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;

  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const listeners = new Map<string, Set<(params: unknown) => void>>();
  let nextId = 1;
  let closed = false;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new WebMcpError(WebMcpErrorCode.CdpFailure, "CDP connect timed out")), 10_000);
    const onOpen = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const onError = (): void => {
      clearTimeout(timer);
      reject(new WebMcpError(WebMcpErrorCode.CdpFailure, "CDP connection failed"));
    };
    if (socket.readyState === OPEN) {
      clearTimeout(timer);
      resolve();
      return;
    }
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
  });

  socket.addEventListener("message", (event) => {
    const text = messageText(event);
    if (text === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const record = parsed as { id?: unknown; method?: unknown; params?: unknown };
    if (typeof record.id === "number" && pending.has(record.id)) {
      const entry = pending.get(record.id)!;
      pending.delete(record.id);
      clearTimeout(entry.timer);
      entry.resolve(parsed);
      return;
    }
    if (typeof record.method === "string") {
      for (const handler of listeners.get(record.method) ?? []) handler(record.params);
    }
  });

  socket.addEventListener("close", () => {
    closed = true;
    for (const [id, entry] of pending) {
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new WebMcpError(WebMcpErrorCode.CdpFailure, "CDP connection closed"));
    }
  });

  return {
    url: websocketUrl,
    send(method, params, signal) {
      if (closed) {
        return Promise.reject(new WebMcpError(WebMcpErrorCode.CdpFailure, "CDP connection is closed"));
      }
      if (signal?.aborted) {
        return Promise.reject(new WebMcpError(WebMcpErrorCode.Cancelled, "call was cancelled"));
      }
      return new Promise<unknown>((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new WebMcpError(WebMcpErrorCode.CdpFailure, `CDP ${method} timed out`));
        }, requestTimeoutMs);
        pending.set(id, { resolve, reject, timer });
        const onAbort = (): void => {
          pending.delete(id);
          clearTimeout(timer);
          reject(new WebMcpError(WebMcpErrorCode.Cancelled, "call was cancelled"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        socket.send(JSON.stringify(params === undefined ? { id, method } : { id, method, params }));
      });
    },
    subscribe(event, handler) {
      const set = listeners.get(event) ?? new Set();
      set.add(handler);
      listeners.set(event, set);
      return () => {
        set.delete(handler);
      };
    },
    close() {
      closed = true;
      for (const [, entry] of pending) clearTimeout(entry.timer);
      pending.clear();
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    }
  };
}
