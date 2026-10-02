import { z } from "zod";

const NARRATIVE_KEYS = new Set(["summary", "narrative", "notes", "reasoning"]);

export class DecisionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionStateError";
  }
}

export const operationStatusSchema = z.enum(["pending", "running", "completed", "failed", "blocked"]);

export const operationFactSchema = z
  .object({
    id: z.string().min(1),
    status: operationStatusSchema,
    kind: z.string().min(1).optional(),
    resultId: z.string().min(1).optional(),
    exitCode: z.number().int().optional(),
    deploymentId: z.string().min(1).optional(),
    dependsOn: z.array(z.string().min(1)).optional()
  })
  .strict();

export const decisionConstraintsSchema = z
  .object({
    requireHealthCheck: z.boolean().optional()
  })
  .strict();

export const decisionStateSchema = z
  .object({
    missionId: z.string().min(1),
    goal: z.string().min(1),
    operations: z.array(operationFactSchema),
    constraints: decisionConstraintsSchema.optional(),
    evidence: z.array(z.string().min(1))
  })
  .strict();

export type OperationFact = z.infer<typeof operationFactSchema>;
export type DecisionState = z.infer<typeof decisionStateSchema>;

function rejectNarrative(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectNarrative(entry, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (NARRATIVE_KEYS.has(key)) {
      throw new DecisionStateError(`narrative field rejected: ${path}${key}`);
    }
    rejectNarrative(entry, `${path}${key}.`);
  }
}

/** Facts only: ids, statuses, exit codes, and evidence refs. */
export function buildDecisionState(input: unknown): DecisionState {
  rejectNarrative(input, "");
  const state = decisionStateSchema.parse(input);
  const seen = new Set<string>();
  for (const operation of state.operations) {
    if (seen.has(operation.id)) {
      throw new DecisionStateError(`duplicate operation: ${operation.id}`);
    }
    seen.add(operation.id);
  }
  return state;
}

/** Level 0 completion. An empty operation list is not a completed mission. */
export function deterministicDone(state: DecisionState): boolean {
  if (state.operations.length === 0) return false;
  const operationsDone = state.operations.every(
    (operation) => operation.status === "completed" && (operation.exitCode === undefined || operation.exitCode === 0)
  );
  if (!operationsDone) return false;
  if (!state.constraints?.requireHealthCheck) return true;
  const healthPassed = state.operations.some(
    (operation) => operation.kind === "health_check" && operation.status === "completed" && operation.exitCode === 0
  );
  const healthEvidence = state.evidence.some((item) => item.startsWith("health:"));
  return healthPassed || healthEvidence;
}

export function dependencyReadyOperations(state: DecisionState): OperationFact[] {
  const byId = new Map(state.operations.map((operation) => [operation.id, operation]));
  return state.operations.filter((operation) => {
    if (operation.status !== "pending") return false;
    return (operation.dependsOn ?? []).every((id) => byId.get(id)?.status === "completed");
  });
}
