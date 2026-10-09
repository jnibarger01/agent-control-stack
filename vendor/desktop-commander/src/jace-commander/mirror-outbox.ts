/**
 * ACS mirror outbox (ADR 0026 D5).
 *
 * The local hash-chained trace is AUTHORITATIVE. Mirroring is a best-effort copy to
 * ACS and can never change that:
 *  - It only READS the local trace files. It never writes to them, never delays a
 *    tool call (it runs on its own timer), and its failures are swallowed.
 *  - Delivery is ordered per run and idempotent: a batch is a contiguous slice of one
 *    run's events starting at the cursor, identified by a deterministic batchId. A
 *    retry after a failure resends the identical batch; the cursor advances only on
 *    a confirmed success, persisted atomically.
 *  - Bounded: if more than `maxPending` records are unsent, the OLDEST unsent records
 *    are skipped for DELIVERY ONLY and reported as explicit `gaps` in the next batch
 *    so ACS can detect the discontinuity. They stay in the local trace untouched.
 *  - Every batch carries `chainHead` (the hash of the last event in the batch) and
 *    `prevHash` so ACS can verify continuity, and only already-redacted trace events
 *    (the trace stores argument digests, never raw arguments).
 *
 * Wire format `jc.trace.mirror.v1` (the ACS ingest route is a separate ACS change):
 *   POST <JC_ACS_MIRROR_URL>  { schema, runtimeId, policyHash?, batchId,
 *                               runs: [{ runId, fromSeq, prevHash, chainHead, events: [...] }],
 *                               gaps: [{ runId, fromSeq, toSeq }] }
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readTraceFile, type LoopTraceEvent } from './looptrace.js';

export const MIRROR_SCHEMA = 'jc.trace.mirror.v1';
export const DEFAULT_MAX_PENDING = 5000;
export const DEFAULT_BATCH_SIZE = 200;
const GENESIS = '0'.repeat(64);

export interface MirrorGap { runId: string; fromSeq: number; toSeq: number }
export interface MirrorBatch {
  schema: typeof MIRROR_SCHEMA;
  runtimeId: string;
  policyHash?: string;
  batchId: string;
  runs: Array<{ runId: string; fromSeq: number; prevHash: string; chainHead: string; events: LoopTraceEvent[] }>;
  gaps: MirrorGap[];
}

export type MirrorSender = (batch: MirrorBatch) => Promise<{ ok: boolean; status?: number }>;

interface CursorState {
  /** Per run: number of events already delivered or deliberately skipped (a gap). */
  runs: Record<string, number>;
  /** Gaps not yet confirmed to ACS. */
  pendingGaps: MirrorGap[];
  lastSuccessAt?: string;
  lastError?: string;
  failures: number;
}

export interface MirrorOutboxOptions {
  traceDir: string;
  stateDir: string;
  runtimeId: string;
  policyHash?: string;
  send: MirrorSender;
  maxPending?: number;
  batchSize?: number;
  now?: () => number;
}

export interface MirrorStatus {
  pending: number;
  gaps: number;
  failures: number;
  lastSuccessAt: string | null;
  lastError: string | null;
}

export class MirrorOutbox {
  private readonly cursorPath: string;
  private state: CursorState;
  private running = false;

  constructor(private readonly options: MirrorOutboxOptions) {
    this.cursorPath = path.join(options.stateDir, 'mirror', 'cursor.json');
    this.state = this.loadState();
  }

  status(): MirrorStatus {
    return {
      pending: this.scan().reduce((sum, run) => sum + Math.max(0, run.events.length - (this.state.runs[run.runId] ?? 0)), 0),
      gaps: this.state.pendingGaps.length,
      failures: this.state.failures,
      lastSuccessAt: this.state.lastSuccessAt ?? null,
      lastError: this.state.lastError ?? null,
    };
  }

  /**
   * Ships at most one batch. Never throws: a mirror problem must not touch a tool call.
   * Returns whether a batch was confirmed delivered.
   */
  async pump(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      const runs = this.scan();
      this.applyBackpressure(runs);
      const batch = this.nextBatch(runs);
      if (!batch) return false;
      let result: { ok: boolean; status?: number };
      try {
        result = await this.options.send(batch);
      } catch (error) {
        result = { ok: false };
        this.state.lastError = error instanceof Error ? error.message.slice(0, 200) : 'send failed';
      }
      if (!result.ok) {
        this.state.failures += 1;
        this.state.lastError ??= `ACS answered ${result.status ?? 'no response'}`;
        this.save();
        return false;
      }
      for (const run of batch.runs) this.state.runs[run.runId] = run.fromSeq + run.events.length;
      this.state.pendingGaps = this.state.pendingGaps.filter((gap) => !batch.gaps.some((sent) => sent.runId === gap.runId && sent.fromSeq === gap.fromSeq));
      this.state.failures = 0;
      delete this.state.lastError;
      this.state.lastSuccessAt = new Date((this.options.now ?? Date.now)()).toISOString();
      this.save();
      return true;
    } catch {
      return false;
    } finally {
      this.running = false;
    }
  }

  // -- internals --

  private scan(): Array<{ runId: string; events: LoopTraceEvent[] }> {
    let files: string[];
    try {
      files = fs.readdirSync(this.options.traceDir).filter((name) => name.endsWith('.jsonl')).sort();
    } catch {
      return [];
    }
    const runs: Array<{ runId: string; events: LoopTraceEvent[] }> = [];
    for (const file of files) {
      try {
        const { events } = readTraceFile(path.join(this.options.traceDir, file));
        const first = events[0] as LoopTraceEvent | undefined;
        if (first && typeof first.run_id === 'string') runs.push({ runId: first.run_id, events: events as LoopTraceEvent[] });
      } catch {
        // An unreadable trace file is skipped for mirroring only; the local chain is unaffected.
      }
    }
    return runs;
  }

  /** Over the bound: skip the oldest unsent records for delivery and record explicit gaps. */
  private applyBackpressure(runs: Array<{ runId: string; events: LoopTraceEvent[] }>): void {
    const max = this.options.maxPending ?? DEFAULT_MAX_PENDING;
    let pending = runs.reduce((sum, run) => sum + Math.max(0, run.events.length - (this.state.runs[run.runId] ?? 0)), 0);
    if (pending <= max) return;
    for (const run of runs) {
      if (pending <= max) break;
      const sent = this.state.runs[run.runId] ?? 0;
      const unsent = run.events.length - sent;
      if (unsent <= 0) continue;
      const skip = Math.min(unsent, pending - max);
      this.state.pendingGaps.push({ runId: run.runId, fromSeq: sent, toSeq: sent + skip - 1 });
      this.state.runs[run.runId] = sent + skip;
      pending -= skip;
    }
    this.save();
  }

  private nextBatch(runs: Array<{ runId: string; events: LoopTraceEvent[] }>): MirrorBatch | undefined {
    const size = this.options.batchSize ?? DEFAULT_BATCH_SIZE;
    const batchRuns: MirrorBatch['runs'] = [];
    let room = size;
    for (const run of runs) {
      if (room <= 0) break;
      const from = this.state.runs[run.runId] ?? 0;
      const events = run.events.slice(from, from + room);
      if (events.length === 0) continue;
      batchRuns.push({
        runId: run.runId,
        fromSeq: from,
        prevHash: from === 0 ? GENESIS : run.events[from - 1].hash,
        chainHead: events[events.length - 1].hash,
        events,
      });
      room -= events.length;
    }
    const gaps = this.state.pendingGaps.slice(0, 50);
    if (batchRuns.length === 0 && gaps.length === 0) return undefined;
    const batchId = crypto.createHash('sha256')
      .update(JSON.stringify({ runtimeId: this.options.runtimeId, runs: batchRuns.map((run) => [run.runId, run.fromSeq, run.chainHead]), gaps }))
      .digest('hex');
    return {
      schema: MIRROR_SCHEMA,
      runtimeId: this.options.runtimeId,
      ...(this.options.policyHash ? { policyHash: this.options.policyHash } : {}),
      batchId,
      runs: batchRuns,
      gaps,
    };
  }

  private loadState(): CursorState {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cursorPath, 'utf8')) as CursorState;
      if (parsed && typeof parsed.runs === "object" && Array.isArray(parsed.pendingGaps)) return { ...parsed, failures: Number.isInteger(parsed.failures) ? parsed.failures : 0 };
    } catch {
      // No usable cursor: start from the beginning. Resending is safe because delivery is idempotent.
    }
    return { runs: {}, pendingGaps: [], failures: 0 };
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.cursorPath), { recursive: true, mode: 0o700 });
      const temp = `${this.cursorPath}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(this.state), { mode: 0o600 });
      fs.renameSync(temp, this.cursorPath);
    } catch {
      // If the cursor cannot be saved the worst case is a redundant resend.
    }
  }
}
