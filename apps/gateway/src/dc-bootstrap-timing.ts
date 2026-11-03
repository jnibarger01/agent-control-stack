/**
 * Diagnostic timing for the managed-runtime bootstrap routes (#375).
 *
 * `registerDcBootstrapTiming(app)` adds app-level hooks that time
 * /dc/runtime/bootstrap and /dc/runtime/bootstrap/complete and emit ONE
 * structured record per request via the request logger (and in-process sinks):
 * receipt->handler gap, handler time before the registry call (credential check
 * plus body validation), the runtime-registry SQLite phases (write-lock wait
 * for BEGIN IMMEDIATE, statements, COMMIT), total, and event-loop delay.
 *
 * Only durations, route, Fastify request id, edge correlation id, HTTP status
 * and transaction outcome are recorded. Never headers, tokens, challenges,
 * fingerprints or payloads. Observational only: no behavior or timeout change.
 *
 * It is registered by the E2E harness. Wiring it into buildGateway is
 * deliberately left out of this change (apps/gateway/src/server.ts overlaps an
 * open PR); it is a one-line follow-up.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import {
  onRuntimeRegistryTransaction,
  type RegistryTransactionTiming
} from "@agent-control-stack/desktop-commander-adapter";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export type DcBootstrapRoute = "/dc/runtime/bootstrap" | "/dc/runtime/bootstrap/complete";
export const DC_BOOTSTRAP_CORRELATION_HEADER = "x-acs-request-id";

export interface DcBootstrapTimingFields {
  readonly event: "dc_runtime_bootstrap_timing";
  readonly route: DcBootstrapRoute;
  readonly requestId: string;
  /** Edge-generated x-acs-request-id, when well-formed. */
  readonly correlationId?: string;
  readonly statusCode: number;
  /** onRequest (receipt) to preHandler (handler start). */
  readonly receiptToHandlerMs: number;
  /** Handler start to the registry transaction: credential check and body validation. */
  readonly preRegistryMs?: number;
  readonly transactionOutcome?: RegistryTransactionTiming["outcome"];
  /** BEGIN IMMEDIATE: SQLite write-lock acquisition including busy_timeout waits. */
  readonly lockWaitMs?: number;
  readonly statementsMs?: number;
  /** COMMIT: journal/WAL write and fsync. */
  readonly commitMs?: number;
  /** Receipt to response sent. */
  readonly totalMs: number;
  /** ACS event-loop delay since the previous record. */
  readonly eventLoopDelayMaxMs: number;
  readonly eventLoopDelayP99Ms: number;
}

const ROUTES = new Set<string>(["/dc/runtime/bootstrap", "/dc/runtime/bootstrap/complete"]);
const CORRELATION_ID = /^[A-Za-z0-9-]{8,64}$/u;
const round = (ms: number) => Math.round(ms * 10) / 10;

type Sink = (fields: DcBootstrapTimingFields) => void;
const sinks = new Set<Sink>();
/** Observe emitted records in-process (E2E log surfacing, tests). Returns an unsubscribe function. */
export function onDcBootstrapTiming(sink: Sink): () => void {
  sinks.add(sink);
  return () => sinks.delete(sink);
}

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

interface Pending {
  route: DcBootstrapRoute;
  correlationId?: string;
  receivedAt: number;
  handlerAt?: number;
  transactionAt?: number;
  transaction?: RegistryTransactionTiming;
}
const context = new AsyncLocalStorage<Pending>();
const pending = new WeakMap<FastifyRequest, Pending>();
let registryListener: (() => void) | undefined;

function routeOf(url: string): DcBootstrapRoute | undefined {
  const path = url.split("?", 1)[0]!;
  return ROUTES.has(path) ? (path as DcBootstrapRoute) : undefined;
}

export function registerDcBootstrapTiming(app: FastifyInstance): void {
  eventLoopDelay();
  if (!registryListener) {
    // The registry is synchronous and runs inside the handler's async context.
    registryListener = onRuntimeRegistryTransaction((timing) => {
      const current = context.getStore();
      if (!current || current.transaction) return;
      current.transaction = { ...timing };
      current.transactionAt = performance.now() - timing.lockWaitMs - timing.statementsMs - timing.commitMs;
    });
  }
  app.addHook("onRequest", async (request: FastifyRequest) => {
    const route = routeOf(request.url);
    if (!route) return;
    const header = request.headers[DC_BOOTSTRAP_CORRELATION_HEADER];
    const entry: Pending = {
      route,
      receivedAt: performance.now(),
      ...(typeof header === "string" && CORRELATION_ID.test(header) ? { correlationId: header } : {})
    };
    pending.set(request, entry);
    context.enterWith(entry);
  });
  app.addHook("preHandler", async (request: FastifyRequest) => {
    const entry = pending.get(request);
    if (!entry) return;
    entry.handlerAt = performance.now();
    context.enterWith(entry);
  });
  app.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply) => {
    const entry = pending.get(request);
    if (!entry) return;
    pending.delete(request);
    const now = performance.now();
    const delay = eventLoopDelay();
    const handlerAt = entry.handlerAt ?? now;
    const tx = entry.transaction;
    const fields: DcBootstrapTimingFields = {
      event: "dc_runtime_bootstrap_timing",
      route: entry.route,
      requestId: String(request.id).slice(0, 64),
      ...(entry.correlationId ? { correlationId: entry.correlationId } : {}),
      statusCode: reply.statusCode,
      receiptToHandlerMs: round(handlerAt - entry.receivedAt),
      ...(tx && entry.transactionAt !== undefined
        ? {
            preRegistryMs: round(Math.max(0, entry.transactionAt - handlerAt)),
            transactionOutcome: tx.outcome,
            lockWaitMs: round(tx.lockWaitMs),
            statementsMs: round(tx.statementsMs),
            commitMs: round(tx.commitMs)
          }
        : {}),
      totalMs: round(now - entry.receivedAt),
      eventLoopDelayMaxMs: delay.maxMs,
      eventLoopDelayP99Ms: delay.p99Ms
    };
    request.log.info(fields, "dc runtime bootstrap timing");
    for (const sink of sinks) {
      try {
        sink(fields);
      } catch {
        // Diagnostics must never affect the request.
      }
    }
  });
}
