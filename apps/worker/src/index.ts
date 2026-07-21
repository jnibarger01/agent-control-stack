import { createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
import { executeAgentSandboxed, executeSandboxed } from "@agent-control-stack/sandbox";
import { loadMachineControllerConfig } from "@agent-control-stack/machine-controller";
import { SqliteWorkItemStore, type ClaimedWorkItem } from "@agent-control-stack/work-items";
import { executeWorkerAction, type WorkerActionResult } from "./actions.js";
import { createWorkerGatewayClient } from "./gateway-client.js";

export interface WorkerOptions {
  dbPath?: string;
  workerId?: string;
  machineConfigPath?: string;
  gatewayUrl?: string;
  workerToken?: string;
}

export interface WorkerLoopOptions extends WorkerOptions {
  intervalMs?: number;
}

export interface WorkerResult {
  executed: boolean;
  executionMode?: "dry_run" | "controlled_action" | "sandboxed_agent" | "not_started";
  workItemId?: string;
  reason?: string;
}

export async function runWorkerOnce(options: WorkerOptions = {}): Promise<WorkerResult> {
  const gatewayUrl = options.gatewayUrl ?? process.env.ACS_WORKER_GATEWAY_URL;
  if (gatewayUrl) {
    return runRemoteWorkerOnce({ ...options, gatewayUrl });
  }
  const dbPath = options.dbPath ?? process.env.ACS_DB_PATH ?? "storage/local.db";
  const workItems = new SqliteWorkItemStore(dbPath);
  const tools = createWorkItemTools(workItems, createPolicyEngine());
  const workerId = options.workerId ?? "local-worker";

  try {
    workItems.failExpiredLeases();
    const running = tools.claim_next_approved_work_item({ workerId });
    if (!running) {
      return { executed: false, reason: "no approved work item" };
    }
    if (running.status === "blocked") {
      return { executed: false, workItemId: running.id, reason: "blocked by policy" };
    }

    const startedAt = new Date().toISOString();
    const connectorAction = isConnectorAction(running);
    const result = connectorAction
      ? await executeConnectorAction(running, workerId, options.machineConfigPath)
      : await executeLegacyAction(running);
    const completedAt = new Date().toISOString();

    tools.submit_work_result({
      id: running.id,
      workerId,
      leaseToken: running.leaseToken,
      status: result.ok ? "succeeded" : "failed",
      result: workerResultPayload(running, workerId, result, startedAt, completedAt)
    });

    return { executed: true, executionMode: result.executionMode, workItemId: running.id, reason: workerId };
  } finally {
    workItems.close();
  }
}

export async function runWorkerLoop(options: WorkerLoopOptions = {}): Promise<never> {
  const intervalMs = options.intervalMs ?? Number(process.env.ACS_WORKER_POLL_INTERVAL_MS ?? 5_000);
  if (!Number.isInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 3_600_000) {
    throw new Error("ACS worker poll interval must be between 1000 and 3600000 milliseconds");
  }
  while (true) {
    await runWorkerOnce(options);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function runRemoteWorkerOnce(options: WorkerOptions & { gatewayUrl: string }): Promise<WorkerResult> {
  const workerId = options.workerId ?? process.env.ACS_WORKER_ID ?? "acs-worker";
  const token = options.workerToken ?? process.env.ACS_WORKER_TOKEN;
  if (!token) {
    return { executed: false, reason: "worker gateway token is not configured" };
  }
  const client = createWorkerGatewayClient({ baseUrl: options.gatewayUrl, token, workerId });
  let running: ClaimedWorkItem | undefined;
  try {
    running = await client.claim();
  } catch (error) {
    return { executed: false, reason: error instanceof Error ? error.message : "worker gateway claim failed" };
  }
  if (!running) {
    return { executed: false, reason: "no approved work item" };
  }
  if (running.status === "blocked") {
    return { executed: false, workItemId: running.id, reason: "blocked by policy" };
  }

  const startedAt = new Date().toISOString();
  const result = isConnectorAction(running)
    ? await executeConnectorAction(running, workerId, options.machineConfigPath)
    : await executeLegacyAction(running);
  const completedAt = new Date().toISOString();
  try {
    await client.submit(running.id, {
      leaseToken: running.leaseToken,
      status: result.ok ? "succeeded" : "failed",
      result: workerResultPayload(running, workerId, result, startedAt, completedAt)
    });
  } catch (error) {
    return {
      executed: false,
      workItemId: running.id,
      executionMode: result.executionMode,
      reason: error instanceof Error ? error.message : "worker result submission failed"
    };
  }
  return { executed: true, executionMode: result.executionMode, workItemId: running.id, reason: workerId };
}

function isConnectorAction(workItem: ClaimedWorkItem): boolean {
  return workItem.requestedActions.some((action) => typeof action.params.registryActionId === "string");
}

async function executeConnectorAction(
  workItem: ClaimedWorkItem,
  workerId: string,
  machineConfigPath: string | undefined
): Promise<WorkerActionResult> {
  try {
    const configPath = machineConfigPath ?? process.env.ACS_MACHINE_CONTROLLER_CONFIG ?? "config.example.yml";
    const config = loadMachineControllerConfig(configPath);
    return await executeWorkerAction(workItem, config, workerId);
  } catch (error) {
    return {
      ok: false,
      executionMode: "not_started",
      output: "",
      error: error instanceof Error ? error.message : "machine controller configuration failed"
    };
  }
}

async function executeLegacyAction(workItem: ClaimedWorkItem): Promise<WorkerActionResult> {
  const hasAgentPrompt = workItem.requestedActions.some((action) => action.kind === "agent.prompt");
  const result = hasAgentPrompt
    ? await executeAgentSandboxed(workItem, { enabled: process.env.ACS_AGENT_EXECUTION_MODE === "codex-bubblewrap" })
    : await executeSandboxed(workItem);
  return {
    ok: result.ok,
    executionMode: result.executionMode,
    output: result.output,
    ...(result.error ? { error: result.error } : {}),
    ...(result.stderr ? { stderr: result.stderr } : {}),
    ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
    ...(result.timedOut !== undefined ? { timedOut: result.timedOut } : {}),
    ...(result.agent ? { agent: result.agent } : {}),
    ...(result.provider ? { provider: result.provider } : {}),
    ...(result.model ? { model: result.model } : {}),
    ...(result.workspaceBeforeHash ? { workspaceBeforeHash: result.workspaceBeforeHash } : {}),
    ...(result.workspaceAfterHash ? { workspaceAfterHash: result.workspaceAfterHash } : {}),
    ...(result.changedPaths ? { changedPaths: result.changedPaths } : {}),
    ...(result.sandboxIdentity ? { sandboxIdentity: result.sandboxIdentity } : {})
  };
}

function workerResultPayload(
  workItem: ClaimedWorkItem,
  workerId: string,
  result: WorkerActionResult,
  startedAt: string,
  completedAt: string
): Record<string, unknown> {
  const policy = createPolicyEngine();
  const output = boundedWorkerText(result.output);
  const error = result.error === undefined ? undefined : boundedWorkerText(result.error);
  const stderr = result.stderr === undefined ? undefined : boundedWorkerText(result.stderr);
  return {
    execution_mode: result.executionMode,
    ...(result.ok
      ? { output: output.value, ...(output.truncated ? { output_truncated: true } : {}) }
      : { error: error?.value ?? "worker execution failed" }),
    ...(result.ok
      ? {
          summary:
            result.executionMode === "dry_run"
              ? "dry-run execution completed"
              : result.executionMode === "controlled_action"
                ? "controlled registered action completed"
                : "sandboxed agent execution completed"
        }
      : {}),
    started_at: startedAt,
    completed_at: completedAt,
    timed_out: result.timedOut ?? false,
    executor_id: workerId,
    lease_id: workItem.leaseId,
    action_hashes: policy.evaluateWorkItem(workItem, workerId, "claim").map((evaluation) => evaluation.actionHash),
    sandbox_identity: result.sandboxIdentity ?? (result.ok ? "acs-dry-run" : "acs-agent-not-started"),
    ...(result.evidence ? { evidence: result.evidence } : {}),
    ...(result.workspaceBeforeHash ? { workspace_before_hash: result.workspaceBeforeHash } : {}),
    ...(result.workspaceAfterHash ? { workspace_after_hash: result.workspaceAfterHash } : {}),
    ...(result.changedPaths ? { changed_paths: result.changedPaths } : {}),
    ...(result.repositoryCommit ? { repository_commit: result.repositoryCommit } : {}),
    ...(result.repositoryWorktreeState !== undefined ? { repository_worktree_state: result.repositoryWorktreeState } : {}),
    ...(result.exitCode !== undefined ? { exit_code: result.exitCode } : {}),
    ...(result.agent ? { agent: result.agent } : {}),
    ...(result.provider ? { provider: result.provider } : {}),
    ...(result.model ? { model: result.model } : {}),
    ...(result.output && !result.ok ? { stdout_summary: output.value } : {}),
    ...(stderr ? { stderr_summary: stderr.value } : {})
  };
}

const MAX_WORKER_RESULT_TEXT = 20_000;

function boundedWorkerText(value: string): { value: string; truncated: boolean } {
  if (value.length <= MAX_WORKER_RESULT_TEXT) {
    return { value, truncated: false };
  }
  const marker = "\n[truncated by ACS]";
  return {
    value: value.slice(0, MAX_WORKER_RESULT_TEXT - marker.length) + marker,
    truncated: true
  };
}
