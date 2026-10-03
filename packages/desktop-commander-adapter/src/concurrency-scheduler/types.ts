import { ControlStackError } from "@agent-control-stack/shared";

export type ExecutionLane = "read" | "search" | "process" | "mutation";
export type ExecutionEffect = "read_only" | "workspace_mutation" | "host_mutation";
export type ExecutionPriority = "interactive" | "normal" | "background";
export type ResourceMode = "shared" | "exclusive";

export interface ResourceClaim {
  key: string;
  mode: ResourceMode;
}

export interface ExecutionCost {
  cpu: number;
  memory: number;
  io: number;
}

export interface ExecutionIntent {
  requestId: string;
  agentId: string;
  sessionId: string;
  tool: string;
  normalizedArguments: unknown;
  lane: ExecutionLane;
  effects: ExecutionEffect;
  resources: ResourceClaim[];
  cost: ExecutionCost;
  priority: ExecutionPriority;
  /** Overall authority deadline (for example, the attempt lease expiry). */
  deadlineAt?: number;
  /** Maximum active execution hold after admission. */
  executionTimeoutMs?: number;
}

export interface ExecutionSchedulerConfig {
  maxQueued: number;
  maxQueuedPerAgent: number;
  maxQueuedPerSession: number;
  maxOutstandingPerAgent: number;
  maxActiveProcessesPerAgent: number;
  maxMutationsPerRepoPerAgent: number;
  queueTimeoutMs: number;
  lockTimeoutMs: number;
  retryAfterMs: number;
  laneLimits: Record<ExecutionLane, number>;
}

export interface SchedulerEnqueueOptions {
  signal?: AbortSignal;
}

export interface ExecutionAdmission {
  readonly admissionId: string;
  readonly requestId: string;
  readonly agentId: string;
  readonly admittedAt: number;
  readonly waitMs: number;
  release(outcome?: "completed" | "failed" | "abandoned"): void;
}
export interface ActiveExecutionSnapshot {
  admissionId: string;
  requestId: string;
  agentId: string;
  sessionId: string;
  tool: string;
  lane: ExecutionLane;
  resources: ResourceClaim[];
  admittedAt: number;
  runningMs: number;
  timedOut: boolean;
}

export interface QueuedExecutionSnapshot {
  requestId: string;
  agentId: string;
  sessionId: string;
  tool: string;
  lane: ExecutionLane;
  priority: ExecutionPriority;
  resources: ResourceClaim[];
  enqueuedAt: number;
  waitMs: number;
  blockingReason: string;
}

export interface SchedulerPercentiles {
  p50: number;
  p95: number;
  p99: number;
}
export interface SchedulerMetricsSnapshot {
  queueDepth: number;
  activeRequests: number;
  completedTotal: number;
  failedTotal: number;
  cancelledTotal: number;
  queueTimeoutTotal: number;
  lockTimeoutTotal: number;
  executionTimeoutTotal: number;
  overloadRejectedTotal: number;
  lockContentionTotal: number;
  laneActive: Record<ExecutionLane, number>;
  laneLimit: Record<ExecutionLane, number>;
  agentActive: Record<string, number>;
  agentQueued: Record<string, number>;
  queueWaitMs: SchedulerPercentiles;
  lockWaitMs: Record<string, SchedulerPercentiles>;
}

export interface SchedulerSnapshot {
  active: ActiveExecutionSnapshot[];
  queued: QueuedExecutionSnapshot[];
  metrics: SchedulerMetricsSnapshot;
}

export class ExecutionSchedulerError extends ControlStackError {
  constructor(
    code: string,
    message: string,
    public readonly retryable = false,
    public readonly retryAfterMs?: number
  ) {
    super(code, message);
    this.name = "ExecutionSchedulerError";
  }
}

export const DEFAULT_EXECUTION_SCHEDULER_CONFIG: ExecutionSchedulerConfig = Object.freeze({
  maxQueued: 200,
  maxQueuedPerAgent: 25,
  maxQueuedPerSession: 50,
  maxOutstandingPerAgent: 16,
  maxActiveProcessesPerAgent: 2,
  maxMutationsPerRepoPerAgent: 1,
  queueTimeoutMs: 30_000,
  lockTimeoutMs: 20_000,
  retryAfterMs: 1_500,
  laneLimits: {
    read: 8,
    search: 3,
    process: 3,
    mutation: 8
  }
});
