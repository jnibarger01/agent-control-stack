/**
 * Diagnostic timing for the managed-runtime bootstrap routes (#375).
 *
 * Emits only durations, the route, the Fastify request id, the HTTP status and
 * an error code. Never request bodies, headers, tokens, challenges or
 * fingerprints. Observational only: it changes no behavior or timeout.
 */
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

export interface DcRegistryTransactionTiming {
  lockWaitMs: number;
  statementsMs: number;
  commitMs: number;
}

export type DcBootstrapRoute = "/dc/runtime/bootstrap" | "/dc/runtime/bootstrap/complete";
export type DcBootstrapPhase = "auth" | "sqlite";

export interface DcBootstrapTimingFields {
  readonly event: "dc_runtime_bootstrap_timing";
  readonly route: DcBootstrapRoute;
  readonly requestId: string;
  /** Edge-generated x-acs-request-id, when well-formed. */
  readonly correlationId?: string;
  /** Fastify onRequest (receipt) to handler start. */
  readonly receiptToHandlerMs?: number;
  readonly statusCode: number;
  readonly code?: string;
  /** Credential/worker-identity check. */
  readonly authMs: number;
  /** Runtime-registry call: the SQLite BEGIN IMMEDIATE transaction and its statements. */
  readonly sqliteMs: number;
  /** BEGIN IMMEDIATE: write-lock acquisition including busy waits. */
  readonly lockWaitMs?: number;
  readonly statementsMs?: number;
  /** COMMIT: journal/WAL write and fsync. */
  readonly commitMs?: number;
  /** Handler entry to reply. */
  readonly totalMs: number;
  /** Event-loop delay observed since the previous record (ms). */
  readonly eventLoopDelayMaxMs: number;
  readonly eventLoopDelayP99Ms: number;
}

type Sink = (fields: DcBootstrapTimingFields) => void;
const sinks = new Set<Sink>();

/** Test/diagnostic hook: observe emitted timing records in-process. Returns an unsubscribe function. */
export function onDcBootstrapTiming(sink: Sink): () => void {
  sinks.add(sink);
  return () => sinks.delete(sink);
}

const round = (ms: number) => Math.round(ms * 10) / 10;
const SAFE_CODE = /^[a-z0-9_]{1,64}$/u;
const CORRELATION_ID = /^[A-Za-z0-9-]{8,64}$/u;
export const DC_BOOTSTRAP_CORRELATION_HEADER = "x-acs-request-id";

let histogram: ReturnType<typeof monitorEventLoopDelay> | undefined;
function eventLoopDelay(): { maxMs: number; p99Ms: number } {
  if (!histogram) {
    histogram = monitorEventLoopDelay({ resolution: 10 });
    histogram.enable();
    return { maxMs: 0, p99Ms: 0 };
  }
  const result = { maxMs: round(histogram.max / 1e6), p99Ms: round(histogram.percentile(99) / 1e6) };
  histogram.reset();
  return result;
}

/** Start the event-loop delay monitor (idempotent) so the first record has a baseline. */
export function enableDcBootstrapTiming(): void {
  if (!histogram) eventLoopDelay();
}

const receivedAt = new WeakMap<object, number>();
/** Route-level onRequest hook: records request receipt. */
export async function markDcBootstrapReceipt(request: object): Promise<void> {
  receivedAt.set(request, performance.now());
}

export function startDcBootstrapTiming(
  route: DcBootstrapRoute,
  request: { id: string; headers: Record<string, string | string[] | undefined> }
) {
  const started = performance.now();
  const received = receivedAt.get(request);
  const header = request.headers[DC_BOOTSTRAP_CORRELATION_HEADER];
  const correlationId = typeof header === "string" && CORRELATION_ID.test(header) ? header : undefined;
  const requestId = request.id;
  const phases: Record<DcBootstrapPhase, number> = { auth: 0, sqlite: 0 };
  let transaction: DcRegistryTransactionTiming | undefined;
  return {
    transaction(timing: DcRegistryTransactionTiming | undefined): void {
      transaction = timing;
    },
    /** Time `work`; `after` runs even when `work` throws (e.g. to collect registry transaction timing). */
    phase<T>(name: DcBootstrapPhase, work: () => T, after?: () => void): T {
      const at = performance.now();
      try {
        return work();
      } finally {
        phases[name] += performance.now() - at;
        after?.();
      }
    },
    finish(statusCode: number, code?: unknown): DcBootstrapTimingFields {
      const fields: DcBootstrapTimingFields = {
        event: "dc_runtime_bootstrap_timing",
        route,
        requestId: String(requestId).slice(0, 64),
        ...(correlationId ? { correlationId } : {}),
        ...(received !== undefined ? { receiptToHandlerMs: round(started - received) } : {}),
        statusCode,
        ...(typeof code === "string" && SAFE_CODE.test(code) ? { code } : {}),
        authMs: round(phases.auth),
        sqliteMs: round(phases.sqlite),
        ...(transaction
          ? {
              lockWaitMs: round(transaction.lockWaitMs),
              statementsMs: round(transaction.statementsMs),
              commitMs: round(transaction.commitMs)
            }
          : {}),
        totalMs: round(performance.now() - started),
        ...(() => {
          const delay = eventLoopDelay();
          return { eventLoopDelayMaxMs: delay.maxMs, eventLoopDelayP99Ms: delay.p99Ms };
        })()
      };
      for (const sink of sinks) {
        try {
          sink(fields);
        } catch {
          // Diagnostics must never affect the request.
        }
      }
      return fields;
    }
  };
}

type TimingRequest = {
  id: string;
  headers: Record<string, string | string[] | undefined>;
  log: { info(fields: object, message: string): void };
};
const active = new WeakMap<object, ReturnType<typeof startDcBootstrapTiming>>();

/** Begin timing a bootstrap handler; the route's onResponse hook emits the record. */
export function beginDcBootstrapTiming(route: DcBootstrapRoute, request: TimingRequest) {
  const timing = startDcBootstrapTiming(route, request);
  active.set(request, timing);
  return timing;
}

/** Route-level onResponse hook: emits one structured record per bootstrap request. */
export async function emitDcBootstrapTiming(request: TimingRequest, reply: { statusCode: number }): Promise<void> {
  const timing = active.get(request);
  if (!timing) return;
  active.delete(request);
  request.log.info(timing.finish(reply.statusCode), "dc runtime bootstrap timing");
}
