import { randomUUID } from "node:crypto";
import { ResourceLockTable, resourceClaimsConflict } from "./locks.js";
import {
  DEFAULT_EXECUTION_SCHEDULER_CONFIG,
  ExecutionSchedulerError,
  type ExecutionAdmission,
  type ExecutionIntent,
  type ExecutionLane,
  type ExecutionSchedulerConfig,
  type SchedulerEnqueueOptions,
  type SchedulerMetricsSnapshot,
  type SchedulerSnapshot
} from "./types.js";

interface QueueItem {
  intent: ExecutionIntent;
  enqueuedAt: number;
  sequence: number;
  resolve: (admission: ExecutionAdmission) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
  lockTimer?: NodeJS.Timeout;
  lockWaitStartedAtByType: Map<string, number>;
}

interface ActiveItem {
  admissionId: string;
  intent: ExecutionIntent;
  admittedAt: number;
  waitMs: number;
  released: boolean;
  timedOut: boolean;
  timeoutTimer?: NodeJS.Timeout;
}

const priorityRank: Record<ExecutionIntent["priority"], number> = {
  interactive: 0,
  normal: 1,
  background: 2
};

export class ExecutionScheduler {
  private readonly config: ExecutionSchedulerConfig;
  private readonly queues = new Map<string, QueueItem[]>();
  private readonly agentOrder: string[] = [];
  private readonly active = new Map<string, ActiveItem>();
  private readonly activeByRequest = new Map<string, string>();
  private readonly locks = new ResourceLockTable();
  private readonly queueWaitSamples: number[] = [];
  private readonly lockWaitSamples = new Map<string, number[]>();
  private sequence = 0;
  private cursor = 0;
  private lastAdmittedAgent: string | undefined;
  private completedTotal = 0;
  private failedTotal = 0;
  private cancelledTotal = 0;
  private queueTimeoutTotal = 0;
  private lockTimeoutTotal = 0;
  private executionTimeoutTotal = 0;
  private overloadRejectedTotal = 0;
  private lockContentionTotal = 0;
  private closed = false;

  constructor(config: Partial<ExecutionSchedulerConfig> = {}) {
    this.config = {
      ...DEFAULT_EXECUTION_SCHEDULER_CONFIG,
      ...config,
      laneLimits: {
        ...DEFAULT_EXECUTION_SCHEDULER_CONFIG.laneLimits,
        ...(config.laneLimits ?? {})
      }
    };
    validateConfig(this.config);
  }

  enqueue(intent: ExecutionIntent, options: SchedulerEnqueueOptions = {}): Promise<ExecutionAdmission> {
    if (this.closed) {
      return Promise.reject(new ExecutionSchedulerError("scheduler_closed", "execution scheduler is closed"));
    }
    if (options.signal?.aborted) {
      this.cancelledTotal += 1;
      return Promise.reject(new ExecutionSchedulerError("scheduler_cancelled", "scheduler request was cancelled"));
    }
    this.assertUniqueRequest(intent.requestId);
    const now = Date.now();
    if (intent.deadlineAt !== undefined && intent.deadlineAt <= now) {
      this.queueTimeoutTotal += 1;
      return Promise.reject(
        new ExecutionSchedulerError(
          "scheduler_queue_timeout",
          "execution authority expired before scheduler admission",
          true,
          this.config.retryAfterMs
        )
      );
    }
    try {
      this.assertQueueCapacity(intent);
    } catch (error) {
      return Promise.reject(error);
    }

    return new Promise<ExecutionAdmission>((resolve, reject) => {
      const item: QueueItem = {
        intent: freezeIntent(intent),
        enqueuedAt: now,
        sequence: this.sequence++,
        resolve,
        reject,
        signal: options.signal,
        lockWaitStartedAtByType: new Map<string, number>()
      };
      const timeoutMs = Math.max(
        1,
        Math.min(
          this.config.queueTimeoutMs,
          intent.deadlineAt === undefined ? Number.POSITIVE_INFINITY : intent.deadlineAt - now
        )
      );
      item.timer = setTimeout(() => this.expireQueued(item), timeoutMs);
      if (options.signal) {
        item.onAbort = () => this.cancelQueued(item, "scheduler_cancelled", "scheduler request was cancelled");
        if (options.signal.aborted) {
          item.onAbort();
          return;
        }
        options.signal.addEventListener("abort", item.onAbort, { once: true });
      }
      const queue = this.queues.get(intent.agentId) ?? [];
      if (!this.queues.has(intent.agentId)) this.agentOrder.push(intent.agentId);
      queue.push(item);
      queue.sort(compareQueued);
      this.queues.set(intent.agentId, queue);
      this.drain();
    });
  }

  cancel(requestId: string): "queued" | "active" | "missing" {
    const queued = this.findQueued(requestId);
    if (queued) {
      this.cancelQueued(queued, "scheduler_cancelled", "scheduler request was cancelled");
      return "queued";
    }
    if (this.activeByRequest.has(requestId)) return "active";
    return "missing";
  }

  releaseRequest(requestId: string, outcome: "completed" | "failed" = "completed"): boolean {
    const admissionId = this.activeByRequest.get(requestId);
    if (!admissionId) return false;
    return this.releaseAdmission(admissionId, outcome);
  }

  armExecutionTimeout(requestId: string): boolean {
    const admissionId = this.activeByRequest.get(requestId);
    if (!admissionId) return false;
    const active = this.active.get(admissionId);
    if (!active || active.released || active.timeoutTimer) return false;
    const timeoutMs = active.intent.executionTimeoutMs;
    if (timeoutMs === undefined) return true;
    active.timeoutTimer = setTimeout(() => this.markExecutionTimeout(requestId), timeoutMs);
    return true;
  }

  markExecutionTimeout(requestId: string): boolean {
    const admissionId = this.activeByRequest.get(requestId);
    if (!admissionId) return false;
    const active = this.active.get(admissionId);
    if (!active) return false;
    if (!active.timedOut) {
      active.timedOut = true;
      this.executionTimeoutTotal += 1;
    }
    // A timeout does not prove the machine mutation stopped. Keep the lock
    // until a terminal result/cancel or explicit reconciliation confirms stop.
    return true;
  }

  snapshot(): SchedulerSnapshot {
    const now = Date.now();
    const queued = this.allQueued().map((item) => ({
      requestId: item.intent.requestId,
      agentId: item.intent.agentId,
      sessionId: item.intent.sessionId,
      tool: item.intent.tool,
      lane: item.intent.lane,
      priority: item.intent.priority,
      resources: item.intent.resources.map((claim) => ({ ...claim })),
      enqueuedAt: item.enqueuedAt,
      waitMs: Math.max(0, now - item.enqueuedAt),
      blockingReason: this.blockingReason(item)
    }));
    const active = [...this.active.values()].map((item) => ({
      admissionId: item.admissionId,
      requestId: item.intent.requestId,
      agentId: item.intent.agentId,
      sessionId: item.intent.sessionId,
      tool: item.intent.tool,
      lane: item.intent.lane,
      resources: item.intent.resources.map((claim) => ({ ...claim })),
      admittedAt: item.admittedAt,
      runningMs: Math.max(0, now - item.admittedAt),
      timedOut: item.timedOut
    }));
    return { active, queued, metrics: this.metrics() };
  }

  metrics(): SchedulerMetricsSnapshot {
    const laneActive = laneRecord(0);
    const agentActive: Record<string, number> = {};
    const agentQueued: Record<string, number> = {};
    for (const item of this.active.values()) {
      laneActive[item.intent.lane] += 1;
      agentActive[item.intent.agentId] = (agentActive[item.intent.agentId] ?? 0) + 1;
    }
    for (const item of this.allQueued()) {
      agentQueued[item.intent.agentId] = (agentQueued[item.intent.agentId] ?? 0) + 1;
    }
    return {
      queueDepth: this.queuedCount(),
      activeRequests: this.active.size,
      completedTotal: this.completedTotal,
      failedTotal: this.failedTotal,
      cancelledTotal: this.cancelledTotal,
      queueTimeoutTotal: this.queueTimeoutTotal,
      lockTimeoutTotal: this.lockTimeoutTotal,
      executionTimeoutTotal: this.executionTimeoutTotal,
      overloadRejectedTotal: this.overloadRejectedTotal,
      lockContentionTotal: this.lockContentionTotal,
      laneActive,
      laneLimit: { ...this.config.laneLimits },
      agentActive,
      agentQueued,
      queueWaitMs: percentiles(this.queueWaitSamples),
      lockWaitMs: Object.fromEntries(
        [...this.lockWaitSamples.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([resourceType, samples]) => [resourceType, percentiles(samples)])
      )
    };
  }

  close(): void {
    this.closed = true;
    for (const item of this.allQueued()) {
      this.cancelQueued(item, "scheduler_cancelled", "scheduler closed before admission");
    }
    // Active state is ephemeral. Startup must reconcile the managed runtime
    // before accepting new machine work after a process restart.
    for (const active of this.active.values()) {
      if (active.timeoutTimer) clearTimeout(active.timeoutTimer);
    }
    this.active.clear();
    this.activeByRequest.clear();
  }

  private drain(): void {
    if (this.closed) return;
    this.cleanupAgentOrder();
    while (this.agentOrder.length > 0) {
      const picked = this.pickNextEligible();
      if (!picked) return;
      const { item, agentIndex } = picked;
      // Capture the logical round-robin successor before removal. When the
      // admitted agent's queue drains, its entry is spliced out of
      // agentOrder and every later index shifts left by one; retaining
      // (agentIndex + 1) against the shortened array would skip the
      // successor for one scheduling turn.
      const orderBefore = [...this.agentOrder];
      const successorId = orderBefore[(agentIndex + 1) % orderBefore.length];
      this.removeQueued(item);
      const admissionId = `sched_${randomUUID()}`;
      const admittedAt = Date.now();
      const waitMs = Math.max(0, admittedAt - item.enqueuedAt);
      this.locks.acquire(admissionId, item.intent.resources);
      const active: ActiveItem = {
        admissionId,
        intent: item.intent,
        admittedAt,
        waitMs,
        released: false,
        timedOut: false
      };
      this.active.set(admissionId, active);
      this.activeByRequest.set(item.intent.requestId, admissionId);
      this.lastAdmittedAgent = item.intent.agentId;
      this.queueWaitSamples.push(waitMs);
      if (this.queueWaitSamples.length > 2048) this.queueWaitSamples.shift();
      const successorIndex = successorId === undefined ? -1 : this.agentOrder.indexOf(successorId);
      this.cursor = this.agentOrder.length === 0 ? 0 : successorIndex >= 0 ? successorIndex : 0;
      item.resolve({
        admissionId,
        requestId: item.intent.requestId,
        agentId: item.intent.agentId,
        admittedAt,
        waitMs,
        release: (outcome) => {
          this.releaseAdmission(admissionId, outcome);
        }
      });
      this.cleanupAgentOrder();
    }
  }

  private pickNextEligible(): { item: QueueItem; agentIndex: number } | undefined {
    const count = this.agentOrder.length;
    const lastIndex = this.lastAdmittedAgent ? this.agentOrder.indexOf(this.lastAdmittedAgent) : -1;
    const startIndex = lastIndex >= 0 ? (lastIndex + 1) % count : this.cursor;
    for (let offset = 0; offset < count; offset += 1) {
      const agentIndex = (startIndex + offset) % count;
      const agentId = this.agentOrder[agentIndex]!;
      const queue = this.queues.get(agentId) ?? [];
      for (const item of queue) {
        if (this.isEligible(item)) return { item, agentIndex };
      }
    }
    return undefined;
  }

  private isEligible(item: QueueItem): boolean {
    const now = Date.now();
    if (item.intent.deadlineAt !== undefined && item.intent.deadlineAt <= now) {
      this.expireQueued(item);
      return false;
    }
    const blockingKeys = this.locks.blockingKeys(item.intent.requestId, item.intent.resources);
    if (blockingKeys.length > 0) {
      this.noteLockWait(item, blockingKeys, now);
      return false;
    }
    this.clearLockWait(item, now);
    if (this.laneActive(item.intent.lane) >= this.config.laneLimits[item.intent.lane]) {
      return false;
    }
    if (
      item.intent.lane === "process" &&
      this.agentActiveInLane(item.intent.agentId, "process") >= this.config.maxActiveProcessesPerAgent
    ) {
      return false;
    }
    if (this.exceedsRepoMutationQuota(item.intent)) return false;
    if (this.hasEarlierConflictingWaiter(item)) return false;
    return true;
  }

  private hasEarlierConflictingWaiter(item: QueueItem): boolean {
    for (const other of this.allQueued()) {
      if (other === item || other.sequence >= item.sequence) continue;
      if (resourceClaimsConflict(other.intent.resources, item.intent.resources)) {
        return true;
      }
    }
    return false;
  }

  private exceedsRepoMutationQuota(intent: ExecutionIntent): boolean {
    if (intent.effects !== "workspace_mutation") return false;
    const repos = intent.resources.filter((claim) => claim.key.startsWith("repo:")).map((claim) => claim.key);
    if (repos.length === 0) return false;
    for (const repo of repos) {
      let count = 0;
      for (const active of this.active.values()) {
        if (active.intent.agentId !== intent.agentId) continue;
        if (active.intent.effects !== "workspace_mutation") continue;
        if (active.intent.resources.some((claim) => claim.key === repo)) {
          count += 1;
        }
      }
      if (count >= this.config.maxMutationsPerRepoPerAgent) return true;
    }
    return false;
  }

  private blockingReason(item: QueueItem): string {
    if (this.hasEarlierConflictingWaiter(item)) return "earlier conflicting request";
    if (this.laneActive(item.intent.lane) >= this.config.laneLimits[item.intent.lane]) {
      return `${item.intent.lane} lane capacity`;
    }
    if (
      item.intent.lane === "process" &&
      this.agentActiveInLane(item.intent.agentId, "process") >= this.config.maxActiveProcessesPerAgent
    ) {
      return "per-agent process capacity";
    }
    if (this.exceedsRepoMutationQuota(item.intent)) {
      return "per-agent repository mutation quota";
    }
    const blockingKeys = this.locks.blockingKeys(item.intent.requestId, item.intent.resources);
    return blockingKeys.length > 0 ? `resource lock: ${blockingKeys.join(", ")}` : "ready";
  }

  private noteLockWait(item: QueueItem, blockingKeys: readonly string[], now: number): void {
    const currentTypes = new Set(blockingKeys.map(resourceType));
    for (const [type, startedAt] of item.lockWaitStartedAtByType) {
      if (currentTypes.has(type)) continue;
      this.recordLockWaitSample(type, Math.max(0, now - startedAt));
      item.lockWaitStartedAtByType.delete(type);
    }
    if (item.lockWaitStartedAtByType.size === 0) {
      this.lockContentionTotal += 1;
      if (item.lockTimer) clearTimeout(item.lockTimer);
      item.lockTimer = setTimeout(() => this.expireLockWait(item), this.config.lockTimeoutMs);
    }
    for (const type of currentTypes) {
      if (!item.lockWaitStartedAtByType.has(type)) {
        item.lockWaitStartedAtByType.set(type, now);
      }
    }
  }

  private clearLockWait(item: QueueItem, endedAt: number): void {
    if (item.lockTimer) {
      clearTimeout(item.lockTimer);
      item.lockTimer = undefined;
    }
    for (const [type, startedAt] of item.lockWaitStartedAtByType) {
      this.recordLockWaitSample(type, Math.max(0, endedAt - startedAt));
    }
    item.lockWaitStartedAtByType.clear();
  }

  private recordLockWaitSample(type: string, durationMs: number): void {
    const samples = this.lockWaitSamples.get(type) ?? [];
    samples.push(durationMs);
    if (samples.length > 2048) samples.shift();
    this.lockWaitSamples.set(type, samples);
  }

  private expireLockWait(item: QueueItem): void {
    if (!this.removeQueued(item)) return;
    this.lockTimeoutTotal += 1;
    item.reject(
      new ExecutionSchedulerError(
        "scheduler_lock_timeout",
        "scheduler resource lock wait timed out",
        true,
        this.config.retryAfterMs
      )
    );
    this.drain();
  }

  private releaseAdmission(admissionId: string, outcome: "completed" | "failed" | "abandoned" = "completed"): boolean {
    const active = this.active.get(admissionId);
    if (!active || active.released) return false;
    active.released = true;
    if (active.timeoutTimer) clearTimeout(active.timeoutTimer);
    this.locks.release(admissionId);
    this.active.delete(admissionId);
    this.activeByRequest.delete(active.intent.requestId);
    if (outcome === "completed") this.completedTotal += 1;
    else if (outcome === "failed") this.failedTotal += 1;
    this.drain();
    return true;
  }

  private expireQueued(item: QueueItem): void {
    if (!this.removeQueued(item)) return;
    this.queueTimeoutTotal += 1;
    item.reject(
      new ExecutionSchedulerError(
        "scheduler_queue_timeout",
        "scheduler admission timed out before resources became available",
        true,
        this.config.retryAfterMs
      )
    );
    this.drain();
  }

  private cancelQueued(item: QueueItem, code: string, message: string): void {
    if (!this.removeQueued(item)) return;
    this.cancelledTotal += 1;
    item.reject(new ExecutionSchedulerError(code, message, false));
    this.drain();
  }

  private removeQueued(item: QueueItem): boolean {
    const queue = this.queues.get(item.intent.agentId);
    if (!queue) return false;
    const index = queue.indexOf(item);
    if (index < 0) return false;
    queue.splice(index, 1);
    if (item.timer) clearTimeout(item.timer);
    this.clearLockWait(item, Date.now());
    if (item.signal && item.onAbort) {
      item.signal.removeEventListener("abort", item.onAbort);
    }
    if (queue.length === 0) this.queues.delete(item.intent.agentId);
    this.cleanupAgentOrder();
    return true;
  }

  private assertUniqueRequest(requestId: string): void {
    if (this.activeByRequest.has(requestId) || this.findQueued(requestId)) {
      throw new ExecutionSchedulerError(
        "scheduler_duplicate_request",
        `scheduler request already exists: ${requestId}`
      );
    }
  }

  private assertQueueCapacity(intent: ExecutionIntent): void {
    const total = this.queuedCount();
    const agent = this.queues.get(intent.agentId)?.length ?? 0;
    const activeAgent = [...this.active.values()].filter((item) => item.intent.agentId === intent.agentId).length;
    const session = this.allQueued().filter((item) => item.intent.sessionId === intent.sessionId).length;
    if (
      total >= this.config.maxQueued ||
      agent >= this.config.maxQueuedPerAgent ||
      agent + activeAgent >= this.config.maxOutstandingPerAgent ||
      session >= this.config.maxQueuedPerSession
    ) {
      this.overloadRejectedTotal += 1;
      throw new ExecutionSchedulerError(
        "scheduler_overloaded",
        "execution scheduler queue capacity reached",
        true,
        this.config.retryAfterMs
      );
    }
  }

  private findQueued(requestId: string): QueueItem | undefined {
    return this.allQueued().find((item) => item.intent.requestId === requestId);
  }

  private allQueued(): QueueItem[] {
    return [...this.queues.values()].flat();
  }

  private queuedCount(): number {
    let total = 0;
    for (const queue of this.queues.values()) total += queue.length;
    return total;
  }

  private laneActive(lane: ExecutionLane): number {
    let count = 0;
    for (const item of this.active.values()) {
      if (item.intent.lane === lane) count += 1;
    }
    return count;
  }

  private agentActiveInLane(agentId: string, lane: ExecutionLane): number {
    let count = 0;
    for (const item of this.active.values()) {
      if (item.intent.agentId === agentId && item.intent.lane === lane) count += 1;
    }
    return count;
  }

  private cleanupAgentOrder(): void {
    for (let index = this.agentOrder.length - 1; index >= 0; index -= 1) {
      if (!this.queues.has(this.agentOrder[index]!)) {
        this.agentOrder.splice(index, 1);
      }
    }
    if (this.agentOrder.length === 0) this.cursor = 0;
    else this.cursor %= this.agentOrder.length;
  }
}

function compareQueued(left: QueueItem, right: QueueItem): number {
  const priority = priorityRank[left.intent.priority] - priorityRank[right.intent.priority];
  return priority !== 0 ? priority : left.sequence - right.sequence;
}

function freezeIntent(intent: ExecutionIntent): ExecutionIntent {
  return Object.freeze({
    ...intent,
    cost: Object.freeze({ ...intent.cost }),
    resources: intent.resources.map((claim) => Object.freeze({ ...claim }))
  });
}

function resourceType(key: string): string {
  const separator = key.indexOf(":");
  return separator > 0 ? key.slice(0, separator) : "unknown";
}

function laneRecord(value: number): Record<ExecutionLane, number> {
  return { read: value, search: value, process: value, mutation: value };
}

function percentiles(values: readonly number[]): { p50: number; p95: number; p99: number } {
  if (values.length === 0) return { p50: 0, p95: 0, p99: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  const at = (percentile: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentile))]!;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

function validateConfig(config: ExecutionSchedulerConfig): void {
  const positives = [
    config.maxQueued,
    config.maxQueuedPerAgent,
    config.maxQueuedPerSession,
    config.maxOutstandingPerAgent,
    config.maxActiveProcessesPerAgent,
    config.maxMutationsPerRepoPerAgent,
    config.queueTimeoutMs,
    config.lockTimeoutMs,
    config.retryAfterMs,
    ...Object.values(config.laneLimits)
  ];
  if (positives.some((value) => !Number.isInteger(value) || value <= 0)) {
    throw new ExecutionSchedulerError("scheduler_config_invalid", "scheduler limits must be positive integers");
  }
}
