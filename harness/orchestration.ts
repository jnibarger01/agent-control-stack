/** Shared invocation boundary for the orchestration patterns delivered later. */
export interface HarnessInvocation {
  taskId: string;
  input: string;
  maxTokens: number;
  maxWallClockMs: number;
  maxIterations: number;
}

export interface HarnessResult {
  output: string;
  iterations: number;
  stoppedBy: "verified" | "token_budget" | "wall_clock" | "iteration_budget";
}
