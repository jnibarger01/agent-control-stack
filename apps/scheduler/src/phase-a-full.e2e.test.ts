import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ExecutionController } from "@agent-control-stack/execution-controller";
import { ResultValidator } from "@agent-control-stack/result-validation";
import { createSqlitePublicationStore, publishValidatedAttempt } from "@agent-control-stack/publication";
import { runSchedulerOnce, type ScheduleConfig } from "./index.js";
import { SqliteWorkItemStore, defaultExecutionPlanForWorkItem } from "@agent-control-stack/work-items";
import { WorkspaceManager } from "@agent-control-stack/workspace-manager";
import type { EngineAdapter } from "@agent-control-stack/engine-adapter";
import { describe, expect, it, vi } from "vitest";

const execFileAsync = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}

const limits = { wallClockMs: 60_000, terminationGraceMs: 100, cpuQuotaPercent: 100, memoryBytes: 64 * 1024 * 1024, pids: 16, outputBytes: 100_000, tmpfsBytes: 16 * 1024 * 1024 };

 describe("Phase A scheduler/controller/validation/publication E2E", () => {
  it("executes one scheduled task through the authoritative controller, validates it, then refuses publication under the dry-run-only plan boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "acs-phase-a-full-"));
    const repo = join(root, "repo");
    const bare = join(root, "remote.git");
    const dbPath = join(root, "control.db");
    const phases: string[] = [];
    let publishedBranch = "";
    try {
      await execFileAsync("git", ["init", "--initial-branch=main", repo]);
      await execFileAsync("git", ["init", "--bare", bare]);
      await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repo });
      await execFileAsync("git", ["remote", "add", "origin", bare], { cwd: repo });
      await execFileAsync("git", ["add", "."], { cwd: repo });
      await execFileAsync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: repo });
      await execFileAsync("git", ["push", "origin", "main"], { cwd: repo });

      const schedules: ScheduleConfig = [{ scheduleId: "phase-a", intervalMs: 60_000, workItemTemplate: { title: "Phase A task", requester: "system", intent: "modify the repository", target: { cwd: repo }, requestedActions: [{ kind: "fs.write", description: "update readme", params: { paths: ["README.md"], write: true } }], risk: "low" } }];
      const github = { createOrUpdate: vi.fn(async () => ({ url: "https://github.com/acme/repo/pull/99" })) };

      const scheduled = await runSchedulerOnce({ dbPath, schedules, now: new Date("2026-08-18T00:01:00.000Z"), onWorkItemCreated: async (workItemId) => {
        phases.push("scheduler");
        const store = new SqliteWorkItemStore(dbPath);
        const workItem = store.get(workItemId);
        if (!workItem) throw new Error("scheduler callback lost work item");
        const plan = store.createExecutionPlan({ workItemId, definition: defaultExecutionPlanForWorkItem(workItem), createdByActorId: "actor_system_bootstrap" });
        const admission = store.admitExecutionPlan({ workItemId, planHash: plan.planHash, policyVersion: "acs.policy.v1", policyDecisionHash: "a".repeat(64), requiresApproval: false, admittedByActorId: "actor_system_bootstrap" }, { via: "policy_gate" });
        const workspaceManager = new WorkspaceManager({ repoPath: repo, rootDir: join(root, "workspaces"), store });
        const engine: EngineAdapter = { id: "codex", invoke: vi.fn(async (task) => { phases.push("controller"); await execFileAsync("sh", ["-c", "printf 'validated\n' > README.md"], { cwd: task.workspace.hostPath }); return { status: "completed" as const, exitCode: 0, stdout: "completed", stderr: "", durationMs: 1, stdoutTruncated: false, stderrTruncated: false }; }) };
        const controller = new ExecutionController({
          store,
          workspaceManager,
          engine,
          validator: new ResultValidator(),
          buildValidationInput: ({ outcome, workspace }) => { phases.push("validation"); return { workspacePath: workspace.hostPath, outcome }; },
          input: {
            workerId: "worker-phase-a",
            leaseToken: "phase-a-lease-token-long-enough",
            admissionId: admission.admissionId,
            inputHash: "b".repeat(64),
            buildTask: ({ attempt, lease, workspace, plan: executionPlan }) => ({ workItemId, attemptId: attempt.attemptId, leaseId: lease.leaseId, workerId: "worker-phase-a", fencingToken: lease.fencingEpoch, authorization: { kind: "plan", hash: executionPlan.planHash }, policyVersion: admission.policyVersion, auditCorrelationId: "phase-a-audit", idempotencyKey: "phase-a-idempotency", workspace: { allocationId: workspace.allocationId, hostPath: workspace.hostPath }, prompt: "modify README", egressAllowlist: [{ host: "api.openai.com", port: 443 }], limits })
          }
        });
        const result = await controller.execute(workItemId);
        expect(result.validation?.passed).toBe(true);
        publishedBranch = result.workspace.branch;
        phases.push("publication");
        // Every execution plan under the current production-hardened schema
        // is unconditionally dry-run-only (constraints.allowPush is a
        // hardcoded `false`), so even a fully validated, successfully
        // executed attempt must still have its publication refused - the
        // dry-run boundary holds all the way through the pipeline, not
        // just at the engine invocation step.
        await expect(
          publishValidatedAttempt({ workItemId, attemptId: result.attempt.attemptId, workspacePath: result.workspace.hostPath, branch: result.workspace.branch, remote: "origin", title: workItem.title, body: "independently validated", leaseIsCurrent: async () => true }, createSqlitePublicationStore(store), github)
        ).rejects.toThrow(/does not authorize a push/);
        await workspaceManager.teardown(workItemId, { attemptId: result.attempt.attemptId, leaseId: result.lease.leaseId, workerId: result.lease.workerId, fencingEpoch: result.lease.fencingEpoch });
        store.close();
      }});

      expect(scheduled.firings[0]?.created).toBe(true);
      expect(phases).toEqual(["scheduler", "controller", "validation", "publication"]);
      expect(github.createOrUpdate).not.toHaveBeenCalled();
      await expect(git(bare, "show-ref", "--hash", `refs/heads/${publishedBranch}`)).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
