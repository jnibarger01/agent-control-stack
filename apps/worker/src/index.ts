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
  parseStartedProcessPid,
  resolveCurrentProcessIdentity,
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

    if (result.ok) {
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
        summary: "dry-run simulation failed; no real command ran",
        error: result.error ?? "dry-run sandbox simulation failed",
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

  // --- ADR 0016 Slice 5: process-session ownership gate ----------------------
  // read_process_output is read_only / no-approval by tool-policy classification,
  // but that classification is about DATA sensitivity, not about WHO may read a
  // given live pid's output. Ownership is a separate, mandatory check: this
  // work item may read pid X's output only if it holds an active
  // dc_process_sessions row for the EXACT (pid, bootId, procStartTicks) triple
  // Slice 4 persisted when that process was started - never for a bare pid
  // match, since the OS reuses pids. Any failure to prove ownership - a
  // missing session, a mismatched boot/start-tick (pid reuse), an unresolvable
  // process identity, or a store error - denies the call. No raw
  // process-inspection or persistence error is ever let through into
  // execute(); it is translated into the same authorization-denied result the
  // rest of this function already uses.
  if (authorization.toolName === "read_process_output") {
    const denial = verifyReadProcessOutputOwnership(workItems, trustedWorkItem.id, authorization.normalizedArguments);
    if (denial) {
      emit(authorizationDeniedEvent({ workItemId: running.id, workerId, requestId, code: denial.code, reason: denial.reason }));
      return submitDesktopCommanderFailure(input, requestId, denial.code);
    }
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
  const dcOk = !executionResult.isError;
  const submittedExecutionMode: typeof DESKTOP_COMMANDER_EXECUTION_MODE = DESKTOP_COMMANDER_EXECUTION_MODE;
  assertExecutionModeForBackend(submittedExecutionMode, "desktop_commander");

  // --- ADR 0016 Slice 5: register the process-session on a successful start_process ---
  // A start_process call Desktop Commander reports as successful is NOT yet
  // safely usable: nothing owns the resulting pid until a dc_process_sessions
  // row is created for it. Only after that row is committed does any future
  // read_process_output call on this pid have anything to verify ownership
  // against - so if identity resolution or persistence fails here, the work
  // item result must say so plainly (outcome "failed") rather than reporting
  // the tool call as a success that produced an unowned, unauditable process.
  // A retry of a failed registration can never silently hand ownership of an
  // already-active process identity to a different work item: createProcessSession
  // is bound to the partial unique index on (pid, boot_id, proc_start_ticks)
  // WHERE status='active', so a second attempt against the same live process
  // conflicts rather than reassigning ownership.
  let sessionRegistrationFailure: { code: string; reason: string } | undefined;
  if (dcOk && authorization.toolName === "start_process") {
    sessionRegistrationFailure = registerStartedProcessSession(
      workItems,
      running.id,
      authorization.actionHash,
      workerId,
      executionResult.output
    );
    if (sessionRegistrationFailure) {
      emit(
        authorizationDeniedEvent({
          workItemId: running.id,
          workerId,
          requestId,
          code: sessionRegistrationFailure.code,
          reason: sessionRegistrationFailure.reason
        })
      );
    }
  }
  const ok = dcOk && sessionRegistrationFailure === undefined;

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
        : sessionRegistrationFailure
          ? `desktop_commander ${authorization.toolName} succeeded but process-session registration failed`
          : `desktop_commander ${authorization.toolName} failed`,
      stdout: executionResult.output,
      ...(ok
        ? {}
        : {
            error:
              sessionRegistrationFailure?.reason ?? executionResult.error ?? "desktop_commander tool failed"
          }),
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

/**
 * ADR 0016 Slice 5. Deny closed on: no numeric pid in the call, a process
 * identity that cannot be resolved from /proc (already exited, or /proc is
 * unreadable), a store lookup that throws instead of answering, or the
 * primitive itself reporting no active session for this exact
 * (pid, bootId, procStartTicks) triple owned by this work item. Never
 * authorizes on a bare pid match.
 */
function verifyReadProcessOutputOwnership(
  workItems: WorkItemStore,
  workItemId: string,
  normalizedArguments: Readonly<Record<string, unknown>>
): { code: string; reason: string } | undefined {
  const pidValue = normalizedArguments.pid;
  const pid = typeof pidValue === "number" ? pidValue : undefined;
  if (pid === undefined) {
    return { code: "process_ownership_pid_missing", reason: "read_process_output call carried no numeric pid" };
  }

  let identity: ReturnType<typeof resolveCurrentProcessIdentity>;
  try {
    identity = resolveCurrentProcessIdentity(pid);
  } catch (error) {
    return {
      code: "process_ownership_identity_unresolvable",
      reason: error instanceof Error ? error.message : String(error)
    };
  }

  let owned: boolean;
  try {
    owned = workItems.verifyProcessSessionOwnership({
      workItemId,
      pid: identity.pid,
      bootId: identity.bootId,
      procStartTicks: identity.procStartTicks
    });
  } catch (error) {
    // verifyProcessSessionOwnership is designed to return false rather than
    // throw for an ordinary mismatch; a thrown error here means the store
    // could not even answer the question. That ambiguity denies, it never
    // defaults to owned.
    return {
      code: "process_ownership_lookup_failed",
      reason: error instanceof Error ? error.message : String(error)
    };
  }
  if (!owned) {
    return {
      code: "process_ownership_denied",
      reason: `work item ${workItemId} does not hold an active process session for pid ${pid}`
    };
  }
  return undefined;
}

/**
 * ADR 0016 Slice 5. Called only after Desktop Commander itself reported
 * start_process as successful. Parses the pid Desktop Commander returned,
 * resolves its live identity, and persists the owning session - or reports a
 * failure reason without ever guessing a pid or silently treating the
 * process as unowned-but-fine. createProcessSession's underlying partial
 * unique index on (pid, boot_id, proc_start_ticks) WHERE status='active'
 * means a retried registration attempt against an already-registered live
 * process identity conflicts rather than reassigning ownership to a
 * different work item.
 */
function registerStartedProcessSession(
  workItems: WorkItemStore,
  workItemId: string,
  actionHash: string,
  workerId: string,
  dcOutput: string
): { code: string; reason: string } | undefined {
  const pid = parseStartedProcessPid(dcOutput);
  if (pid === undefined) {
    return {
      code: "process_session_pid_unresolvable",
      reason: "could not parse a pid from the Desktop Commander start_process response"
    };
  }

  let identity: ReturnType<typeof resolveCurrentProcessIdentity>;
  try {
    identity = resolveCurrentProcessIdentity(pid);
  } catch (error) {
    return {
      code: "process_session_identity_unresolvable",
      reason: error instanceof Error ? error.message : String(error)
    };
  }

  try {
    workItems.createProcessSession(
      {
        workItemId,
        actionHash,
        workerId,
        pid: identity.pid,
        bootId: identity.bootId,
        procStartTicks: identity.procStartTicks
      },
      { via: "domain_service", actorId: workerId }
    );
  } catch (error) {
    return {
      code: "process_session_registration_failed",
      reason: error instanceof Error ? error.message : String(error)
    };
  }
  return undefined;
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
