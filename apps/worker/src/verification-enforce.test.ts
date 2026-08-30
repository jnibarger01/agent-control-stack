import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { workspaceIdentityFromContainment } from "@agent-control-stack/advisory";
import { createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
import {
  SqliteWorkItemStore,
  executionActionHash,
  type WorkItem
} from "@agent-control-stack/work-items";
import type {
  AuthorizedExecutionRequest,
  MachineExecutor,
  MachineExecutionResult
} from "@agent-control-stack/desktop-commander-adapter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveVerificationPolicyMode, runWorkerOnce, workerResultIdempotencyKey } from "./index.js";

class FakeExecutor implements MachineExecutor {
  calls: AuthorizedExecutionRequest[] = [];
  async listTools() {
    return [];
  }
  async execute(request: AuthorizedExecutionRequest): Promise<MachineExecutionResult> {
    this.calls.push(request);
    const auth = request.authorization;
    const now = new Date();
    return {
      toolName: auth.toolName,
      invocationFingerprint: auth.invocationFingerprint,
      startedAt: now.toISOString(),
      completedAt: new Date(now.getTime() + 5).toISOString(),
      durationMs: 5,
      isError: false,
      output: "trusted file contents",
      truncated: false,
      resultHash: "f".repeat(64),
      omittedBlocks: 0
    };
  }
  async close() {}
}

function approvalActionHash(workItem: WorkItem, actor: string): string {
  const decision = createPolicyEngine().evaluateWorkItem(workItem, actor, "approve")[0];
  if (!decision?.actionHash) throw new Error("no approval action hash");
  return decision.actionHash;
}

let dir: string;
let root: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "acs-verify-enforce-"));
  root = realpathSync(dir);
  mkdirSync(join(root, "pkg"));
  writeFileSync(join(root, "pkg", "a.txt"), "on disk");
  dbPath = join(dir, "control.db");
  vi.stubEnv("ACS_EXECUTION_BACKEND", "desktop_commander");
  vi.stubEnv("ACS_DESKTOP_COMMANDER_COMMAND", "node");
  vi.stubEnv("ACS_DESKTOP_COMMANDER_ARGS_JSON", JSON.stringify(["/nonexistent/dc.js"]));
  vi.stubEnv("ACS_DESKTOP_COMMANDER_ALLOWED_ROOTS", root);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function seedRead(): string {
  const store = new SqliteWorkItemStore(dbPath);
  const tools = createWorkItemTools(store, createPolicyEngine());
  try {
    const workItem = tools.create_work_item({
      title: "read for verification",
      requester: "user",
      intent: "read-only governed execution",
      target: { cwd: "/repo" },
      requestedActions: [
        {
          kind: "fs.read",
          description: "inspect",
          params: {
            paths: ["src/index.ts"],
            tool: "read_file",
            arguments: { path: join(root, "pkg", "a.txt") }
          }
        }
      ],
      risk: "low"
    });
    return workItem.id;
  } finally {
    store.close();
  }
}

function seedWrite(): string {
  const store = new SqliteWorkItemStore(dbPath);
  const tools = createWorkItemTools(store, createPolicyEngine());
  try {
    const workItem = tools.create_work_item({
      title: "write for verification",
      requester: "user",
      intent: "mutating governed execution",
      target: { cwd: "/repo" },
      requestedActions: [
        {
          kind: "fs.write",
          description: "write",
          params: {
            paths: ["src/index.ts"],
            tool: "write_file",
            arguments: { path: join(root, "pkg", "a.txt"), content: "updated" }
          }
        }
      ],
      risk: "low"
    });
    tools.approve_work_item({
      id: workItem.id,
      approvedBy: "user",
      reason: "approved write",
      actionHash: approvalActionHash(workItem, "user")
    });
    return workItem.id;
  } finally {
    store.close();
  }
}

function attemptIdFor(workItemId: string): string {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare(`SELECT attempt_id FROM execution_attempts WHERE work_item_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(workItemId) as { attempt_id: string } | undefined;
    if (!row?.attempt_id) throw new Error(`no attempt for ${workItemId}`);
    return row.attempt_id;
  } finally {
    db.close();
  }
}

function attemptAuthority(workItemId: string, store: SqliteWorkItemStore): {
  attemptId: string;
  planHash: string;
  inputHash: string;
  leaseId: string;
  workerId: string;
  fencingEpoch: number;
  actionHash: string;
  startedAt: string;
  leaseExpiresAt: string;
} {
  const workItem = store.get(workItemId);
  if (!workItem) throw new Error(`missing work item ${workItemId}`);
  const attemptId = attemptIdFor(workItemId);
  const lease = store.getActiveLeaseForAttempt(attemptId);
  if (!lease) throw new Error(`no lease for ${attemptId}`);
  const attempt = store.getAttempt(attemptId);
  if (!attempt?.startedAt) throw new Error(`no started attempt for ${attemptId}`);
  return {
    attemptId,
    planHash: lease.planHash,
    inputHash: lease.inputHash,
    actionHash: executionActionHash(workItem),
    leaseId: lease.leaseId,
    workerId: lease.workerId,
    fencingEpoch: lease.fencingEpoch,
    startedAt: attempt.startedAt,
    leaseExpiresAt: lease.expiresAt
  };
}

function recordedWorkspaceIdentity(store: SqliteWorkItemStore, attemptId: string): string {
  const observations = store.getEvidenceManifestForAttempt(attemptId)?.manifest.observations;
  if (!Array.isArray(observations)) throw new Error(`no observations for ${attemptId}`);
  const identity = observations.find(
    (row) => typeof row === "object" && row !== null && "kind" in row && row.kind === "workspace.identity"
  ) as { value?: unknown } | undefined;
  if (typeof identity?.value !== "string") throw new Error(`no workspace.identity observation for ${attemptId}`);
  return identity.value;
}

function authoritativeSucceededResult(claimed: {
  id: string;
  attemptId: string;
  planHash: string;
  inputHash: string;
  fencingEpoch: number;
  leaseId: string;
  workerId: string;
  actionHash: string;
  startedAt: string;
}) {
  return {
    workItemId: claimed.id,
    attemptId: claimed.attemptId,
    leaseId: claimed.leaseId,
    workerId: claimed.workerId,
    actionHash: claimed.actionHash,
    planHash: claimed.planHash,
    inputHash: claimed.inputHash,
    fencingEpoch: claimed.fencingEpoch,
    idempotencyKey: workerResultIdempotencyKey(claimed.attemptId),
    outcome: "succeeded" as const,
    startedAt: claimed.startedAt,
    finishedAt: new Date(Date.parse(claimed.startedAt) + 10).toISOString(),
    exitCode: 0,
    summary: "forged success after governed execution",
    structuredOutput: { simulated: false },
    artifacts: [],
    simulationMetadata: {
      executionMode: "desktop_commander" as const,
      simulated: false as const,
      backend: "desktop-commander-mcp" as const,
      toolName: "write_file",
      invocationFingerprint: "a".repeat(64),
      requestId: "request-forged"
    }
  };
}

describe("resolveVerificationPolicyMode", () => {
  it("defaults to off and rejects unknown values", () => {
    expect(resolveVerificationPolicyMode({})).toBe("off");
    expect(resolveVerificationPolicyMode({ ACS_VERIFICATION_POLICY: "off" })).toBe("off");
    expect(resolveVerificationPolicyMode({ ACS_VERIFICATION_POLICY: "enforce" })).toBe("enforce");
    expect(() => resolveVerificationPolicyMode({ ACS_VERIFICATION_POLICY: "maybe" })).toThrow(
      /unknown ACS_VERIFICATION_POLICY/
    );
  });
});

describe("ADR 0015 worker verification enforcement", () => {
  it("policy off: successful desktop_commander execution is unchanged and records no governance artifacts", async () => {
    vi.stubEnv("ACS_VERIFICATION_POLICY", "off");
    const id = seedRead();
    const executor = new FakeExecutor();

    const result = await runWorkerOnce({ dbPath, workerId: "dc-worker", machineExecutor: executor });

    expect(result).toMatchObject({ executed: true, executionMode: "desktop_commander", workItemId: id });
    expect(result.reason).not.toBe("awaiting_independent_verification");

    const store = new SqliteWorkItemStore(dbPath);
    try {
      expect(store.get(id)?.status).toBe("succeeded");
      const attemptId = attemptIdFor(id);
      expect(store.getEvidenceManifestForAttempt(attemptId)).toBeUndefined();
      expect(store.getVerificationRequirement(attemptId)).toBeUndefined();
      const events = store.readEvents({ limit: 500 }).map((e) => e.name);
      expect(events).toContain("work_item.succeeded");
      expect(events).not.toContain("evidence.manifest_recorded");
    } finally {
      store.close();
    }
  });

  it("policy enforce + zero reviewers: records evidence, auto-accepts, and terminal success proceeds", async () => {
    vi.stubEnv("ACS_VERIFICATION_POLICY", "enforce");
    const id = seedRead();
    const executor = new FakeExecutor();

    const result = await runWorkerOnce({ dbPath, workerId: "dc-worker", machineExecutor: executor });

    expect(result).toMatchObject({ executed: true, executionMode: "desktop_commander", workItemId: id });
    expect(result.reason).not.toBe("awaiting_independent_verification");

    const store = new SqliteWorkItemStore(dbPath);
    try {
      expect(store.get(id)?.status).toBe("succeeded");
      const attemptId = attemptIdFor(id);
      const manifest = store.getEvidenceManifestForAttempt(attemptId);
      expect(manifest?.attemptId).toBe(attemptId);
      expect(root).toMatch(/\//u);
      expect(recordedWorkspaceIdentity(store, attemptId)).toBe(workspaceIdentityFromContainment([root]));
      expect(recordedWorkspaceIdentity(store, attemptId)).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
      expect(recordedWorkspaceIdentity(store, attemptId)).not.toContain(root);
      expect(recordedWorkspaceIdentity(store, attemptId)).not.toMatch(/[\\/]/u);
      expect(store.getVerificationRequirement(attemptId)?.reviewersRequired).toBe(0);
      expect(store.getVerificationDecision(attemptId)?.outcome).toBe("attempt_accepted");
      expect(store.getAttemptPhase(attemptId)).toBe("accepted");
      expect(store.isVerificationSatisfiedForAttempt(attemptId).satisfied).toBe(true);
      const events = store.readEvents({ limit: 500 }).map((e) => e.name);
      expect(events).toContain("evidence.manifest_recorded");
      expect(events).toContain("verification.decision");
      expect(events).toContain("work_item.succeeded");
    } finally {
      store.close();
    }
  });

  it("policy enforce + required reviewers: pauses at reviewing and never publishes terminal success", async () => {
    // Reviewer completion is intentionally out of this checkpoint: evidence is
    // recorded, the phase is reviewing, and ACS remains the only result authority.
    vi.stubEnv("ACS_VERIFICATION_POLICY", "enforce");
    const id = seedWrite();
    const executor = new FakeExecutor();

    const result = await runWorkerOnce({ dbPath, workerId: "dc-worker", machineExecutor: executor });

    expect(result).toEqual({
      executed: true,
      executionMode: "desktop_commander",
      workItemId: id,
      reason: "awaiting_independent_verification"
    });
    expect(executor.calls).toHaveLength(1);

    const store = new SqliteWorkItemStore(dbPath);
    try {
      expect(store.get(id)?.status).toBe("running");
      const attemptId = attemptIdFor(id);
      expect(store.getEvidenceManifestForAttempt(attemptId)).toBeDefined();
      expect(root).toMatch(/\//u);
      expect(recordedWorkspaceIdentity(store, attemptId)).toBe(workspaceIdentityFromContainment([root]));
      expect(recordedWorkspaceIdentity(store, attemptId)).not.toContain(root);
      expect(store.getVerificationRequirement(attemptId)?.reviewersRequired).toBeGreaterThanOrEqual(1);
      expect(store.getAttemptPhase(attemptId)).toBe("reviewing");
      const reviewingEvent = store.readEvents({ limit: 500 }).find((e) => e.name === "attempt.phase.reviewing");
      expect(reviewingEvent?.body).toMatchObject({
        note: expect.stringMatching(/awaiting \d+ independent reviewer/i)
      });
      expect(store.getVerificationDecision(attemptId)).toBeUndefined();
      expect(store.isVerificationSatisfiedForAttempt(attemptId)).toEqual({
        satisfied: false,
        reason: "verification requirement without an attempt_accepted decision"
      });

      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(db.prepare(`SELECT COUNT(*) AS count FROM attempt_results`).get()).toEqual({ count: 0 });
        expect(db.prepare(`SELECT status FROM execution_attempts`).get()).toEqual({ status: "running" });
      } finally {
        db.close();
      }

      const events = store.readEvents({ limit: 500 }).map((e) => e.name);
      expect(events).toContain("evidence.manifest_recorded");
      expect(events).toContain("attempt.phase.reviewing");
      expect(events).not.toContain("execution.result_persisted");
      expect(events).not.toContain("work_item.succeeded");
    } finally {
      store.close();
    }
  });

  it("fail-closed: premature submit_work_result is refused while verification is unsatisfied", async () => {
    vi.stubEnv("ACS_VERIFICATION_POLICY", "enforce");
    const id = seedWrite();
    const executor = new FakeExecutor();
    await runWorkerOnce({ dbPath, workerId: "dc-worker", machineExecutor: executor });

    const store = new SqliteWorkItemStore(dbPath);
    const tools = createWorkItemTools(store, createPolicyEngine());
    try {
      expect(tools.claim_next_approved_work_item({ workerId: "dc-worker" })).toBeUndefined();

      const authority = attemptAuthority(id, store);
      const prematureResult = authoritativeSucceededResult({
        id,
        attemptId: authority.attemptId,
        planHash: authority.planHash,
        inputHash: authority.inputHash,
        fencingEpoch: authority.fencingEpoch,
        leaseId: authority.leaseId,
        workerId: authority.workerId,
        actionHash: authority.actionHash,
        startedAt: authority.startedAt
      });

      expect(() => tools.submit_work_result(prematureResult)).toThrow(
        /cannot be accepted as succeeded: verification requirement without an attempt_accepted decision/
      );
      expect(store.get(id)?.status).toBe("running");
      expect(store.isVerificationSatisfiedForAttempt(authority.attemptId).satisfied).toBe(false);

      const db = new DatabaseSync(dbPath);
      try {
        expect(() =>
          db
            .prepare(`UPDATE verification_requirements SET reviewers_required = 0 WHERE attempt_id = ?`)
            .run(authority.attemptId)
        ).toThrow(/append-only|fixed at admission/i);
        expect(() =>
          db.prepare(`DELETE FROM verification_requirements WHERE attempt_id = ?`).run(authority.attemptId)
        ).toThrow(/append-only/i);
      } finally {
        db.close();
      }
      expect(store.getVerificationRequirement(authority.attemptId)?.reviewersRequired).toBeGreaterThanOrEqual(1);
      expect(() => tools.submit_work_result(prematureResult)).toThrow(
        /cannot be accepted as succeeded: verification requirement without an attempt_accepted decision/
      );
      expect(store.get(id)?.status).toBe("running");
    } finally {
      store.close();
    }
  });
});
