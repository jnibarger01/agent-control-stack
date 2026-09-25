import { realpathSync } from "node:fs";
import { join } from "node:path";
import {
  authorizationDeniedEvent,
  authorizationGrantedEvent,
  authorizationRequestedEvent,
  desktopCommanderAdapterConfigFromEnv,
  desktopCommanderContainmentFromEnv,
  DesktopCommanderMachineExecutor,
  executionCompletedEvent,
  executionStartedEvent,
  resultPersistedEvent,
  toolCalledEvent,
  toolOutcomeEvent,
  authorizeDesktopCommanderExecution
} from "@agent-control-stack/desktop-commander-adapter";
import { createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
import { stableHash } from "@agent-control-stack/shared";
import {
  executionActionHash,
  SqliteWorkItemStore,
  type WorkItem,
  type ClaimedWorkItem
} from "@agent-control-stack/work-items";
import { WorkspaceManager } from "@agent-control-stack/workspace-manager";
import type { NormalizedToolRequest, ToolObservation } from "./coding-tools.js";
import type { CodingTask } from "./coding-task.js";

export interface ManagedCodingExecutionOptions {
  dbPath: string;
  repoRoot: string;
  task: CodingTask;
  workerId?: string;
  approver?: string;
  worktreeRoot?: string;
  model?: string;
}

export interface ManagedCodingExecution {
  workspace: string;
  gateway: {
    execute(request: NormalizedToolRequest, signal?: AbortSignal): Promise<ToolObservation>;
  };
  dispose(): Promise<void>;
}

function actionKind(request: NormalizedToolRequest): string {
  if (request.dcTool === "write_file" || request.dcTool === "edit_block") return "fs.write";
  if (request.dcTool === "start_process") return "cmd.run";
  return "fs.read";
}

function actionDescription(request: NormalizedToolRequest): string {
  return `coding harness ${request.tool}`;
}

function actionParams(request: NormalizedToolRequest): Record<string, unknown> {
  return {
    cwd: request.workspace,
    tool: request.dcTool,
    arguments: request.args,
    write: request.dcTool === "write_file" || request.dcTool === "edit_block",
    destructive: false,
    network: false,
    allowNetwork: false
  };
}

function createCodingWorkItem(
  tools: ReturnType<typeof createWorkItemTools>,
  request: NormalizedToolRequest,
  task: CodingTask
): WorkItem {
  return tools.create_work_item({
    title: `coding task ${task.id}: ${request.tool}`,
    requester: "agent",
    intent: task.goal,
    target: { cwd: request.workspace, repo: request.workspace },
    requestedActions: [
      {
        kind: actionKind(request),
        description: actionDescription(request),
        params: actionParams(request)
      }
    ],
    risk: actionKind(request) === "fs.read" ? "low" : "medium"
  });
}

function approvalHash(workItem: WorkItem, approver: string): string {
  const decision = createPolicyEngine().evaluateWorkItem(workItem, approver, "approve")[0];
  if (!decision?.actionHash) throw new Error("ACS policy did not produce an approval action hash");
  return decision.actionHash;
}

export async function createManagedCodingExecution(
  options: ManagedCodingExecutionOptions
): Promise<ManagedCodingExecution> {
  if (process.env.ACS_EXECUTION_BACKEND !== "desktop_commander") {
    throw new Error("ACS_EXECUTION_BACKEND=desktop_commander is required for managed coding execution");
  }
  if (!options.approver) throw new Error("an explicit human approver is required for managed coding execution");
  const config = desktopCommanderAdapterConfigFromEnv(process.env, options.dbPath);
  if (!config) throw new Error("managed Desktop Commander is not configured");
  const containment = desktopCommanderContainmentFromEnv();
  if (!containment.allowedRoots.some((root) => root === options.repoRoot)) {
    throw new Error("repository root is not an ACS Desktop Commander containment root");
  }
  const store = new SqliteWorkItemStore(options.dbPath);
  const tools = createWorkItemTools(store, createPolicyEngine());
  const workerId = options.workerId ?? `coding-harness-${options.task.id}`;
  const worktreeRoot = options.worktreeRoot ?? join(options.repoRoot, ".acs-coding-worktrees");
  const workspaceManager = new WorkspaceManager({
    repoPath: options.repoRoot,
    rootDir: worktreeRoot,
    store
  });
  const canonicalWorktreeRoot = realpathSync(worktreeRoot);
  if (
    !containment.allowedRoots.some(
      (root) => canonicalWorktreeRoot === root || canonicalWorktreeRoot.startsWith(`${root}/`)
    )
  ) {
    throw new Error("worktree root is not an ACS Desktop Commander containment root");
  }
  const sessionWorkItem = tools.create_work_item({
    title: `coding session ${options.task.id}`,
    requester: "agent",
    intent: "reserve an isolated workspace for a coding task",
    target: { cwd: options.repoRoot, repo: options.repoRoot },
    requestedActions: [
      {
        kind: "fs.read",
        description: "coding session workspace reservation",
        params: { paths: ["README.md"], write: false, tool: "get_config", arguments: {} }
      }
    ],
    risk: "low"
  });
  let sessionActionHash = executionActionHash(sessionWorkItem);
  if (sessionWorkItem.status === "needs_approval") {
    sessionActionHash = approvalHash(sessionWorkItem, options.approver);
    tools.approve_work_item({
      id: sessionWorkItem.id,
      approvedBy: options.approver,
      reason: "coding session workspace approval",
      actionHash: sessionActionHash
    });
  }
  const sessionClaim = tools.claim_approved_work_item_by_id({
    id: sessionWorkItem.id,
    actionHash: sessionActionHash,
    workerId
  });
  if (
    !sessionClaim?.attemptId ||
    !sessionClaim.planHash ||
    !sessionClaim.inputHash ||
    sessionClaim.fencingEpoch === undefined
  )
    throw new Error("coding session claim lacks workspace authority");
  const workspace = await workspaceManager.provision(sessionWorkItem.id, {
    attemptId: sessionClaim.attemptId,
    leaseId: sessionClaim.leaseId,
    workerId,
    fencingEpoch: sessionClaim.fencingEpoch
  });
  const executor = new DesktopCommanderMachineExecutor(config);
  await executor.preflight();
  let closed = false;

  const execute = async (request: NormalizedToolRequest, signal?: AbortSignal): Promise<ToolObservation> => {
    const startedAt = new Date().toISOString();
    const requestId = `code-${options.task.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const workItem = createCodingWorkItem(tools, request, options.task);
    const emit = (draft: import("@agent-control-stack/desktop-commander-adapter").AuditEventDraft): void => {
      store.recordExecutionEvent({
        name: draft.name,
        workItemId: workItem.id,
        body: draft.body,
        attributes: draft.attributes
      });
    };
    const state: { claimed?: ClaimedWorkItem } = {};
    try {
      let expectedActionHash = executionActionHash(workItem);
      if (workItem.status === "needs_approval") {
        expectedActionHash = approvalHash(workItem, options.approver!);
        tools.approve_work_item({
          id: workItem.id,
          approvedBy: options.approver,
          reason: "coding harness human approval",
          actionHash: expectedActionHash
        });
      }
      const approvedWorkItem = store.get(workItem.id);
      if (approvedWorkItem?.status !== "approved")
        throw new Error(`coding action is not approved: ${approvedWorkItem?.status ?? "missing"}`);
      const claimed = tools.claim_approved_work_item_by_id({
        id: workItem.id,
        actionHash: expectedActionHash,
        workerId
      });
      if (!claimed) throw new Error("ACS did not claim the approved coding action");
      if (!claimed.attemptId || !claimed.planHash || !claimed.inputHash || claimed.fencingEpoch === undefined)
        throw new Error("claimed coding action lacks attempt authority");
      state.claimed = claimed;
      emit(
        authorizationRequestedEvent({
          workItemId: workItem.id,
          workerId,
          requestId,
          toolName: request.dcTool,
          attemptId: claimed.attemptId,
          leaseId: claimed.leaseId,
          fencingEpoch: claimed.fencingEpoch
        })
      );
      const trusted = store.get(workItem.id);
      const lease = store.getActiveLeaseForAttempt(claimed.attemptId);
      if (!trusted || !lease) throw new Error("claimed coding action lacks trusted state or lease");
      const authorization = authorizeDesktopCommanderExecution({
        claimed,
        trustedWorkItem: trusted,
        lease,
        workerId,
        containment,
        requestId,
        ...(lease.approvalId
          ? { approvalActionHash: store.getExecutionPlanApprovalById(lease.approvalId)?.actionHash }
          : {})
      });
      emit(authorizationGrantedEvent(authorization));
      emit(executionStartedEvent(authorization));
      emit(toolCalledEvent(authorization));
      const result = await executor.execute({ authorization, signal });
      emit(
        toolOutcomeEvent(authorization, {
          ok: !result.isError,
          durationMs: result.durationMs,
          resultHash: result.resultHash,
          truncated: result.truncated,
          isError: result.isError,
          outcome: result.isError ? "failed" : "succeeded",
          ...(result.errorCode ? { errorCode: result.errorCode } : {})
        })
      );
      const output = result.output;
      store.submitWorkResult({
        workItemId: workItem.id,
        attemptId: claimed.attemptId,
        leaseId: claimed.leaseId,
        workerId,
        actionHash: authorization.actionHash,
        planHash: claimed.planHash,
        inputHash: claimed.inputHash,
        fencingEpoch: claimed.fencingEpoch,
        idempotencyKey: stableHash({ domain: "acs.attempt-result.v1", attemptId: claimed.attemptId }),
        outcome: result.isError ? "failed" : "succeeded",
        startedAt,
        finishedAt: result.completedAt,
        exitCode: result.isError ? null : 0,
        summary: `coding harness ${request.tool} ${result.isError ? "failed" : "completed"}`,
        stdout: output,
        ...(result.error ? { error: result.error } : {}),
        structuredOutput: { tool: request.tool, invocationFingerprint: authorization.invocationFingerprint },
        artifacts: [],
        simulationMetadata: {
          executionMode: "desktop_commander",
          simulated: false,
          backend: "desktop-commander-mcp",
          requestId,
          toolName: request.dcTool,
          invocationFingerprint: authorization.invocationFingerprint
        }
      });
      emit(resultPersistedEvent(authorization, result.resultHash));
      emit(executionCompletedEvent(authorization, { ok: !result.isError, resultHash: result.resultHash }));
      return {
        ok: !result.isError,
        output,
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        evidenceHash: result.resultHash
      };
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error ? String(error.code) : "managed_coding_execution_failed";
      if (state.claimed?.attemptId)
        emit(
          authorizationDeniedEvent({
            workItemId: workItem.id,
            workerId,
            requestId,
            toolName: request.dcTool,
            code,
            reason: error instanceof Error ? error.message : String(error),
            attemptId: state.claimed.attemptId,
            leaseId: state.claimed.leaseId,
            fencingEpoch: state.claimed.fencingEpoch
          })
        );
      return { ok: false, output: "", errorCode: code, evidenceHash: "" };
    }
  };

  return {
    workspace: workspace.hostPath,
    gateway: { execute },
    dispose: async () => {
      if (closed) return;
      closed = true;
      await executor.close().catch(() => undefined);
      store.submitWorkResult({
        workItemId: sessionWorkItem.id,
        attemptId: sessionClaim.attemptId,
        leaseId: sessionClaim.leaseId,
        workerId,
        actionHash: sessionClaim.actionHash,
        planHash: sessionClaim.planHash,
        inputHash: sessionClaim.inputHash,
        fencingEpoch: sessionClaim.fencingEpoch,
        idempotencyKey: stableHash({ domain: "acs.attempt-result.v1", attemptId: sessionClaim.attemptId }),
        outcome: "succeeded",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        summary: "coding session workspace reservation completed",
        structuredOutput: { workspace: workspace.hostPath },
        artifacts: [],
        simulationMetadata: {
          executionMode: "desktop_commander",
          simulated: false,
          backend: "desktop-commander-mcp",
          requestId: `code-session-${options.task.id}`,
          toolName: "workspace.reserve",
          invocationFingerprint: stableHash({ domain: "acs.coding-session.v1", taskId: options.task.id })
        }
      });
      await workspaceManager
        .teardown(sessionWorkItem.id, {
          attemptId: sessionClaim.attemptId,
          leaseId: sessionClaim.leaseId,
          workerId,
          fencingEpoch: sessionClaim.fencingEpoch
        })
        .catch(() => undefined);
      store.close();
    }
  };
}
