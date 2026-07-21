import { createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
import { executeAgentSandboxed, executeSandboxed } from "@agent-control-stack/sandbox";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";

export interface WorkerOptions {
  dbPath?: string;
  workerId?: string;
}

export interface WorkerResult {
  executed: boolean;
  executionMode?: "dry_run" | "sandboxed_agent" | "not_started";
  workItemId?: string;
  reason?: string;
}

export async function runWorkerOnce(options: WorkerOptions = {}): Promise<WorkerResult> {
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
    const hasAgentPrompt = running.requestedActions.some((action) => action.kind === "agent.prompt");
    const result = hasAgentPrompt
      ? await executeAgentSandboxed(running, { enabled: process.env.ACS_AGENT_EXECUTION_MODE === "codex-bubblewrap" })
      : await executeSandboxed(running);
    const completedAt = new Date().toISOString();

    if (result.ok) {
      tools.submit_work_result({
        id: running.id,
        workerId,
        leaseToken: running.leaseToken,
        status: "succeeded",
        result: {
          execution_mode: result.executionMode,
          output: result.output,
          summary: result.executionMode === "dry_run" ? "dry-run execution completed" : "sandboxed agent execution completed",
          started_at: startedAt,
          completed_at: completedAt,
          timed_out: false,
          sandbox_identity: result.sandboxIdentity ?? "acs-dry-run",
          ...(result.workspaceBeforeHash ? { workspace_before_hash: result.workspaceBeforeHash } : {}),
          ...(result.workspaceAfterHash ? { workspace_after_hash: result.workspaceAfterHash } : {}),
          ...(result.changedPaths ? { changed_paths: result.changedPaths } : {}),
          ...(result.exitCode !== undefined ? { exit_code: result.exitCode } : {}),
          ...(result.timedOut !== undefined ? { timed_out: result.timedOut } : {}),
          ...(result.agent ? { agent: result.agent } : {}),
          ...(result.provider ? { provider: result.provider } : {}),
          ...(result.model ? { model: result.model } : {})
        }
      });
    } else {
      tools.submit_work_result({
        id: running.id,
        workerId,
        leaseToken: running.leaseToken,
        status: "failed",
        result: {
          execution_mode: result.executionMode,
          error: result.error ?? "sandbox execution failed",
          started_at: startedAt,
          completed_at: completedAt,
          timed_out: false,
          sandbox_identity: result.sandboxIdentity ?? "acs-agent-not-started",
          ...(result.workspaceBeforeHash ? { workspace_before_hash: result.workspaceBeforeHash } : {}),
          ...(result.workspaceAfterHash ? { workspace_after_hash: result.workspaceAfterHash } : {}),
          ...(result.changedPaths ? { changed_paths: result.changedPaths } : {}),
          ...(result.exitCode !== undefined ? { exit_code: result.exitCode } : {}),
          ...(result.timedOut !== undefined ? { timed_out: result.timedOut } : {}),
          ...(result.agent ? { agent: result.agent } : {}),
          ...(result.provider ? { provider: result.provider } : {}),
          ...(result.model ? { model: result.model } : {}),
          ...(result.output ? { stdout_summary: result.output } : {}),
          ...(result.stderr ? { stderr_summary: result.stderr } : {})
        }
      });
    }

    return { executed: true, executionMode: result.executionMode, workItemId: running.id, reason: workerId };
  } finally {
    workItems.close();
  }
}
