/** Scheduler vocabulary used by Desktop Commander intent classification. */

export type ExecutionLane = "read" | "search" | "mutation" | "process";

export type ExecutionEffect = "read_only" | "workspace_mutation" | "host_mutation";

export type ExecutionPriority = "background" | "low" | "normal" | "high" | "critical";

export type ResourceMode = "shared" | "exclusive";

export interface ResourceClaim {
  readonly key: string;
  readonly mode: ResourceMode;
}

export interface ExecutionCost {
  readonly cpu: number;
  readonly memory: number;
  readonly io: number;
}

export interface ExecutionIntent {
  readonly requestId: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly tool: string;
  readonly normalizedArguments: Readonly<Record<string, unknown>>;
  readonly priority: ExecutionPriority;
  readonly deadlineAt?: number;
  readonly executionTimeoutMs: number;
  readonly lane: ExecutionLane;
  readonly effects: ExecutionEffect;
  readonly resources: readonly ResourceClaim[];
  readonly cost: ExecutionCost;
}
