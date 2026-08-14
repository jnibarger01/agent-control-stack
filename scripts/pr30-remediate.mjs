import { readFileSync, writeFileSync } from "node:fs";

const mode = process.argv[2];
if (mode !== "--tests" && mode !== "--fixes") throw new Error("expected --tests or --fixes");

function replaceExact(path, before, after) {
  const source = readFileSync(path, "utf8");
  if (!source.includes(before)) throw new Error(`pattern not found in ${path}: ${before.slice(0, 120)}`);
  if (source.indexOf(before) !== source.lastIndexOf(before)) throw new Error(`pattern is not unique in ${path}`);
  writeFileSync(path, source.replace(before, after));
}

if (mode === "--tests") {
  writeFileSync(
    "packages/work-items/src/pr30-authority-regressions.test.ts",
    `import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
import { ControlStackError } from "@agent-control-stack/shared";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteWorkItemStore, defaultExecutionPlanForWorkItem } from "./index.js";

function hex(seed: string): string { return seed.repeat(64).slice(0, 64); }
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "acs-pr30-authority-"));
  const dbPath = join(directory, "control.db");
  const store = new SqliteWorkItemStore(dbPath);
  const workItem = store.create({
    title: "PR30 authority fixture", requester: "user", intent: "verify persisted authority",
    target: { cwd: "/repo" },
    requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["src/index.ts"] } }], risk: "low"
  });
  const plan = store.createExecutionPlan({ workItemId: workItem.id, definition: defaultExecutionPlanForWorkItem(workItem), createdByActorId: "user" });
  const admission = store.admitExecutionPlan({ workItemId: workItem.id, planHash: plan.planHash, policyVersion: "acs.policy.v1", policyDecisionHash: hex("1"), requiresApproval: false, admittedByActorId: "policy" }, { via: "policy_gate" });
  return { directory, dbPath, store, workItem, plan, admission };
}
function leaseAttempt(f: ReturnType<typeof fixture>, workerId: string, inputHash: string, now?: Date, ttlMs = 60_000) {
  const attempt = f.store.createAttempt({ workItemId: f.workItem.id, planHash: f.plan.planHash, inputHash }, { via: "domain_service" });
  const lease = f.store.leaseAttempt({ attemptId: attempt.attemptId, workItemId: f.workItem.id, admissionId: f.admission.admissionId, workerId, leaseToken: workerId.repeat(16), policyVersion: "acs.policy.v1", policyDecisionHash: hex("1"), ttlMs, now }, { via: "domain_service" });
  const db = f.store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => { changes: number } } } };
  db.db.prepare("UPDATE execution_attempts SET status = 'running', started_at = ?, updated_at = ? WHERE attempt_id = ?").run(new Date().toISOString(), new Date().toISOString(), attempt.attemptId);
  return { attempt, lease };
}

describe("PR30 authority review regressions", () => {
  let directory: string | undefined;
  afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined; });

  it("refuses to persist an attempt-scoped workspace for an expired lease", () => {
    const f = fixture(); directory = f.directory;
    const { attempt, lease } = leaseAttempt(f, "worker-expired", hex("a"), new Date(Date.now() - 120_000), 1_000);
    expect(() => f.store.recordWorkspaceAllocation({ allocationId: "workspace_expired", workItemId: f.workItem.id, attemptId: attempt.attemptId, leaseId: lease.leaseId, workerId: lease.workerId, fencingEpoch: lease.fencingEpoch, hostPath: "/repo/expired", branch: "acs/expired", baseRef: "HEAD" }, { via: "domain_service" }))
      .toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "workspace_allocation_authority_invalid" }));
    f.store.close();
  });

  it("does not authorize a newer attempt against an older active workspace allocation", () => {
    const f = fixture(); directory = f.directory;
    const first = leaseAttempt(f, "worker-one", hex("a"));
    f.store.recordWorkspaceAllocation({ allocationId: "workspace_old", workItemId: f.workItem.id, attemptId: first.attempt.attemptId, leaseId: first.lease.leaseId, workerId: first.lease.workerId, fencingEpoch: first.lease.fencingEpoch, hostPath: "/repo/old", branch: "acs/old", baseRef: "HEAD" }, { via: "domain_service" });
    const raw = new DatabaseSync(f.dbPath);
    raw.prepare("UPDATE attempt_leases SET status = 'revoked', closed_at = ? WHERE lease_id = ?").run(new Date().toISOString(), first.lease.leaseId);
    raw.prepare("UPDATE execution_attempts SET status = 'cancelled', terminal_at = ?, outcome_code = 'cancelled', updated_at = ? WHERE attempt_id = ?").run(new Date().toISOString(), new Date().toISOString(), first.attempt.attemptId);
    raw.close();
    const second = leaseAttempt(f, "worker-two", hex("b"));
    expect(f.store.getCommandAuthority({ workItemId: f.workItem.id, attemptId: second.attempt.attemptId, leaseId: second.lease.leaseId, workerId: second.lease.workerId, fencingToken: second.lease.fencingEpoch, workspaceAllocationId: "workspace_old" })).toBeUndefined();
    f.store.close();
  });

  it("expires a stale execution-plan approval so a replacement can be granted", () => {
    const f = fixture(); directory = f.directory;
    const old = f.store.grantExecutionPlanApproval({ workItemId: f.workItem.id, planHash: f.plan.planHash, actionHash: hex("c"), approvedByActorId: "approver", now: new Date(Date.now() - 120_000), expiresInMs: 1_000 }, { via: "domain_service" });
    const replacement = f.store.grantExecutionPlanApproval({ workItemId: f.workItem.id, planHash: f.plan.planHash, actionHash: hex("c"), approvedByActorId: "approver" }, { via: "domain_service" });
    expect(replacement.approvalId).not.toBe(old.approvalId);
    const db = new DatabaseSync(f.dbPath, { readOnly: true });
    expect(db.prepare("SELECT status FROM execution_plan_approvals WHERE approval_id = ?").get(old.approvalId)).toEqual({ status: "expired" });
    db.close(); f.store.close();
  });

  it("cancelling a running authoritative work item revokes its attempt lease and terminalizes the attempt", () => {
    const directoryLocal = mkdtempSync(join(tmpdir(), "acs-pr30-cancel-")); directory = directoryLocal;
    const dbPath = join(directoryLocal, "control.db");
    const store = new SqliteWorkItemStore(dbPath);
    const tools = createWorkItemTools(store, createPolicyEngine());
    const item = tools.create_work_item({ title: "cancel me", requester: "user", intent: "cancel authoritative work", target: { cwd: "/repo" }, requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["README.md"] } }], risk: "low" });
    const running = tools.claim_next_approved_work_item({ workerId: "worker-cancel" });
    expect(running?.id).toBe(item.id);
    store.cancelWorkItem(item.id, { reason: "operator cancel" }, { via: "domain_service" });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    expect(db.prepare("SELECT status FROM attempt_leases WHERE work_item_id = ?").get(item.id)).toEqual({ status: "revoked" });
    expect(db.prepare("SELECT status FROM execution_attempts WHERE work_item_id = ?").get(item.id)).toEqual({ status: "cancelled" });
    db.close(); store.close();
  });
});
`
  );

  writeFileSync(
    "apps/worker/src/pr30-cleanup.test.ts",
    `import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { describe, expect, it, vi } from "vitest";
import { runWorkerOnce } from "./index.js";

describe("PR30 worker cleanup regression", () => {
  it("tears down a provisioned workspace when execution throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-worker-cleanup-"));
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath);
    const tools = createWorkItemTools(store, createPolicyEngine());
    tools.create_work_item({ title: "throwing execution", requester: "user", intent: "prove cleanup", target: { cwd: "/repo" }, requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["README.md"] } }], risk: "low" });
    store.close();
    const teardown = vi.fn(async () => undefined);
    const workspaceManager = { provision: vi.fn(async (workItemId: string, options: Record<string, unknown>) => ({ allocationId: "workspace_throw", workItemId, attemptId: String(options.attemptId), leaseId: String(options.leaseId), workerId: String(options.workerId), fencingEpoch: Number(options.fencingEpoch), hostPath: "/tmp/workspace-throw", branch: "acs/throw", baseRef: "HEAD", status: "active", createdAt: new Date().toISOString() })), teardown } as unknown as import("@agent-control-stack/workspace-manager").WorkspaceManager;
    try {
      await expect(runWorkerOnce({ dbPath, workerId: "worker-throw", workspaceManager, execute: async () => { throw new Error("boom"); } })).rejects.toThrow("boom");
      expect(teardown).toHaveBeenCalledTimes(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
`
  );
  process.exit(0);
}

const migration007 = `CREATE TABLE IF NOT EXISTS workspace_allocations (
  allocation_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  host_path TEXT NOT NULL CHECK (length(trim(host_path)) > 0),
  branch TEXT NOT NULL CHECK (length(trim(branch)) > 0),
  base_ref TEXT NOT NULL CHECK (length(trim(base_ref)) > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'torn_down')),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  torn_down_at TEXT CHECK (torn_down_at IS NULL OR julianday(torn_down_at) IS NOT NULL),
  UNIQUE (allocation_id, work_item_id)
);

-- One live allocation per work item at a time - matches WorkspaceManager's
-- one-worktree-per-work-item design (reused across attempts, not
-- reprovisioned per attempt).
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_allocations_one_active_work_item
  ON workspace_allocations(work_item_id)
  WHERE status = 'active';

CREATE TRIGGER IF NOT EXISTS workspace_allocations_transition_guard
BEFORE UPDATE ON workspace_allocations
WHEN NEW.allocation_id IS NOT OLD.allocation_id
  OR NEW.work_item_id IS NOT OLD.work_item_id
  OR NEW.host_path IS NOT OLD.host_path
  OR NEW.branch IS NOT OLD.branch
  OR NEW.base_ref IS NOT OLD.base_ref
  OR NEW.created_at IS NOT OLD.created_at
  OR OLD.status <> 'active'
  OR NEW.status <> 'torn_down'
  OR NEW.torn_down_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'workspace_allocations: immutable binding or invalid transition');
END;

CREATE TRIGGER IF NOT EXISTS workspace_allocations_no_delete
BEFORE DELETE ON workspace_allocations
BEGIN
  SELECT RAISE(ABORT, 'workspace_allocations: append-only');
END;
`;
writeFileSync("storage/migrations/007_workspace_allocations.sql", migration007);

replaceExact(
  "storage/migrations/009_attempt_workspace_ownership.sql",
  "SELECT allocation_id, work_item_id, allocation_id, allocation_id, 'legacy', 0,\n       host_path, branch, base_ref, status, created_at, torn_down_at\nFROM workspace_allocations_legacy;",
  "SELECT allocation_id, work_item_id,\n       CASE WHEN status = 'active' THEN work_item_id ELSE allocation_id END,\n       CASE WHEN status = 'active' THEN work_item_id ELSE allocation_id END,\n       'legacy', 0, host_path, branch, base_ref, status, created_at, torn_down_at\nFROM workspace_allocations_legacy;"
);

replaceExact(
  "packages/work-items/src/store.ts",
  `      const existing = this.db
        .prepare(
          \`SELECT * FROM execution_plan_approvals
           WHERE work_item_id = ? AND plan_hash = ? AND action_hash = ? AND status = 'granted'\`
        )
        .get(parsed.workItemId, parsed.planHash, parsed.actionHash) as unknown as ExecutionPlanApprovalRow | undefined;
      if (existing) {
        return { value: rowToExecutionPlanApproval(existing), events: [] };
      }

      const approvalId = createId("plan_approval");
      const createdAt = (parsed.now ?? new Date()).toISOString();`,
  `      const createdAt = (parsed.now ?? new Date()).toISOString();
      const existing = this.db
        .prepare(
          \`SELECT * FROM execution_plan_approvals
           WHERE work_item_id = ? AND plan_hash = ? AND action_hash = ? AND status = 'granted'\`
        )
        .get(parsed.workItemId, parsed.planHash, parsed.actionHash) as unknown as ExecutionPlanApprovalRow | undefined;
      if (existing) {
        if (Date.parse(existing.expires_at) > Date.parse(createdAt)) {
          return { value: rowToExecutionPlanApproval(existing), events: [] };
        }
        const expired = this.db
          .prepare(\`UPDATE execution_plan_approvals SET status = 'expired' WHERE approval_id = ? AND status = 'granted' AND expires_at <= ?\`)
          .run(existing.approval_id, createdAt);
        if (expired.changes !== 1) {
          throw new ControlStackError("execution_plan_approval_conflict", "expired approval changed while replacing it");
        }
      }

      const approvalId = createId("plan_approval");`
);

replaceExact(
  "packages/work-items/src/store.ts",
  `      const attemptId = parsed.attemptId ?? parsed.workItemId;
      const leaseId = parsed.leaseId ?? parsed.workItemId;
      const workerId = parsed.workerId ?? "legacy";
      const fencingEpoch = parsed.fencingEpoch ?? 0;
      const activeForAttempt = this.db`,
  `      const attemptId = parsed.attemptId ?? parsed.workItemId;
      const leaseId = parsed.leaseId ?? parsed.workItemId;
      const workerId = parsed.workerId ?? "legacy";
      const fencingEpoch = parsed.fencingEpoch ?? 0;
      const hasAttemptAuthority =
        parsed.attemptId !== undefined || parsed.leaseId !== undefined || parsed.workerId !== undefined || parsed.fencingEpoch !== undefined;
      if (hasAttemptAuthority) {
        if (!parsed.attemptId || !parsed.leaseId || !parsed.workerId || parsed.fencingEpoch === undefined) {
          throw new ControlStackError("workspace_allocation_authority_invalid", "attempt-scoped workspace allocation requires the complete lease authority tuple");
        }
        const nowMs = Date.parse((parsed.now ?? new Date()).toISOString());
        const authoritativeLease = this.db
          .prepare(\`SELECT * FROM attempt_leases WHERE attempt_id = ? AND work_item_id = ? AND lease_id = ? AND worker_id = ? AND fencing_epoch = ? AND status = 'active'\`)
          .get(parsed.attemptId, parsed.workItemId, parsed.leaseId, parsed.workerId, parsed.fencingEpoch) as unknown as AttemptLeaseRow | undefined;
        const authoritativeAttempt = this.db
          .prepare(\`SELECT * FROM execution_attempts WHERE attempt_id = ? AND work_item_id = ?\`)
          .get(parsed.attemptId, parsed.workItemId) as unknown as ExecutionAttemptRow | undefined;
        if (
          !authoritativeLease ||
          Date.parse(authoritativeLease.expires_at) <= nowMs ||
          !authoritativeAttempt ||
          authoritativeAttempt.claimed_by_worker_id !== parsed.workerId ||
          authoritativeAttempt.current_fencing_epoch !== parsed.fencingEpoch ||
          (authoritativeAttempt.status !== "leased" && authoritativeAttempt.status !== "running")
        ) {
          throw new ControlStackError("workspace_allocation_authority_invalid", "workspace allocation authority is stale, expired, or mismatched");
        }
      }
      const activeForAttempt = this.db`
);

replaceExact(
  "packages/work-items/src/store.ts",
  `      attemptRow.claimed_by_worker_id === input.workerId &&
      (attemptRow.status === "leased" ||
        attemptRow.status === "running" ||
        attemptRow.status === "cancellation_requested") &&
      allocationRow.status === "active";`,
  `      attemptRow.claimed_by_worker_id === input.workerId &&
      (attemptRow.status === "leased" ||
        attemptRow.status === "running" ||
        attemptRow.status === "cancellation_requested") &&
      allocationRow.status === "active" &&
      allocationRow.attempt_id === input.attemptId &&
      allocationRow.lease_id === input.leaseId &&
      allocationRow.worker_id === input.workerId &&
      allocationRow.fencing_epoch === input.fencingToken;`
);

replaceExact(
  "packages/work-items/src/store.ts",
  `      if (current.status === "running" && status !== "running") {
        this.db
          .prepare(\`UPDATE leases SET status = 'revoked', closed_at = ? WHERE work_item_id = ? AND status = 'active'\`)
          .run(updated.updatedAt, id);
      }`,
  `      if (current.status === "running" && status !== "running") {
        this.db
          .prepare(\`UPDATE leases SET status = 'revoked', closed_at = ? WHERE work_item_id = ? AND status = 'active'\`)
          .run(updated.updatedAt, id);
        if (status === "cancelled") {
          this.db
            .prepare(\`UPDATE attempt_leases SET status = 'revoked', closed_at = ? WHERE work_item_id = ? AND status = 'active'\`)
            .run(updated.updatedAt, id);
          this.db
            .prepare(\`UPDATE execution_attempts SET status = 'cancelled', terminal_at = ?, outcome_code = 'cancelled', updated_at = ? WHERE work_item_id = ? AND status IN ('leased', 'running', 'cancellation_requested')\`)
            .run(updated.updatedAt, updated.updatedAt, id);
        }
      }`
);

replaceExact(
  "apps/worker/src/index.ts",
  `  const execute = options.execute ?? executeSandboxed;

  try {`,
  `  const execute = options.execute ?? executeSandboxed;
  let cleanupWorkspace: { workItemId: string; attemptId: string; leaseId: string; workerId: string; fencingEpoch: number } | undefined;

  try {`
);
replaceExact(
  "apps/worker/src/index.ts",
  `    const startedAt = new Date().toISOString();`,
  `    if (workspace && running.attemptId) {
      cleanupWorkspace = { workItemId: running.id, attemptId: running.attemptId, leaseId: running.leaseId, workerId, fencingEpoch: running.fencingEpoch };
    }
    const startedAt = new Date().toISOString();`
);
const worker = readFileSync("apps/worker/src/index.ts", "utf8");
const teardownBlock = `      if (workspace && running.attemptId) {
        await options.workspaceManager?.teardown(running.id, {
          attemptId: running.attemptId,
          leaseId: running.leaseId,
          workerId,
          fencingEpoch: running.fencingEpoch
        });
      }
`;
const teardownBlock2 = `    if (workspace && running.attemptId) {
      await options.workspaceManager?.teardown(running.id, {
        attemptId: running.attemptId,
        leaseId: running.leaseId,
        workerId,
        fencingEpoch: running.fencingEpoch
      });
    }

`;
if (!worker.includes(teardownBlock) || !worker.includes(teardownBlock2)) throw new Error("worker teardown blocks not found");
writeFileSync("apps/worker/src/index.ts", worker.replace(teardownBlock, "").replace(teardownBlock2, ""));
replaceExact(
  "apps/worker/src/index.ts",
  `  } finally {
    workItems.close();
  }`,
  `  } finally {
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
      workItems.close();
    }
  }`
);
