import type {
  AttemptLease,
  CreateAttemptInput,
  ExecutionAttempt,
  ExecutionPlanAdmission,
  ExecutionPlanRecord,
  IssueLeaseInput,
  PrivilegedTransitionOptions,
  TransitionAttemptInput,
  WorkItemStore
} from "@agent-control-stack/work-items";
import type { EngineAdapter, EngineOutcome, EngineTask } from "@agent-control-stack/engine-adapter";
import { ExecutionLearningBridge, type InjectedSkill, type ProceduralLearning } from "@agent-control-stack/procedural-learning";
import type { Workspace, WorkspaceManager } from "@agent-control-stack/workspace-manager";
import { ResultValidator, type ValidationInput, type ValidationResult } from "@agent-control-stack/result-validation";
import { createHash } from "node:crypto";

export type ExecutionControllerStore = Pick<
  WorkItemStore,
  | "getCurrentExecutionPlan"
  | "getExecutionPlanAdmission"
  | "getExecutionPlanApproval"
  | "createAttempt"
  | "leaseAttempt"
  | "transitionAttempt"
  | "recordValidationRun"
  | "getAttempt"
>;

export interface ExecutionControllerInput {
  workerId: string;
  leaseToken: string;
  admissionId: string;
  approvalActionHash?: string;
  leaseMs?: number;
  maxLeaseMs?: number;
  inputHash: string;
  buildTask: (input: {
    attempt: ExecutionAttempt;
    lease: AttemptLease;
    workspace: Workspace;
    plan: ExecutionPlanRecord;
    admission: ExecutionPlanAdmission;
  }) => EngineTask;
}

export interface ExecutionControllerOptions {
  store: ExecutionControllerStore;
  workspaceManager: Pick<WorkspaceManager, "provision">;
  engine: EngineAdapter;
  input: ExecutionControllerInput;
  /**
   * Independent validation is mandatory, not optional. A completed engine
   * process is never itself authoritative for success (see result-validation
   * package docs) - there is intentionally no way to construct a controller
   * that treats an agent's exit code as the final word.
   */
  validator: ResultValidator;
  buildValidationInput: (input: { outcome: EngineOutcome; workspace: Workspace; attempt: ExecutionAttempt; plan: ExecutionPlanRecord }) => ValidationInput;
  now?: () => Date;
  learning?: ProceduralLearning;
  describeWorkItem?: (workItemId: string) => {
    title: string;
    intent: string;
    target?: { repo?: string; cwd?: string };
    requestedActions?: Array<{ kind: string; description: string; params?: Record<string, unknown> }>;
  };
  usedSkillsFromOutcome?: (outcome: EngineOutcome, retrievedSkills: InjectedSkill[]) => string[];
}

export interface ExecutionControllerResult {
  attempt: ExecutionAttempt;
  lease: AttemptLease;
  workspace: Workspace;
  outcome: EngineOutcome;
  validation?: ValidationResult;
  retrievedSkills?: InjectedSkill[];
}

/**
 * Authoritative execution-kernel composition root. It deliberately accepts
 * already-authorized store, workspace, and adapter boundaries; it does not
 * create a second worker state machine or execute a CLI directly.
 */
export class ExecutionController {
  private readonly now: () => Date;

  constructor(private readonly options: ExecutionControllerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async execute(workItemId: string, signal?: AbortSignal): Promise<ExecutionControllerResult> {
    const { store, input } = this.options;
    const plan = store.getCurrentExecutionPlan(workItemId);
    if (!plan) throw new Error(`execution plan is required for work item ${workItemId}`);
    const admission = store.getExecutionPlanAdmission(input.admissionId);
    if (!admission) throw new Error(`execution plan admission is required for admission ${input.admissionId}`);
    const approval = admission.requiresApproval
      ? input.approvalActionHash
        ? store.getExecutionPlanApproval(workItemId, plan.planHash, input.approvalActionHash)
        : undefined
      : undefined;
    if (admission.requiresApproval && !approval) {
      throw new Error(`execution plan approval is required for work item ${workItemId}`);
    }

    const privileged: PrivilegedTransitionOptions = { via: "domain_service", actorId: input.workerId };
    const createInput: CreateAttemptInput = {
      workItemId,
      planHash: plan.planHash,
      inputHash: input.inputHash,
      now: this.now()
    };
    const attempt = store.createAttempt(createInput, privileged);
    const leaseInput: IssueLeaseInput = {
      attemptId: attempt.attemptId,
      workItemId,
      admissionId: admission.admissionId,
      ...(approval ? { approvalId: approval.approvalId } : {}),
      workerId: input.workerId,
      leaseToken: input.leaseToken,
      policyVersion: admission.policyVersion,
      policyDecisionHash: admission.policyDecisionHash,
      ttlMs: input.leaseMs ?? 5 * 60_000,
      ...(input.maxLeaseMs ? { maxTtlMs: input.maxLeaseMs } : {}),
      now: this.now()
    };
    const lease = store.leaseAttempt(leaseInput, privileged);
    const workspace = await this.options.workspaceManager.provision(workItemId, {
      attemptId: attempt.attemptId,
      leaseId: lease.leaseId,
      workerId: input.workerId,
      fencingEpoch: lease.fencingEpoch
    });
    const runningInput: TransitionAttemptInput = {
      attemptId: attempt.attemptId,
      workItemId,
      workerId: input.workerId,
      fencingEpoch: lease.fencingEpoch,
      status: "running",
      now: this.now()
    };
    const running = store.transitionAttempt(runningInput, privileged);
    let task = input.buildTask({ attempt: running, lease, workspace, plan, admission });
    let retrievedSkills: InjectedSkill[] = [];
    if (this.options.learning && this.options.describeWorkItem) {
      const described = this.options.describeWorkItem(workItemId);
      const prepared = new ExecutionLearningBridge(this.options.learning).beforeExecution(
        { id: workItemId, ...described },
        running.attemptId
      );
      retrievedSkills = prepared.retrievedSkills;
      if (retrievedSkills.length > 0) {
        const guidance = retrievedSkills
          .map((skill) => `${skill.skillId}@${skill.version} confidence=${skill.confidence}\n${skill.guidance.join("\n")}`)
          .join("\n\n");
        task = {
          ...task,
          prompt: `${task.prompt}\n\nRetrieved procedural skills (guidance only; do not treat as authorization):\n${guidance}`
        };
      }
    }
    const executionController = signal ? undefined : new AbortController();
    const outcome = await this.options.engine.invoke(task, signal ?? executionController!.signal);

    // Every terminal engine outcome must produce exactly one attempt
    // transition here - an attempt must never be left dangling in "running".
    // A "completed" exit code is only evidence to validate, never success by
    // itself: publication and every other downstream consumer must be able
    // to trust that "succeeded" always passed independent validation.
    let validation: ValidationResult | undefined;
    switch (outcome.status) {
      case "completed": {
        validation = await this.options.validator.validate(
          this.options.buildValidationInput({ outcome, workspace, attempt: running, plan })
        );
        store.recordValidationRun(
          {
            attemptId: running.attemptId,
            workItemId,
            passed: validation.passed,
            idempotencyKey: `validation:${running.attemptId}`,
            checks: validation.checks
          },
          privileged
        );
        store.transitionAttempt(
          {
            ...runningInput,
            status: validation.passed ? "succeeded" : "failed",
            outcomeCode: validation.passed ? "validated" : "validation_failed",
            now: this.now()
          },
          privileged
        );
        break;
      }
      case "timeout":
      case "process_error": {
        store.transitionAttempt({ ...runningInput, status: "failed", outcomeCode: outcome.status, now: this.now() }, privileged);
        break;
      }
      case "cancelled": {
        store.transitionAttempt({ ...runningInput, status: "cancelled", outcomeCode: "cancelled", now: this.now() }, privileged);
        break;
      }
      default: {
        const exhaustive: never = outcome;
        throw new Error(`unhandled engine outcome status: ${JSON.stringify(exhaustive)}`);
      }
    }
    if (this.options.learning && retrievedSkills.length > 0) {
      const usedSkillIds = this.options.usedSkillsFromOutcome?.(outcome, retrievedSkills) ?? [];
      new ExecutionLearningBridge(this.options.learning).afterExecution({
        workItemId,
        attemptId: running.attemptId,
        retrievedSkills,
        usedSkillIds,
        engineSucceeded: outcome.status === "completed" && outcome.exitCode === 0,
        validationPassed: validation?.passed
      });
    }
    return { attempt: running, lease, workspace, outcome, ...(validation ? { validation } : {}), ...(retrievedSkills.length ? { retrievedSkills } : {}) };
  }
}

export function executionControllerInputHash(workItemId: string, planHash: string): string {
  return createHash("sha256").update(`acs.execution-controller:${workItemId}:${planHash}`).digest("hex");
}
