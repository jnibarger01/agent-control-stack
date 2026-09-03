import {
  createPolicyEngine,
  createWorkItemTools,
  evaluateVerificationRequirement
} from "@agent-control-stack/policy-gate";
import {
  ExecutionLearningBridge,
  ProceduralLearning,
  type InjectedSkill
} from "@agent-control-stack/procedural-learning";
import { executeSandboxed, type SandboxResult } from "@agent-control-stack/sandbox";
import { ControlStackError, domainHash, stableHash } from "@agent-control-stack/shared";
import {
  admittedPlanHash,
  capabilityProfileHash,
  validationProfileHash,
  workspaceIdentityFromContainment,
  type AdmittedPlanBinding
} from "@agent-control-stack/advisory";
import { buildEvidenceManifest, computeWorkspaceRevision, observation } from "@agent-control-stack/evidence";
import {
  resolveExecutionBackend,
  SqliteWorkItemStore,
  type ClaimedWorkItem,
  type ExecutionBackend,
  type WorkItem,
  type WorkItemStore
} from "@agent-control-stack/work-items";
import { WorkspaceManager } from "@agent-control-stack/workspace-manager";
import {
  authorizationDeniedEvent,
  authorizationGrantedEvent,
  authorizationRequestedEvent,
  authorizeDesktopCommanderExecution,
  desktopCommanderAdapterConfigFromEnv,
  DesktopCommanderMachineExecutor,
  executionCompletedEvent,
  executionStartedEvent,
  resultPersistedEvent,
  toolCalledEvent,
  toolOutcomeEvent,
  type AuditEventDraft,
  type ExecutionAuthorization,
  type MachineExecutionResult,
  type MachineExecutor
} from "@agent-control-stack/desktop-commander-adapter";

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
  /** Override the configured backend (tests only). */
  executionBackend?: ExecutionBackend;
  /** Inject a machine executor (tests only). */
  machineExecutor?: MachineExecutor;
}

export interface WorkerResult {
  executed: boolean;
  executionMode?: "dry_run" | "desktop_commander";
  workItemId?: string;
  reason?: string;
  retrievedSkills?: InjectedSkill[];
  usedSkills?: string[];
  validationPassed?: boolean;
}

export const DRY_RUN_EXECUTION_MODE = "dry_run" as const;
export const DESKTOP_COMMANDER_EXECUTION_MODE = "desktop_commander" as const;
const WORKER_VERSION = "acs-worker.0.1.0";

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
 * Single guard for both execution paths. A result's `executionMode` must match
 * the backend the worker was explicitly configured with. There is no automatic
 * downgrade from a validation failure to a permissive mode.
 */
export function assertExecutionModeForBackend(
  mode: unknown,
  backend: ExecutionBackend,
  nodeEnv = process.env.NODE_ENV
): void {
  if (backend === "dry_run") {
    assertDryRunExecutionMode(mode, nodeEnv);
    return;
  }
  if (backend === "desktop_commander") {
    if (mode !== DESKTOP_COMMANDER_EXECUTION_MODE) {
      throw new Error("desktop_commander backend requires desktop_commander execution mode");
    }
    return;
  }
  throw new Error(`unknown execution backend: ${String(backend)}`);
}

/**
 * The one-shot worker is the first safe execution slice. In the default
 * (dry_run) backend it may only simulate filesystem inspection. Approval alone
 * must never turn a mutation into a successful worker result.
 */
/**
 * ADR 0015 verification policy mode. `off` (default) keeps the existing
 * behaviour: no evidence manifest, no verification requirement, the result
 * acceptance guard is inert. `enforce` records an ACS-owned evidence manifest
 * and verification requirement for every governed desktop_commander execution,
 * and leaves the attempt awaiting an independent reviewer + ACS decision when
 * reviewers are required.
 */
export type VerificationPolicyMode = "off" | "enforce";
export function resolveVerificationPolicyMode(env: NodeJS.ProcessEnv = process.env): VerificationPolicyMode {
  const raw = env.ACS_VERIFICATION_POLICY?.trim();
  if (raw === undefined || raw === "" || raw === "off") return "off";
  if (raw === "enforce") return "enforce";
  throw new ControlStackError("verification_policy_mode_invalid", `unknown ACS_VERIFICATION_POLICY: ${raw}`);
}

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
  const executionBackend = options.executionBackend ?? resolveExecutionBackend();
  const workItems = new SqliteWorkItemStore(dbPath);
  const learning = options.learning ?? new ProceduralLearning(dbPath);
  const ownsLearning = options.learning === undefined;
  const tools = createWorkItemTools(workItems, createPolicyEngine());
  const workerId = options.workerId ?? "local-worker";
  const execute: WorkerExecute = options.execute ?? (async (item) => executeSandboxed(item));

  let cleanupWorkspace:
    { workItemId: string; attemptId: string; leaseId: string; workerId: string; fencingEpoch: number } | undefined;

  // --- Desktop Commander backend: fail-closed startup probe BEFORE claiming ---
  let machineExecutor: MachineExecutor | undefined = options.machineExecutor;
  let ownsMachineExecutor = false;
  if (executionBackend === "desktop_commander" && !machineExecutor) {
    const adapterConfig = desktopCommanderAdapterConfigFromEnv();
    if (!adapterConfig) {
      workItems.close();
      if (ownsLearning) learning.close();
      throw new Error(
        "ACS_EXECUTION_BACKEND=desktop_commander but the Desktop Commander adapter is not configured (see ACS_DESKTOP_COMMANDER_*)"
      );
    }
    const executor = new DesktopCommanderMachineExecutor(adapterConfig);
    try {
      await executor.preflight();
    } catch (error) {
      await executor.close().catch(() => undefined);
      workItems.close();
      if (ownsLearning) learning.close();
      throw new Error(`Desktop Commander preflight failed: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error
      });
    }
    machineExecutor = executor;
    ownsMachineExecutor = true;
  }

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

    if (executionBackend === "desktop_commander") {
      return await runDesktopCommanderExecution({
        workItems,
        tools,
        running,
        workerId,
        startedAt,
        machineExecutor: machineExecutor!
      });
    }

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
    assertExecutionModeForBackend(result.executionMode, executionBackend);
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
          ? `result validation failed: ${
              validation?.checks
                .filter((check) => !check.passed)
                .map((check) => check.name)
                .join(", ") || "unspecified check"
            }`
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
      if (ownsMachineExecutor && machineExecutor) {
        await machineExecutor.close().catch(() => undefined);
      }
      if (ownsLearning) learning.close();
      workItems.close();
    }
  }
}

interface DesktopCommanderExecutionInput {
  workItems: WorkItemStore;
  tools: ReturnType<typeof createWorkItemTools>;
  running: ClaimedWorkItem;
  workerId: string;
  startedAt: string;
  machineExecutor: MachineExecutor;
}

async function runDesktopCommanderExecution(input: DesktopCommanderExecutionInput): Promise<WorkerResult> {
  const { workItems, tools, running, workerId, startedAt, machineExecutor } = input;
  const attemptId = running.attemptId!;
  const requestId = `dcexec_${running.leaseId}_${running.fencingEpoch}`;

  const emit = (draft: AuditEventDraft): void => {
    workItems.recordExecutionEvent({
      name: draft.name,
      workItemId: running.id,
      body: draft.body,
      attributes: draft.attributes
    });
  };

  // --- Phase 12: a failed audit precondition blocks execution -----------------
  emit(authorizationRequestedEvent({ workItemId: running.id, workerId, requestId, toolName: "<pending>" }));

  // Trusted state re-read from the authoritative store (never transport input).
  const trustedWorkItem = workItems.get(running.id);
  if (!trustedWorkItem) {
    throw new Error(`work item ${running.id} disappeared before execution`);
  }
  const plan = workItems.getCurrentExecutionPlan(running.id);
  if (!plan || plan.definition.constraints.executionMode !== "desktop_commander") {
    emit(
      authorizationDeniedEvent({
        workItemId: running.id,
        workerId,
        requestId,
        code: "plan_execution_mode_mismatch",
        reason: `admitted plan execution mode is ${plan?.definition.constraints.executionMode ?? "missing"}`
      })
    );
    return submitDesktopCommanderFailure(input, requestId, "plan_execution_mode_mismatch");
  }
  const lease = workItems.getActiveLeaseForAttempt(attemptId);
  if (!lease) {
    emit(
      authorizationDeniedEvent({
        workItemId: running.id,
        workerId,
        requestId,
        code: "lease_missing",
        reason: "no active attempt lease"
      })
    );
    return submitDesktopCommanderFailure(input, requestId, "lease_missing");
  }

  let authorization;
  try {
    authorization = authorizeDesktopCommanderExecution({
      claimed: running,
      trustedWorkItem,
      lease,
      workerId,
      containment: machineExecutorContainmentFromEnv(),
      requestId
    });
  } catch (error) {
    const code =
      error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "authorization_failed";
    emit(
      authorizationDeniedEvent({
        workItemId: running.id,
        workerId,
        requestId,
        code,
        reason: error instanceof Error ? error.message : String(error)
      })
    );
    return submitDesktopCommanderFailure(input, requestId, code);
  }

  emit(authorizationGrantedEvent(authorization));
  emit(executionStartedEvent(authorization));
  emit(toolCalledEvent(authorization));

  const executionResult = await machineExecutor.execute({ authorization });

  emit(
    toolOutcomeEvent(authorization, {
      ok: !executionResult.isError,
      durationMs: executionResult.durationMs,
      resultHash: executionResult.resultHash,
      truncated: executionResult.truncated,
      isError: executionResult.isError
    })
  );

  const finishedAt = executionResult.completedAt;
  const ok = !executionResult.isError;
  const submittedExecutionMode: typeof DESKTOP_COMMANDER_EXECUTION_MODE = DESKTOP_COMMANDER_EXECUTION_MODE;
  assertExecutionModeForBackend(submittedExecutionMode, "desktop_commander");

  // --- ADR 0015: machine evidence + verification requirement (gated) ---------
  if (ok && resolveVerificationPolicyMode() === "enforce") {
    const awaiting = await recordGovernedExecutionEvidence({
      workItems,
      running,
      plan,
      trustedWorkItem,
      lease,
      authorization,
      executionResult,
      workerId,
      startedAt,
      finishedAt
    });
    if (awaiting) {
      return {
        executed: true,
        executionMode: "desktop_commander",
        workItemId: running.id,
        reason: "awaiting_independent_verification"
      };
    }
  }

  try {
    tools.submit_work_result({
      workItemId: running.id,
      attemptId,
      leaseId: running.leaseId,
      workerId,
      actionHash: authorization.actionHash,
      planHash: running.planHash,
      inputHash: running.inputHash,
      fencingEpoch: running.fencingEpoch,
      idempotencyKey: workerResultIdempotencyKey(attemptId),
      outcome: ok ? "succeeded" : "failed",
      startedAt,
      finishedAt,
      exitCode: ok ? 0 : null,
      summary: ok
        ? `desktop_commander ${authorization.toolName} completed`
        : `desktop_commander ${authorization.toolName} failed`,
      stdout: executionResult.output,
      ...(ok ? {} : { error: executionResult.error ?? "desktop_commander tool failed" }),
      structuredOutput: {
        simulated: false,
        tool: authorization.toolName,
        resultHash: executionResult.resultHash,
        truncated: executionResult.truncated,
        durationMs: executionResult.durationMs
      },
      artifacts: [],
      simulationMetadata: {
        executionMode: "desktop_commander",
        simulated: false,
        backend: "desktop-commander-mcp",
        toolName: authorization.toolName,
        invocationFingerprint: authorization.invocationFingerprint,
        requestId,
        ...(authorization.approvalId ? { approvalId: authorization.approvalId } : {}),
        workerVersion: WORKER_VERSION
      }
    });
  } catch (error) {
    // The machine action executed but persistence failed. Report accurately and
    // fail closed for lifecycle advancement.
    emit(
      authorizationDeniedEvent({
        workItemId: running.id,
        workerId,
        requestId,
        toolName: authorization.toolName,
        code: "result_persistence_failed",
        reason: error instanceof Error ? error.message : String(error)
      })
    );
    throw new Error(
      `desktop_commander tool executed but result persistence failed for ${running.id}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }

  emit(resultPersistedEvent(authorization, executionResult.resultHash));
  emit(executionCompletedEvent(authorization, { ok, resultHash: executionResult.resultHash }));

  return {
    executed: true,
    executionMode: "desktop_commander",
    workItemId: running.id,
    reason: workerId,
    validationPassed: ok
  };
}

function submitDesktopCommanderFailure(
  input: DesktopCommanderExecutionInput,
  requestId: string,
  code: string
): WorkerResult {
  const { workItems, running, workerId, startedAt } = input;
  const attemptId = running.attemptId!;
  workItems.recordDerivedWorkResult({
    workItemId: running.id,
    leaseId: running.leaseId,
    workerId,
    actionHash: running.actionHash,
    attemptId,
    planHash: running.planHash,
    inputHash: running.inputHash,
    fencingEpoch: running.fencingEpoch,
    idempotencyKey: workerResultIdempotencyKey(attemptId),
    outcome: "blocked",
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: null,
    summary: `desktop_commander execution authorization denied: ${code}`,
    error: code,
    structuredOutput: { simulated: false, blocked: true, reason: code },
    artifacts: [],
    simulationMetadata: { executionMode: "dry_run", simulated: true, reason: code }
  });
  return { executed: false, workItemId: running.id, reason: `desktop_commander authorization denied: ${code}` };
}

interface GovernedEvidenceInput {
  workItems: WorkItemStore;
  running: ClaimedWorkItem;
  plan: { planId: string; planHash: string };
  trustedWorkItem: Pick<WorkItem, "id" | "risk" | "requestedActions" | "target">;
  lease: { policyVersion: string };
  authorization: ExecutionAuthorization;
  executionResult: MachineExecutionResult;
  workerId: string;
  startedAt: string;
  finishedAt: string;
}

/**
 * ADR 0015: build + record an ACS-owned evidence manifest and a verification
 * requirement for a governed desktop_commander execution. Returns `true` when
 * the attempt must await an independent reviewer + ACS verification decision
 * (reviewers required), in which case the caller does NOT submit a result and
 * the `submitWorkResult` guard keeps `succeeded` unreachable until a decision.
 */
async function recordGovernedExecutionEvidence(input: GovernedEvidenceInput): Promise<boolean> {
  const { workItems, running, plan, trustedWorkItem, lease, authorization, executionResult } = input;
  const attemptId = running.attemptId!;
  const via = { via: "domain_service" as const, actorId: input.workerId };
  const containment = machineExecutorContainmentFromEnv();
  const allowedRoot = containment.allowedRoots[0] ?? "none";
  const workspaceId = workspaceIdentityFromContainment(containment.allowedRoots);

  let baseRevision = `unavailable:${domainHash("acs:no-workspace:v1", { attemptId })}`;
  try {
    baseRevision = (await computeWorkspaceRevision(allowedRoot)).revision;
  } catch {
    // Not a git worktree — the sentinel revision is deterministic and honest.
  }

  const binding: AdmittedPlanBinding = {
    schemaVersion: "acs.admitted-plan.v1",
    workItemId: running.id,
    proposalHash: null,
    executionPlanHash: plan.planHash,
    requestedActionsHash: domainHash("acs:requested-actions:v1", trustedWorkItem.requestedActions),
    workspace: { workspaceId, baseRevision },
    sandboxProfile: "desktop_commander",
    networkProfile: "none",
    capabilityProfileHash: capabilityProfileHash([authorization.toolName]),
    validationProfileHash: validationProfileHash({}),
    policyVersion: lease.policyVersion
  };
  const boundPlanHash = admittedPlanHash(binding);

  const manifest = buildEvidenceManifest({
    attemptId,
    workItemId: running.id,
    admittedPlanHash: boundPlanHash,
    planHash: plan.planHash,
    actionHash: authorization.actionHash,
    baseWorkspaceRevision: baseRevision,
    resultWorkspaceRevision: baseRevision,
    changedPaths: [...authorization.canonicalPaths],
    diffHash: executionResult.resultHash || domainHash("acs:no-diff:v1", { attemptId }),
    commands: [
      {
        executable: authorization.toolName,
        argvHash: domainHash("acs:dc-argv:v1", authorization.normalizedArguments),
        exitCode: executionResult.isError ? 1 : 0,
        stdoutHash: executionResult.resultHash || domainHash("acs:empty:v1", {}),
        stderrHash: domainHash("acs:empty:v1", {}),
        durationMs: executionResult.durationMs
      }
    ],
    testEvidence: null,
    sandboxProfile: "desktop_commander",
    networkProfile: "none",
    networkDecisions: { allowed: 0, denied: 0 },
    observations: [
      observation("desktop_commander.result_hash", "execution-controller", executionResult.resultHash),
      observation("desktop_commander.truncated", "execution-controller", executionResult.truncated),
      observation("workspace.identity", "execution-controller", workspaceId)
    ],
    workerId: input.workerId,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt
  });

  workItems.recordAttemptPhase({ attemptId, workItemId: running.id, phase: "collecting_evidence" }, via);
  workItems.recordEvidenceManifest(
    {
      manifestHash: manifest.manifestHash,
      attemptId,
      workItemId: running.id,
      admittedPlanHash: boundPlanHash,
      planHash: plan.planHash,
      actionHash: authorization.actionHash,
      baseWorkspaceRevision: baseRevision,
      resultWorkspaceRevision: baseRevision,
      manifest: manifest as unknown as Record<string, unknown>
    },
    via
  );

  const requirement = evaluateVerificationRequirement({
    riskClass: trustedWorkItem.risk,
    actionKinds: trustedWorkItem.requestedActions.map((a) => a.kind),
    executorPrincipalId: input.workerId,
    executorProvider: "desktop-commander"
  });
  workItems.recordVerificationRequirement(
    {
      attemptId,
      workItemId: running.id,
      policyVersion: requirement.policyVersion,
      reviewersRequired: requirement.reviewersRequired,
      requirement: requirement as unknown as Record<string, unknown>
    },
    via
  );

  if (requirement.reviewersRequired === 0) {
    workItems.recordVerificationDecision(
      {
        attemptId,
        workItemId: running.id,
        outcome: "attempt_accepted",
        evidenceManifestHash: manifest.manifestHash,
        reviewFindingHashes: [],
        verificationPolicyVersion: requirement.policyVersion
      },
      via
    );
    workItems.recordAttemptPhase({ attemptId, workItemId: running.id, phase: "accepted" }, via);
    return false;
  }

  // Pause here. Reviewer submission + ACS verification resolution are a later
  // control-plane milestone (ADR 0015). Terminal success stays blocked until
  // ACS records an attempt_accepted decision.
  workItems.recordAttemptPhase(
    {
      attemptId,
      workItemId: running.id,
      phase: "reviewing",
      note: `awaiting ${requirement.reviewersRequired} independent reviewer(s)`
    },
    via
  );
  return true;
}

function machineExecutorContainmentFromEnv(): { allowedRoots: string[]; deniedRoots: string[] } {
  const config = desktopCommanderAdapterConfigFromEnv();
  if (!config) {
    throw new Error("Desktop Commander adapter configuration is unavailable");
  }
  return { allowedRoots: config.allowedRoots, deniedRoots: config.deniedRoots };
}

export function workerResultIdempotencyKey(attemptId: string): string {
  return stableHash({ domain: "acs.attempt-result.v1", attemptId });
}
