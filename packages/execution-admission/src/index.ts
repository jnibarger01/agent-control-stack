import { randomUUID } from "node:crypto";
import { dcCapabilityToolContract, dcCapabilityToolContracts } from "@agent-control-stack/dc-tool-manifest";
import { jcToolContract, jcToolContracts } from "@agent-control-stack/jc-tool-manifest";

export type AdmissionLane = "jc" | "dc";
export type AdmissionExecutionClass = "execution" | "wait";
export type AdmissionFailureCode = "executor_busy" | "queue_full" | "admission_cancelled" | "gateway_shutting_down";

export interface AdmissionRequest {
  requestId: string;
  lane: AdmissionLane;
  executorId: string;
  actorId: string;
  toolName: string;
  executionClass: AdmissionExecutionClass;
  enqueuedAt: number;
  deadlineAt: number;
  signal: AbortSignal;
}

export interface AdmissionPermit {
  readonly permitId: string;
  readonly admittedAt: number;
  release(): void;
}

export interface RestoreAdmissionPermitInput {
  permitId: string;
  lane: AdmissionLane;
  executionClass: AdmissionExecutionClass;
  executorId: string;
}

export interface ExecutionAdmissionController {
  acquire(request: AdmissionRequest): Promise<AdmissionPermit>;
  /** Restore an already-authorized in-flight permit after process restart. */
  restoreActivePermit(input: RestoreAdmissionPermitInput): AdmissionPermit;
  shutdown(): void;
  snapshot(): AdmissionSnapshot;
}

export interface ExecutionAdmissionConfig {
  executionMaxInflight: number;
  executorMaxInflight: number;
  queueMax: number;
  queueTimeoutMs: number;
  waitMaxInflight: number;
}

export const DEFAULT_EXECUTION_ADMISSION_CONFIG: ExecutionAdmissionConfig = Object.freeze({
  executionMaxInflight: 4,
  executorMaxInflight: 1,
  queueMax: 32,
  queueTimeoutMs: 30_000,
  waitMaxInflight: 1
});

export type AdmissionEvent =
  | {
      type: "admitted";
      lane: AdmissionLane;
      executionClass: AdmissionExecutionClass;
      waitMs: number;
    }
  | {
      type: "released";
      lane: AdmissionLane;
      executionClass: AdmissionExecutionClass;
      serviceMs: number;
    }
  | {
      type: "rejected";
      lane: AdmissionLane;
      executionClass: AdmissionExecutionClass;
      reason: "queue_full" | "executor_busy" | "gateway_shutting_down";
    }
  | {
      type: "cancelled";
      lane: AdmissionLane;
      executionClass: AdmissionExecutionClass;
    };

export interface ExecutionAdmissionOptions {
  config?: ExecutionAdmissionConfig;
  clock?: AdmissionClock;
  onEvent?: (event: AdmissionEvent) => void;
  idFactory?: () => string;
}

export interface AdmissionClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface AdmissionSnapshot {
  readonly accepting: boolean;
  readonly saturated: boolean;
  readonly global: {
    readonly capacity: number;
    readonly active: number;
    readonly queued: number;
  };
  readonly wait: {
    readonly capacity: number;
    readonly active: number;
    readonly queued: number;
  };
  readonly lanes: Record<AdmissionLane, { active: number; queued: number }>;
  readonly oldestQueueAgeMs: number;
  readonly admissionP95Ms: number;
  readonly serviceP95Ms: number;
}

export class AdmissionError extends Error {
  readonly code: AdmissionFailureCode;
  readonly retryAfterMs?: number;

  constructor(code: AdmissionFailureCode, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "AdmissionError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

type TimerHandle = ReturnType<typeof setTimeout>;

interface QueueEntry {
  request: AdmissionRequest;
  groupKey: string;
  queuedAt: number;
  deadlineAt: number;
  timer: TimerHandle;
  abortListener: () => void;
  resolve: (permit: AdmissionPermit) => void;
  reject: (error: AdmissionError) => void;
  settled: boolean;
}

interface ClassQueue {
  groups: Map<string, QueueEntry[]>;
  order: string[];
  queued: number;
}

interface ActivePermit {
  permitId: string;
  lane: AdmissionLane;
  executionClass: AdmissionExecutionClass;
  executorId: string;
  admittedAt: number;
}

const SAMPLE_LIMIT = 256;

const DEFAULT_CLOCK: AdmissionClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle)
};

function positiveInteger(name: string, value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function validateExecutionAdmissionConfig(input: ExecutionAdmissionConfig): ExecutionAdmissionConfig {
  return {
    executionMaxInflight: positiveInteger("ACS_EXECUTION_MAX_INFLIGHT", input.executionMaxInflight),
    executorMaxInflight: positiveInteger("ACS_EXECUTOR_MAX_INFLIGHT", input.executorMaxInflight),
    queueMax: positiveInteger("ACS_EXECUTION_QUEUE_MAX", input.queueMax),
    queueTimeoutMs: positiveInteger("ACS_EXECUTION_QUEUE_TIMEOUT_MS", input.queueTimeoutMs),
    waitMaxInflight: positiveInteger("ACS_WAIT_MAX_INFLIGHT", input.waitMaxInflight)
  };
}

export function resolveExecutionAdmissionConfig(env: NodeJS.ProcessEnv = process.env): ExecutionAdmissionConfig {
  const read = (name: string, fallback: number) => {
    const raw = env[name];
    return raw === undefined || raw.trim() === "" ? fallback : positiveInteger(name, raw);
  };
  return validateExecutionAdmissionConfig({
    executionMaxInflight: read("ACS_EXECUTION_MAX_INFLIGHT", DEFAULT_EXECUTION_ADMISSION_CONFIG.executionMaxInflight),
    executorMaxInflight: read("ACS_EXECUTOR_MAX_INFLIGHT", DEFAULT_EXECUTION_ADMISSION_CONFIG.executorMaxInflight),
    queueMax: read("ACS_EXECUTION_QUEUE_MAX", DEFAULT_EXECUTION_ADMISSION_CONFIG.queueMax),
    queueTimeoutMs: read("ACS_EXECUTION_QUEUE_TIMEOUT_MS", DEFAULT_EXECUTION_ADMISSION_CONFIG.queueTimeoutMs),
    waitMaxInflight: read("ACS_WAIT_MAX_INFLIGHT", DEFAULT_EXECUTION_ADMISSION_CONFIG.waitMaxInflight)
  });
}

const WAIT_TOOL_NAMES = new Set(["read_process_output"]);

export function classifyAdmissionTool(lane: AdmissionLane, toolName: string): AdmissionExecutionClass {
  const governed = lane === "jc" ? jcToolContract(toolName) : dcCapabilityToolContract(toolName);
  if (!governed) return "execution";
  return WAIT_TOOL_NAMES.has(toolName) ? "wait" : "execution";
}

export function governedAdmissionToolNames(lane: AdmissionLane): string[] {
  return lane === "jc"
    ? jcToolContracts().map((tool) => tool.name)
    : dcCapabilityToolContracts().map((tool) => tool.name);
}

function percentile95(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function decrementCounter(map: Map<string, number>, key: string): void {
  const next = (map.get(key) ?? 0) - 1;
  if (next > 0) map.set(key, next);
  else map.delete(key);
}

export class ExecutionAdmissionScheduler implements ExecutionAdmissionController {
  readonly config: ExecutionAdmissionConfig;
  private readonly clock: AdmissionClock;
  private readonly onEvent?: (event: AdmissionEvent) => void;
  private readonly idFactory: () => string;
  private accepting = true;
  private dispatching = false;
  private activeExecution = 0;
  private activeWait = 0;
  private readonly activeExecutionByExecutor = new Map<string, number>();
  private readonly activeWaitByExecutor = new Map<string, number>();
  private readonly activePermits = new Map<string, ActivePermit>();
  private readonly queues: Record<AdmissionExecutionClass, ClassQueue> = {
    execution: { groups: new Map(), order: [], queued: 0 },
    wait: { groups: new Map(), order: [], queued: 0 }
  };
  private readonly waitSamples: number[] = [];
  private readonly serviceSamples: number[] = [];

  constructor(options: ExecutionAdmissionOptions = {}) {
    this.config = validateExecutionAdmissionConfig(options.config ?? DEFAULT_EXECUTION_ADMISSION_CONFIG);
    this.clock = options.clock ?? DEFAULT_CLOCK;
    this.onEvent = options.onEvent;
    this.idFactory = options.idFactory ?? randomUUID;
  }

  acquire(request: AdmissionRequest): Promise<AdmissionPermit> {
    if (!this.accepting) {
      return Promise.reject(this.rejected(request, "gateway_shutting_down", "execution admission is shutting down"));
    }
    if (request.signal.aborted) {
      this.onEvent?.({ type: "cancelled", lane: request.lane, executionClass: request.executionClass });
      return Promise.reject(new AdmissionError("admission_cancelled", "execution admission request was cancelled"));
    }

    const now = this.clock.now();
    const deadlineAt = Math.min(request.deadlineAt, now + this.config.queueTimeoutMs);
    if (!Number.isFinite(deadlineAt) || deadlineAt <= now) {
      return Promise.reject(
        this.rejected(request, "executor_busy", "execution admission deadline expired", this.retryAfterMs())
      );
    }

    const queue = this.queues[request.executionClass];
    if (queue.queued === 0 && this.canAdmit(request)) {
      return Promise.resolve(this.admit(request, now));
    }
    if (this.totalQueued() >= this.config.queueMax) {
      return Promise.reject(
        this.rejected(request, "queue_full", "execution admission queue is full", this.retryAfterMs())
      );
    }

    return new Promise<AdmissionPermit>((resolve, reject) => {
      const groupKey = `${request.lane}|${request.actorId}`;
      // The listeners close over this single queue entry; it is assigned once below.
      // eslint-disable-next-line prefer-const
      let entry!: QueueEntry;
      const abortListener = () => this.cancelQueued(entry);
      const timer = this.clock.setTimeout(() => this.timeoutQueued(entry), Math.max(1, deadlineAt - now));
      entry = {
        request,
        groupKey,
        queuedAt: now,
        deadlineAt,
        timer,
        abortListener,
        resolve,
        reject,
        settled: false
      };
      const group = queue.groups.get(groupKey);
      if (group) group.push(entry);
      else {
        queue.groups.set(groupKey, [entry]);
        queue.order.push(groupKey);
      }
      queue.queued += 1;
      request.signal.addEventListener("abort", abortListener, { once: true });
      this.dispatch();
    });
  }

  shutdown(): void {
    if (!this.accepting) return;
    this.accepting = false;
    for (const executionClass of ["execution", "wait"] as const) {
      const queue = this.queues[executionClass];
      for (const entries of queue.groups.values()) {
        for (const entry of entries) {
          if (entry.settled) continue;
          entry.settled = true;
          this.cleanupEntry(entry);
          this.onEvent?.({
            type: "rejected",
            lane: entry.request.lane,
            executionClass,
            reason: "gateway_shutting_down"
          });
          entry.reject(new AdmissionError("gateway_shutting_down", "execution admission is shutting down"));
        }
      }
      queue.groups.clear();
      queue.order.length = 0;
      queue.queued = 0;
    }
  }

  snapshot(): AdmissionSnapshot {
    const now = this.clock.now();
    const lanes: Record<AdmissionLane, { active: number; queued: number }> = {
      jc: { active: 0, queued: 0 },
      dc: { active: 0, queued: 0 }
    };
    for (const permit of this.activePermits.values()) lanes[permit.lane].active += 1;
    let oldest = 0;
    for (const executionClass of ["execution", "wait"] as const) {
      for (const entries of this.queues[executionClass].groups.values()) {
        for (const entry of entries) {
          lanes[entry.request.lane].queued += 1;
          oldest = Math.max(oldest, Math.max(0, now - entry.queuedAt));
        }
      }
    }
    return {
      accepting: this.accepting,
      saturated: this.activeExecution >= this.config.executionMaxInflight,
      global: {
        capacity: this.config.executionMaxInflight,
        active: this.activeExecution,
        queued: this.queues.execution.queued
      },
      wait: {
        capacity: this.config.waitMaxInflight,
        active: this.activeWait,
        queued: this.queues.wait.queued
      },
      lanes,
      oldestQueueAgeMs: oldest,
      admissionP95Ms: percentile95(this.waitSamples),
      serviceP95Ms: percentile95(this.serviceSamples)
    };
  }

  private totalQueued(): number {
    return this.queues.execution.queued + this.queues.wait.queued;
  }

  private retryAfterMs(): number {
    return Math.max(1, Math.min(1_000, this.config.queueTimeoutMs));
  }

  private rejected(
    request: AdmissionRequest,
    code: "queue_full" | "executor_busy" | "gateway_shutting_down",
    message: string,
    retryAfterMs?: number
  ): AdmissionError {
    this.onEvent?.({ type: "rejected", lane: request.lane, executionClass: request.executionClass, reason: code });
    return new AdmissionError(code, message, retryAfterMs);
  }

  private canAdmit(request: AdmissionRequest): boolean {
    if (request.executionClass === "wait") {
      return (
        this.activeWait < this.config.waitMaxInflight &&
        (this.activeWaitByExecutor.get(request.executorId) ?? 0) < this.config.executorMaxInflight
      );
    }
    return (
      this.activeExecution < this.config.executionMaxInflight &&
      (this.activeExecutionByExecutor.get(request.executorId) ?? 0) < this.config.executorMaxInflight
    );
  }

  /**
   * Inject an already-active permit after restart. This does not re-run
   * admission. release() returns the slot to the scheduler.
   */
  restoreActivePermit(input: RestoreAdmissionPermitInput): AdmissionPermit {
    const existing = this.activePermits.get(input.permitId);
    if (existing) {
      return {
        permitId: existing.permitId,
        admittedAt: existing.admittedAt,
        release: () => {
          this.releasePermit(existing.permitId);
        }
      };
    }
    const { permitId, lane, executionClass, executorId } = input;
    const admittedAt = this.clock.now();
    this.activePermits.set(permitId, { permitId, lane, executionClass, executorId, admittedAt });
    if (executionClass === "wait") {
      this.activeWait += 1;
      this.activeWaitByExecutor.set(executorId, (this.activeWaitByExecutor.get(executorId) ?? 0) + 1);
    } else {
      this.activeExecution += 1;
      this.activeExecutionByExecutor.set(executorId, (this.activeExecutionByExecutor.get(executorId) ?? 0) + 1);
    }
    return {
      permitId,
      admittedAt,
      release: () => {
        this.releasePermit(permitId);
      }
    };
  }

  private admit(request: AdmissionRequest, admittedAt: number): AdmissionPermit {
    const permitId = this.idFactory();
    const waitMs = Math.max(0, admittedAt - request.enqueuedAt);
    const record: ActivePermit = {
      permitId,
      lane: request.lane,
      executionClass: request.executionClass,
      executorId: request.executorId,
      admittedAt
    };
    this.activePermits.set(permitId, record);
    if (request.executionClass === "wait") {
      this.activeWait += 1;
      this.activeWaitByExecutor.set(request.executorId, (this.activeWaitByExecutor.get(request.executorId) ?? 0) + 1);
    } else {
      this.activeExecution += 1;
      this.activeExecutionByExecutor.set(
        request.executorId,
        (this.activeExecutionByExecutor.get(request.executorId) ?? 0) + 1
      );
    }
    this.pushSample(this.waitSamples, waitMs);
    this.onEvent?.({ type: "admitted", lane: request.lane, executionClass: request.executionClass, waitMs });

    let released = false;
    return {
      permitId,
      admittedAt,
      release: () => {
        if (released) return;
        released = true;
        this.releasePermit(permitId);
      }
    };
  }

  private releasePermit(permitId: string): void {
    const record = this.activePermits.get(permitId);
    if (!record) return;
    this.activePermits.delete(permitId);
    if (record.executionClass === "wait") {
      this.activeWait = Math.max(0, this.activeWait - 1);
      decrementCounter(this.activeWaitByExecutor, record.executorId);
    } else {
      this.activeExecution = Math.max(0, this.activeExecution - 1);
      decrementCounter(this.activeExecutionByExecutor, record.executorId);
    }
    const serviceMs = Math.max(0, this.clock.now() - record.admittedAt);
    this.pushSample(this.serviceSamples, serviceMs);
    this.onEvent?.({
      type: "released",
      lane: record.lane,
      executionClass: record.executionClass,
      serviceMs
    });
    this.dispatch();
  }

  private pushSample(samples: number[], value: number): void {
    samples.push(value);
    if (samples.length > SAMPLE_LIMIT) samples.splice(0, samples.length - SAMPLE_LIMIT);
  }

  private dispatch(): void {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      let progressed = true;
      while (progressed) {
        progressed = this.dispatchOne("execution") || this.dispatchOne("wait");
      }
    } finally {
      this.dispatching = false;
    }
  }

  private dispatchOne(executionClass: AdmissionExecutionClass): boolean {
    const queue = this.queues[executionClass];
    for (let index = 0; index < queue.order.length; index += 1) {
      const groupKey = queue.order[index]!;
      const entries = queue.groups.get(groupKey);
      const entry = entries?.[0];
      if (!entries || !entry) {
        queue.order.splice(index, 1);
        queue.groups.delete(groupKey);
        index -= 1;
        continue;
      }
      if (!this.canAdmit(entry.request)) continue;

      entries.shift();
      queue.order.splice(index, 1);
      if (entries.length > 0) queue.order.push(groupKey);
      else queue.groups.delete(groupKey);
      queue.queued -= 1;
      entry.settled = true;
      this.cleanupEntry(entry);
      entry.resolve(this.admit(entry.request, this.clock.now()));
      return true;
    }
    return false;
  }

  private cancelQueued(entry: QueueEntry): void {
    if (!this.removeQueued(entry)) return;
    this.onEvent?.({ type: "cancelled", lane: entry.request.lane, executionClass: entry.request.executionClass });
    entry.reject(new AdmissionError("admission_cancelled", "execution admission request was cancelled"));
    this.dispatch();
  }

  private timeoutQueued(entry: QueueEntry): void {
    if (!this.removeQueued(entry)) return;
    entry.reject(
      this.rejected(entry.request, "executor_busy", "execution admission queue deadline expired", this.retryAfterMs())
    );
    this.dispatch();
  }

  private removeQueued(entry: QueueEntry): boolean {
    if (entry.settled) return false;
    const queue = this.queues[entry.request.executionClass];
    const entries = queue.groups.get(entry.groupKey);
    if (!entries) return false;
    const index = entries.indexOf(entry);
    if (index < 0) return false;
    entries.splice(index, 1);
    queue.queued -= 1;
    if (entries.length === 0) {
      queue.groups.delete(entry.groupKey);
      const orderIndex = queue.order.indexOf(entry.groupKey);
      if (orderIndex >= 0) queue.order.splice(orderIndex, 1);
    }
    entry.settled = true;
    this.cleanupEntry(entry);
    return true;
  }

  private cleanupEntry(entry: QueueEntry): void {
    this.clock.clearTimeout(entry.timer);
    entry.request.signal.removeEventListener("abort", entry.abortListener);
  }
}
