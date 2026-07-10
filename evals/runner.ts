export interface EvalRunSummary {
  status: "stub";
  tasks: 0;
}

/** Phase-1 stub. Phase 5 replaces this with the fixed-task evaluation runner. */
export async function runEvals(): Promise<EvalRunSummary> {
  return { status: "stub", tasks: 0 };
}
