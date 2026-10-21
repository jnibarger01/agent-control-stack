import { outcomeHash } from "./canonical.js";
import {
  READ_ONLY_ACTIONS,
  type Criterion,
  type CriterionKind,
  type Plan,
  type PlanStep,
  type ReadOnlyAction
} from "./domain.js";

export class PlanError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "PlanError";
  }
}

/**
 * Who can run what. Every executor here is a pure function or a read-only port; there is deliberately no executor that
 * changes a pull request, so a probe kind with no entry has `no_eligible_executor` and the outcome cannot be accepted.
 */
export const PROBE_EXECUTORS: Readonly<Record<CriterionKind, string>> = {
  pr_open: "acs_pure_probe",
  merge_gate_eligible: "acs_pure_probe",
  required_checks_succeeded: "acs_pure_probe",
  files_within_scope: "acs_pure_probe",
  verification_surface_untouched: "acs_pure_probe"
};

export const FIXED_EXECUTORS: Readonly<Record<Exclude<ReadOnlyAction, "run_pure_probe">, string>> = {
  github_read_pr: "gh_readonly_reader",
  verify_audit_chain: "acs_audit_verifier",
  append_outcome_event: "acs_outcome_ledger"
};

export function assignExecutor(kind: string): string {
  const executor = (PROBE_EXECUTORS as Record<string, string | undefined>)[kind];
  if (executor === undefined)
    throw new PlanError("no_eligible_executor", `no read-only executor for criterion kind ${kind}`);
  return executor;
}

/** Pure and deterministic: the same criteria always compile to the same plan and the same planHash. */
export function compilePlan(criteria: readonly Pick<Criterion, "id" | "kind">[]): Plan {
  const probeSteps: PlanStep[] = criteria.map((criterion) => ({
    id: `probe.${criterion.id}`,
    action: "run_pure_probe",
    dependsOn: ["read_pr"],
    criterionId: criterion.id,
    kind: criterion.kind,
    executor: assignExecutor(criterion.kind)
  }));
  const steps: PlanStep[] = [
    { id: "read_pr", action: "github_read_pr", dependsOn: [], executor: FIXED_EXECUTORS.github_read_pr },
    { id: "verify_chain", action: "verify_audit_chain", dependsOn: [], executor: FIXED_EXECUTORS.verify_audit_chain },
    ...probeSteps,
    {
      id: "record",
      action: "append_outcome_event",
      dependsOn: ["verify_chain", ...probeSteps.map((step) => step.id)],
      executor: FIXED_EXECUTORS.append_outcome_event
    }
  ];
  const plan = { steps, planHash: outcomeHash("plan", steps) };
  validatePlan(plan);
  return plan;
}

/** Re-validates a plan read back from storage: closed action set, known executors, unique ids, no cycles. */
export function validatePlan(plan: Plan): void {
  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (!(READ_ONLY_ACTIONS as readonly string[]).includes(step.action)) {
      throw new PlanError("plan_action_not_read_only", `plan step ${step.id} has action ${step.action}`);
    }
    if (ids.has(step.id)) throw new PlanError("plan_duplicate_step", `duplicate plan step ${step.id}`);
    ids.add(step.id);
    if (step.action === "run_pure_probe") {
      if (!step.kind || assignExecutor(step.kind) !== step.executor) {
        throw new PlanError("plan_executor_mismatch", `plan step ${step.id} has an unexpected executor`);
      }
    } else if ((FIXED_EXECUTORS as Record<string, string>)[step.action] !== step.executor) {
      throw new PlanError("plan_executor_mismatch", `plan step ${step.id} has an unexpected executor`);
    }
  }
  const remaining = new Map(plan.steps.map((step) => [step.id, new Set(step.dependsOn)]));
  for (const [id, deps] of remaining) {
    for (const dep of deps)
      if (!ids.has(dep)) throw new PlanError("plan_unknown_dependency", `${id} depends on unknown ${dep}`);
  }
  // Kahn: repeatedly remove steps whose dependencies are all removed.
  let progressed = true;
  while (remaining.size > 0 && progressed) {
    progressed = false;
    for (const [id, deps] of remaining) {
      if ([...deps].every((dep) => !remaining.has(dep))) {
        remaining.delete(id);
        progressed = true;
      }
    }
  }
  if (remaining.size > 0) throw new PlanError("plan_cycle", "plan dependencies contain a cycle");
  if (outcomeHash("plan", plan.steps) !== plan.planHash)
    throw new PlanError("plan_hash_mismatch", "plan hash does not match its steps");
}
