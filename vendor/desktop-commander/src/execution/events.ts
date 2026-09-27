import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { redactValue } from './secret-scan.js';

/**
 * Structured execution evidence (dc.execution-event.v1).
 *
 * Desktop Commander EMITS evidence; ACS / LoopTrace remain the authoritative
 * audit and session layer. Events never carry raw credentials, tokens,
 * private keys, or full file contents: every event passes through
 * redactValue() before reaching any sink, and producers only put hashes,
 * sizes, codes and bounded metadata into it.
 *
 * Sink failures never change a tool's result or authorization: sinks are
 * evidence transport, not a gate (the same contract as the audit chain's
 * best-effort attest; health reports the sink as degraded).
 */
export const EXECUTION_EVENT_SCHEMA = 'dc.execution-event.v1' as const;

export type ExecutionOutcome = 'success' | 'error' | 'refused';

export interface ExecutionEvent {
  schema: typeof EXECUTION_EVENT_SCHEMA;
  eventId: string;
  requestId: string;
  correlationId: string | null;
  timestamp: string;
  runtimeId: string | null;
  tool: string;
  operationClass: string;
  outcome: ExecutionOutcome;
  normalizedArgumentsHash: string | null;
  origin: 'ui' | 'llm' | null;
  durationMs: number;
  cwd?: string;
  repoHeadSha?: string;
  preconditions?: Record<string, unknown>;
  results?: Record<string, unknown>;
  exitCode?: number | null;
  signal?: string | null;
  truncated?: Record<string, boolean>;
  errorCode?: string;
  errorCategory?: string;
  mechanical: { riskClass: string; authorization: 'external' };
  /** Relayed from a verified ACS capability only; never self-asserted. */
  acs?: { workItemId: string; attemptId: string; leaseId: string };
}

export interface ExecutionEventSink {
  readonly name: string;
  write(event: ExecutionEvent): void;
}

export interface SinkStatus {
  name: string;
  status: 'ok' | 'degraded';
  written: number;
  failed: number;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
}

/** Bounded in-memory ring; always installed. */
export class MemoryEventSink implements ExecutionEventSink {
  readonly name = 'memory';
  private readonly events: ExecutionEvent[] = [];
  constructor(private readonly capacity = 500) {}
  write(event: ExecutionEvent): void {
    this.events.push(event);
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
  }
  recent(limit = 50): ExecutionEvent[] {
    return this.events.slice(-limit);
  }
}

/** Append-only JSONL file sink (DC_EXECUTION_EVENTS_FILE). */
export class JsonlFileEventSink implements ExecutionEventSink {
  readonly name: string;
  constructor(private readonly filePath: string) {
    this.name = `jsonl:${path.basename(filePath)}`;
  }
  write(event: ExecutionEvent): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  }
}

class ExecutionEventBus {
  readonly memory = new MemoryEventSink();
  private readonly sinks: ExecutionEventSink[] = [this.memory];
  private readonly statuses = new Map<string, SinkStatus>();
  private readonly listeners = new Set<(event: ExecutionEvent) => void>();
  private configured = false;

  private configureFromEnv(): void {
    if (this.configured) return;
    this.configured = true;
    const file = process.env.DC_EXECUTION_EVENTS_FILE;
    if (file && path.isAbsolute(file)) this.addSink(new JsonlFileEventSink(file));
  }

  addSink(sink: ExecutionEventSink): void {
    this.sinks.push(sink);
  }

  removeSink(name: string): void {
    const index = this.sinks.findIndex((sink) => sink.name === name);
    if (index > 0) this.sinks.splice(index, 1);
    this.statuses.delete(name);
  }

  /** Subscribe (in-process consumers, e.g. an ACS/LoopTrace forwarder). */
  subscribe(listener: (event: ExecutionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(draft: Omit<ExecutionEvent, 'schema' | 'eventId' | 'timestamp'>): ExecutionEvent {
    this.configureFromEnv();
    const event = redactValue({
      schema: EXECUTION_EVENT_SCHEMA,
      eventId: `dcevt_${crypto.randomUUID()}`,
      timestamp: new Date().toISOString(),
      ...draft,
    }) as ExecutionEvent;
    for (const sink of this.sinks) {
      const status = this.statuses.get(sink.name) ?? { name: sink.name, status: 'ok' as const, written: 0, failed: 0, lastErrorCode: null, lastErrorAt: null };
      try {
        sink.write(event);
        status.written += 1;
        status.status = 'ok';
      } catch (error) {
        status.failed += 1;
        status.status = 'degraded';
        status.lastErrorCode = typeof (error as NodeJS.ErrnoException)?.code === 'string' ? (error as NodeJS.ErrnoException).code! : 'SINK_WRITE_FAILED';
        status.lastErrorAt = event.timestamp;
      }
      this.statuses.set(sink.name, status);
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A faulty subscriber never affects execution.
      }
    }
    return event;
  }

  sinkStatuses(): SinkStatus[] {
    this.configureFromEnv();
    return this.sinks.map((sink) => this.statuses.get(sink.name) ?? { name: sink.name, status: 'ok', written: 0, failed: 0, lastErrorCode: null, lastErrorAt: null });
  }
}

export const executionEvents = new ExecutionEventBus();
