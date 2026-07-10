import type { ModelTokenUsage } from "../harness/model-provider.js";
import type { TaskClass } from "../harness/routing.js";
import type { CriterionGrade } from "./graders/independent-grader.js";

export const EVAL_RESULT_SCHEMA_VERSION = 1 as const;

export interface EvalModelCallRecord {
  requestedModel: string;
  exactModels: string[];
  stopReason: string | null;
  usage: ModelTokenUsage;
  costUsd: number;
}

export interface EvalCandidateRecord extends EvalModelCallRecord {
  output: string;
  attempts: EvalModelCallRecord[];
}

export interface EvalGradeRecord extends EvalModelCallRecord {
  pass: boolean;
  criteria: CriterionGrade[];
}

export interface EvalTaskResult {
  taskId: string;
  taskClass: TaskClass;
  predictedCostUsd: number;
  actualCostUsd: number;
  candidate: EvalCandidateRecord;
  grade: EvalGradeRecord;
  score: number;
}

export interface EvalRunTotals {
  tasks: number;
  criteria: number;
  passed: number;
  score: number;
}

export interface EvalRunResult {
  schemaVersion: typeof EVAL_RESULT_SCHEMA_VERSION;
  runId: string;
  startedAt: string;
  completedAt: string;
  pricingDate: string;
  provider: string;
  predictedCostUsd: number;
  actualCostUsd: number;
  totals: EvalRunTotals;
  taskResults: EvalTaskResult[];
}

export function calculateTotals(taskResults: readonly EvalTaskResult[]): EvalRunTotals {
  const criteria = taskResults.reduce((sum, task) => sum + task.grade.criteria.length, 0);
  const passed = taskResults.reduce(
    (sum, task) => sum + task.grade.criteria.filter((criterion) => criterion.pass).length,
    0
  );
  return {
    tasks: taskResults.length,
    criteria,
    passed,
    score: criteria === 0 ? 0 : passed / criteria
  };
}
