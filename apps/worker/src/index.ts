import { createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
import {
  ExecutionLearningBridge,
  ProceduralLearning,
  type InjectedSkill
} from "@agent-control-stack/procedural-learning";
import { executeSandboxed, type SandboxResult } from "@agent-control-stack/sandbox";
import { stableHash } from "@agent-control-stack/shared";
import { SqliteWorkItemStore, type WorkItem } from "@agent-control-stack/work-items";
import { WorkspaceManager } from "@agent-control-stack/workspace-manager";

export interface WorkerExecuteResult extends SandboxResult {
  usedSkillNames?: string[];
}

export type WorkerExecute = (
  workItem: WorkItem & { retrievedSkills: InjectedSkill[]; workspace?: unknown }
) => Promise<WorkerExecuteResult>;

export interface WorkerValidator {
  validate(input: {
    workItemId: string;
    attemptId: string;
    outcome: WorkerExecuteResult;
    retrievedSkills: InjectedSkill[];
  }): Promise<{ passed: boolean; checks: Array<{ name: string; passed: boolean; detail: string }> }>;
}

export interface WorkerOptions {
  dbPath?: string;
  workerId?: string;
  execute?: WorkerExecute;
  workspaceManager?: WorkspaceManager;
  learning?: ProceduralLearning;
  validator?: WorkerValidator;
}

export interface WorkerResult {
  executed: boolean;
  executionMode?: "dry_run";
  workItemId?: string;
  reason?: string;
  retrievedSkills?: InjectedSkill[];
  usedSkills?: string[];
  validationPassed?: boolean;
}

export const DRY_RUN_EXECUTION_MODE = "dry_run" as const;

export function assertDryRunExecutionMode(
  mode: unknown,
  nodeEnv = process.env.NODE_ENV
): asserts mode is typeof DRY_RUN_EXECUTION_MODE {
  if (mode === DRY_RUN_EXECUTION_MODE) {
    return;
  }
  if (nodeEnv === "production") {
    throw new Error("production worker requires dry_run execution mode");
  }
  throw new Error("worker requires dry_run execution mode");
}

/**
 * The one-shot worker is the first safe execution slice. Until authoritative
 * attempt/workspace wiring is complete, it may only simulate filesystem
 * inspection. Approval alone must never turn a mutation into a successful
 * worker result.
 */
const readOnlyWorkerActionKinds = new Set(["system.status", "fs.list", "fs.stat", "fs.read", "fs.search_name"]);

export function isReadOnlyWorkerWorkItem(workItem: Pick<WorkItem, "requestedActions">): boolean {
  return (
    workItem.requestedActions.length > 0 &&
    workItem.requestedActions.every(
      (action) =>
        readOnlyWorkerActionKinds.has(action.kind) &&
        action.params.write !== true &&
        action.params.destructive !== true &&
        action.params.network !== true &&
        action.params.allowNetwork !== true
    )
  );
}

export async function runWorkerOnce(options: WorkerOptions = {}): Promise<WorkerResult> {
  const dbPath = options.dbPath ?? process.env.ACS_DB_PATH ?? "storage/local.db";
  const workItems = new SqliteWorkItemStore(dbPath);
  const learning = options.learning ?? new ProceduralLearning(dbPath);
  const ownsLearning = options.learning === undefined;
  const tools = createWorkItemTools(workItems, createPolicyEngine());
  const workerId = options.workerId ?? "local-worker";
  const execute: WorkerExecute = options.execute ?? (async (item) => executeSandboxed(item));
  let cleanupWorkspace:
    { workItemId: string; attemptId: string; leaseId: string; workerId: string; fencingEpoch: number } | undefined;

  try {
    workItems.failExpiredLeases();
    const running = tools.claim_next_approved_work_item({ workerId });
    if (!running) {
      return { executed: false, reason: "no approved work item" };
    }
    if (running.status === "blocked") {
      return { executed: false, workItemId: running.id, reason: "blocked by policy" };
    }
    if (!running.attemptId || !running.planHash || !running.inputHash || running.fencingEpoch === undefined) {
      throw new Error("worker claim did not include persisted attempt authority");
    }

    const workspace = running.attemptId
      ? await options.workspaceManager?.provision(running.id, {
          attemptId: running.attemptId,
          leaseId: running.leaseId,
          workerId,
          fencingEpoch: running.fencingEpoch
        })
      : undefined;
    if (workspace && running.attemptId) {
      cleanupWorkspace = {
        workItemId: running.id,
        attemptId: running.attemptId,
        leaseId: running.leaseId,
        workerId,
        fencingEpoch: running.fencingEpoch
      };
    }
    const startedAt = new Date().toISOString();
    if (!isReadOnlyWorkerWorkItem(running)) {
      const completedAt = new Date().toISOString();
      workItems.recordDerivedWorkResult({
        workItemId: running.id,
        leaseId: running.leaseId,
        workerId,
        actionHash: running.actionHash,
        attemptId: running.attemptId,
        planHash: running.planHash,
        inputHash: running.inputHash,
        fencingEpoch: running.fencingEpoch,
        idempotencyKey: workerResultIdempotencyKey(running.attemptId),
        outcome: "blocked",
        startedAt,
        finishedAt: completedAt,
        exitCode: null,
        summary: "worker supports read-only repository inspection only; no command ran",
        error: "worker_read_only_scope",
        structuredOutput: { simulated: true, blocked: true, reason: "worker_read_only_scope" },
        artifacts: [],
        simulationMetadata: {
          executionMode: "dry_run",
          simulated: true,
          reason: "worker_read_only_scope"
        }
      });
      return {
        executed: false,
        workItemId: running.id,
        reason: "worker supports read-only repository inspection only"
      };
    }

    const bridge = new ExecutionLearningBridge(learning);
    const prepared = bridge.beforeExecution(running, running.attemptId);
    const result = await execute({
      ...running,
      retrievedSkills: prepared.retrievedSkills,
      ...(workspace ? { workspace } : {})
    });
    assertDryRunExecutionMode(result.executionMode);
    const completedAt = new Date().toISOString();
    const usedSkills = result.usedSkillNames ?? [];
    const validation = options.validator
      ? await options.validator.validate({
          workItemId: running.id,
          attemptId: running.attemptId,
          outcome: result,
          retrievedSkills: prepared.retrievedSkills
        })
      : undefined;
    const learningRecord = bridge.afterExecution({
      workItemId: running.id,
      attemptId: running.attemptId,
      repository: running.target?.repo ?? running.target?.cwd,
      retrievedSkills: prepared.retrievedSkills,
      usedSkillIds: usedSkills,
      engineSucceeded: result.ok,
      validationPassed: validation?.passed
    });
    const learningOutput = {
      simulated: true,
      retrievedSkills: prepared.retrievedSkills.map((skill) => ({
        skillId: skill.skillId,
        version: skill.version,
        confidence: skill.confidence
      })),
      usedSkills,
      validationPassed: validation?.passed ?? null
    };

    const validationFailed = validation !== undefined && validation.passed === false;
    if (result.ok && !validationFailed) {
      tools.submit_work_result({
        workItemId: running.id,
        attemptId: running.attemptId,
        leaseId: running.leaseId,
        workerId,
        actionHash: running.actionHash,
        planHash: running.planHash,
        inputHash: running.inputHash,
        fencingEpoch: running.fencingEpoch,
        idempotencyKey: workerResultIdempotencyKey(running.attemptId),
        outcome: "succeeded",
        startedAt,
        finishedAt: completedAt,
        exitCode: 0,
        summary: "dry-run simulation completed; no real command ran",
        stdout: result.output,
        structuredOutput: learningOutput,
        artifacts: [],
        simulationMetadata: { executionMode: result.executionMode, simulated: true }
      });
    } else {
      tools.submit_work_result({
        workItemId: running.id,
        attemptId: running.attemptId,
        leaseId: running.leaseId,
        workerId,
        actionHash: running.actionHash,
        planHash: running.planHash,
        inputHash: running.inputHash,
        fencingEpoch: running.fencingEpoch,
        idempotencyKey: workerResultIdempotencyKey(running.attemptId),
        outcome: "failed",
        startedAt,
        finishedAt: completedAt,
        exitCode: null,
        summary: validationFailed
          ? "dry-run simulation completed but result validation failed"
          : "dry-run simulation failed; no real command ran",
        error: validationFailed
          ? `result validation failed: ${validation?.checks
              .filter((check) => !check.passed)
              .map((check) => check.name)
              .join(", ") || "unspecified check"}`
          : (result.error ?? "dry-run sandbox simulation failed"),
        stdout: result.output,
        stderr: result.error,
        structuredOutput: learningOutput,
        artifacts: [],
        simulationMetadata: { executionMode: result.executionMode, simulated: true }
      });
    }

    return {
      executed: true,
      executionMode: result.executionMode,
      workItemId: running.id,
      reason: workerId,
      retrievedSkills: prepared.retrievedSkills,
      usedSkills: learningRecord.usedSkills,
      validationPassed: validation?.passed
    };
  } finally {
    try {
      if (cleanupWorkspace) {
        await options.workspaceManager?.teardown(cleanupWorkspace.workItemId, {
          attemptId: cleanupWorkspace.attemptId,
          leaseId: cleanupWorkspace.leaseId,
          workerId: cleanupWorkspace.workerId,
          fencingEpoch: cleanupWorkspace.fencingEpoch
        });
      }
    } finally {
      if (ownsLearning) learning.close();
      workItems.close();
    }
  }
}

export function workerResultIdempotencyKey(attemptId: string): string {
  return stableHash({ domain: "acs.attempt-result.v1", attemptId });
}
