/**
 * Diagnostic timing for edge -> ACS runtime-bootstrap calls (#375).
 *
 * One JSON line per call: operation, correlation id (also sent to ACS as
 * x-acs-request-id), durations, outcome and a non-sensitive error code. Never
 * tokens, challenges, headers or payloads. Observational only.
 */
import crypto from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

export const ACS_CORRELATION_HEADER = 'x-acs-request-id';
const TIMED = new Set(['/dc/runtime/bootstrap', '/dc/runtime/bootstrap/complete']);
const ERROR_CODE = /^[A-Z0-9_]{1,40}$/;
const round = (ms) => Math.round(ms * 10) / 10;

let histogram;
function eventLoopDelay() {
  if (!histogram) {
    histogram = monitorEventLoopDelay({ resolution: 10 });
    histogram.enable();
    return { maxMs: 0, p99Ms: 0 };
  }
  const out = { maxMs: round(histogram.max / 1e6), p99Ms: round(histogram.percentile(99) / 1e6) };
  histogram.reset();
  return out;
}

/** Start the edge event-loop delay monitor so the first record has a baseline. */
export function enableAcsTiming() {
  if (!histogram) eventLoopDelay();
}

/**
 * Returns undefined for untimed routes. Otherwise a tracker: call the mark
 * methods from the request lifecycle and finish() exactly once.
 */
export function startAcsTiming(pathname, sink = (line) => console.log(line)) {
  if (!TIMED.has(pathname)) return undefined;
  const started = performance.now();
  const correlationId = crypto.randomUUID();
  const marks = {};
  let done = false;
  let timedOut = false;
  return {
    correlationId,
    socket() { marks.socketMs = round(performance.now() - started); },
    connect() { marks.connectMs = round(performance.now() - started); },
    response() { marks.firstByteMs = round(performance.now() - started); },
    timeout() { timedOut = true; },
    finish(outcome, { status, error } = {}) {
      if (done) return undefined;
      done = true;
      const delay = eventLoopDelay();
      const code = error && typeof error.code === 'string' && ERROR_CODE.test(error.code) ? error.code : undefined;
      const record = {
        event: 'acs_post_timing',
        operation: pathname,
        correlationId,
        outcome: timedOut ? 'edge_timeout' : outcome,
        ...(typeof status === 'number' ? { status } : {}),
        ...(code ? { errorCode: code } : {}),
        ...marks,
        totalMs: round(performance.now() - started),
        eventLoopDelayMaxMs: delay.maxMs,
        eventLoopDelayP99Ms: delay.p99Ms,
      };
      try { sink(JSON.stringify(record)); } catch { /* diagnostics never affect the call */ }
      return record;
    },
  };
}
