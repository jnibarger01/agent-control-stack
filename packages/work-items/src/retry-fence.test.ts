import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stableHash } from "@agent-control-stack/shared";
import { afterEach, describe, expect, it } from "vitest";
import { Worker } from "node:worker_threads";
import { SqliteWorkItemStore, defaultExecutionPlanForWorkItem } from "./index.js";

const raceWorkerUrl = new URL("./concurrency-race-worker.ts", import.meta.url);

/**
 * Retry fence. An attempt whose outcome is uncertain (`unknown`, `quarantined`) or still live blocks
 * replacement attempts, retries and re-entry until verified cleanup evidence bound to that attempt's
 * lease, fencing epoch and execution unit is recorded. Missing, stale or contradictory evidence keeps
 * the fence held. The fence is derived from durable rows, so it survives restart.
 */

const T0 = new Date("2026-11-20T10:00:00.000Z");
const hex = (seed: string) => seed.repeat(64).slice(0, 64);
const UNIT = "acs-sandbox-attempt-1-0a1b2c3d.scope";

interface Fixture {
  directory: string;
  dbPath: string;
  store: SqliteWorkItemStore;
  workItem: ReturnType<SqliteWorkItemStore["create"]>;
  planHash: string;
  admissionId: string;
}

function openFixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "acs-retry-fence-"));
  const dbPath = join(directory, "control.db");
  const store = new SqliteWorkItemStore(dbPath);
  const workItem = store.create({
    title: "Retry fence fixture",
    requester: "user",
    requesterSubject: "actor-user",
    intent: "prove the retry fence over uncertain attempts",
    target: { cwd: "/repo", files: ["src/index.ts"] },
    requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["src/index.ts"], write: false } }],
    risk: "low"
  });
  const plan = store.createExecutionPlan({
    workItemId: workItem.id,
    definition: defaultExecutionPlanForWorkItem(workItem),
    createdByActorId: "actor-user"
  });
  const admission = store.admitExecutionPlan(
    {
      workItemId: workItem.id,
      planHash: plan.planHash,
      policyVersion: "acs.policy.v1",
      policyDecisionHash: hex("1"),
      requiresApproval: false,
      admittedByActorId: "policy-gate"
    },
    { via: "policy_gate" }
  );
  return { directory, dbPath, store, workItem, planHash: plan.planHash, admissionId: admission.admissionId };
}

/**
 * Attempt 1 is claimed through the production attempt-authority path, runs, and its lease expires
 * without a result. Its attempt and work item become uncertain.
 */
function unknownAttemptFixture(): Fixture & { attemptId: string; leaseId: string; fencingEpoch: number } {
  const fixture = openFixture();
  fixture.store.approveWorkItem(fixture.workItem.id, { via: "domain_service" });
  const claimed = fixture.store.claimNextApprovedWorkItem("worker-1", {
    leaseMs: 60_000,
    attemptAuthority: {
      planHash: fixture.planHash,
      admissionId: fixture.admissionId,
      policyVersion: "acs.policy.v1",
      policyDecisionHash: hex("1")
    }
  });
  if (!claimed?.attemptId || !claimed.leaseId || claimed.fencingEpoch === undefined) {
    throw new Error("expected an attempt-authority claim");
  }
  fixture.store.recordWorkspaceAllocation(
    {
      allocationId: "workspace_1",
      workItemId: fixture.workItem.id,
      attemptId: claimed.attemptId,
      leaseId: claimed.leaseId,
      workerId: "worker-1",
      fencingEpoch: claimed.fencingEpoch,
      hostPath: "/repo/wrk_1",
      branch: "acs/job/wrk_1",
      baseRef: "main"
    },
    { via: "domain_service" }
  );
  fixture.store.failExpiredLeases(new Date(Date.now() + 3_600_000));
  expect(fixture.store.getAttempt(claimed.attemptId)?.status).toBe("unknown");
  return {
    ...fixture,
    attemptId: claimed.attemptId,
    leaseId: claimed.leaseId,
    fencingEpoch: claimed.fencingEpoch
  };
}

function scopeInput(f: { attemptId: string; leaseId: string; fencingEpoch: number; workItem: { id: string } }) {
  return {
    attemptId: f.attemptId,
    workItemId: f.workItem.id,
    leaseId: f.leaseId,
    fencingEpoch: f.fencingEpoch,
    unitName: UNIT,
    now: new Date(T0.getTime() + 130_000)
  };
}

function evidenceInput(f: { attemptId: string; leaseId: string; fencingEpoch: number; workItem: { id: string } }) {
  return {
    attemptId: f.attemptId,
    workItemId: f.workItem.id,
    leaseId: f.leaseId,
    fencingEpoch: f.fencingEpoch,
    unitName: UNIT,
    verdict: "verified" as const,
    evidenceHash: stableHash({ domain: "acs.test.cleanup", attemptId: f.attemptId, unit: UNIT }),
    effectsDisposition: "no_external_effects" as const,
    effectsEvidenceHash: stableHash({ domain: "acs.test.external-effects", attemptId: f.attemptId }),
    observedAt: new Date(T0.getTime() + 131_000).toISOString(),
    now: new Date(T0.getTime() + 132_000)
  };
}

/** Drives a work item to a terminal `succeeded` source, as the existing retry-lineage tests do. */
function completeSource(f: Fixture): void {
  f.store.approveWorkItem(f.workItem.id, { via: "domain_service" });
  const claimed = f.store.claimNextApprovedWorkItem("worker-a", { allowLegacyClaimForTests: true });
  if (!claimed) throw new Error("expected source claim");
  f.store.submitWorkResult({
    workItemId: claimed.id,
    leaseId: claimed.leaseId,
    workerId: claimed.workerId,
    actionHash: claimed.actionHash,
    idempotencyKey: stableHash({ source: claimed.id, lease: claimed.leaseId }),
    outcome: "succeeded",
    startedAt: claimed.startedAt,
    finishedAt: new Date(Date.parse(claimed.startedAt) + 10).toISOString(),
    exitCode: 0,
    summary: "source completed in dry-run",
    structuredOutput: { simulated: true },
    artifacts: [],
    simulationMetadata: { executionMode: "dry_run", simulated: true }
  });
}

function codeOf(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

let directory: string | undefined;
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("retry fence: unproven execution blocks replacement attempts", () => {
  it("refuses a replacement attempt while the previous attempt is unknown and unproven", () => {
    const f = unknownAttemptFixture();
    directory = f.directory;
    expect(
      codeOf(() =>
        f.store.createAttempt(
          { workItemId: f.workItem.id, planHash: f.planHash, inputHash: hex("b") },
          { via: "domain_service" }
        )
      )
    ).toBe("execution_fence_held");
  });

  it("refuses a retry of a work item whose attempt is unproven", () => {
    const f = unknownAttemptFixture();
    directory = f.directory;
    // The source is terminal after lease expiry, so the lineage rule does not refuse it. Only the
    // unproven attempt does.
    expect(["succeeded", "failed", "cancelled", "rejected"]).toContain(f.store.get(f.workItem.id)?.status);
    expect(codeOf(() => f.store.retryWorkItem(f.workItem.id, { actor: "user", reason: "try again" }))).toBe(
      "execution_fence_held"
    );
  });

  it("refuses re-entry and a new authoritative claim while the claimed attempt may still be live", () => {
    const f = openFixture();
    directory = f.directory;
    f.store.approveWorkItem(f.workItem.id, { via: "domain_service" });
    const claimed = f.store.claimNextApprovedWorkItem("worker-1", {
      leaseMs: 60_000,
      attemptAuthority: {
        planHash: f.planHash,
        admissionId: f.admissionId,
        policyVersion: "acs.policy.v1",
        policyDecisionHash: hex("1")
      }
    });
    if (!claimed?.attemptId) throw new Error("expected an attempt-authority claim");
    // Crash-recovery reclassification: the work item becomes unknown with no accepted result, while
    // the attempt's process may still be running. The state machine permits unknown -> quarantined
    // -> pending_policy, which is exactly the re-entry an unfenced store would allow.
    f.store.transition(f.workItem.id, "unknown");
    f.store.transition(f.workItem.id, "quarantined");
    f.store.transition(f.workItem.id, "pending_policy", { via: "domain_service" });
    f.store.approveWorkItem(f.workItem.id, { via: "domain_service" });
    expect(
      codeOf(() =>
        f.store.claimNextApprovedWorkItem("worker-2", {
          leaseMs: 60_000,
          attemptAuthority: {
            planHash: f.planHash,
            admissionId: f.admissionId,
            policyVersion: "acs.policy.v1",
            policyDecisionHash: hex("1")
          }
        })
      )
    ).toBe("execution_fence_held");
    expect(f.store.get(f.workItem.id)?.status).toBe("approved");
  });

  it("refuses a second retry while the first retry is still in flight", () => {
    const f = openFixture();
    directory = f.directory;
    completeSource(f);
    f.store.retryWorkItem(f.workItem.id, { actor: "user", reason: "first retry" });
    expect(codeOf(() => f.store.retryWorkItem(f.workItem.id, { actor: "user", reason: "second retry" }))).toBe(
      "retry_already_in_flight"
    );
  });

  it("admits at most one of two concurrent retries from separate processes", async () => {
    const f = openFixture();
    directory = f.directory;
    completeSource(f);
    f.store.close();
    const barrier = new SharedArrayBuffer(4);
    const workers = [0, 1].map(
      () =>
        new Worker(raceWorkerUrl, {
          execArgv: ["--import", "tsx"],
          workerData: {
            kind: "retry",
            dbPath: f.dbPath,
            workItemId: f.workItem.id,
            actor: "user",
            barrier
          }
        })
    );
    const results = await Promise.all(
      workers.map(
        (worker) =>
          new Promise<{ ok: boolean; error?: { code?: string } }>((resolve, reject) => {
            worker.once("message", resolve);
            worker.once("error", reject);
          })
      )
    );
    await Promise.all(workers.map((worker) => worker.terminate()));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const refused = results.find((result) => !result.ok);
    expect(refused?.error?.code).toBe("retry_already_in_flight");
    const check = new SqliteWorkItemStore(f.dbPath);
    expect(check.readEvents().filter((event) => event.name === "work_item.retried")).toHaveLength(1);
    check.close();
  });

  it("refuses a live attempt as evidence of cleanup", () => {
    const f = openFixture();
    directory = f.directory;
    const attempt = f.store.createAttempt(
      { workItemId: f.workItem.id, planHash: f.planHash, inputHash: hex("a") },
      { via: "domain_service" }
    );
    const lease = f.store.leaseAttempt(
      {
        attemptId: attempt.attemptId,
        workItemId: f.workItem.id,
        admissionId: f.admissionId,
        workerId: "worker-1",
        leaseToken: "a".repeat(32),
        policyVersion: "acs.policy.v1",
        policyDecisionHash: hex("1"),
        ttlMs: 60_000,
        now: T0
      },
      { via: "domain_service" }
    );
    const live = {
      attemptId: attempt.attemptId,
      workItemId: f.workItem.id,
      leaseId: lease.leaseId,
      fencingEpoch: lease.fencingEpoch,
      workItem: f.workItem
    };
    f.store.recordExecutionScope(scopeInput(live), { via: "domain_service" });
    expect(codeOf(() => f.store.recordVerifiedCleanup(evidenceInput(live), { via: "domain_service" }))).toBe(
      "attempt_still_live"
    );
  });

  it("keeps the fence held when the cleanup scope was never recorded (missing evidence fails closed)", () => {
    const f = unknownAttemptFixture();
    directory = f.directory;
    expect(codeOf(() => f.store.recordVerifiedCleanup(evidenceInput(f), { via: "domain_service" }))).toBe(
      "execution_scope_missing"
    );
    expect(
      codeOf(() =>
        f.store.createAttempt(
          { workItemId: f.workItem.id, planHash: f.planHash, inputHash: hex("b") },
          { via: "domain_service" }
        )
      )
    ).toBe("execution_fence_held");
  });

  it("refuses to release the fence on process cleanup alone without external-effects disposition", () => {
    const f = unknownAttemptFixture();
    directory = f.directory;
    f.store.recordExecutionScope(scopeInput(f), { via: "domain_service" });
    const cleanupOnly = {
      ...evidenceInput(f),
      effectsDisposition: undefined,
      effectsEvidenceHash: undefined
    };
    expect(() =>
      f.store.recordVerifiedCleanup(
        cleanupOnly as unknown as ReturnType<typeof evidenceInput>,
        { via: "domain_service" }
      )
    ).toThrow();
    expect(
      codeOf(() =>
        f.store.createAttempt(
          { workItemId: f.workItem.id, planHash: f.planHash, inputHash: hex("c") },
          { via: "domain_service" }
        )
      )
    ).toBe("execution_fence_held");
  });

  it("releases the fence on verified cleanup bound to attempt, lease, epoch and unit, idempotently", () => {
    const f = unknownAttemptFixture();
    directory = f.directory;
    f.store.recordExecutionScope(scopeInput(f), { via: "domain_service" });
    const first = f.store.recordVerifiedCleanup(evidenceInput(f), { via: "domain_service" });
    const again = f.store.recordVerifiedCleanup(evidenceInput(f), { via: "domain_service" });
    expect(again).toEqual(first);
    expect(() =>
      f.store.createAttempt(
        { workItemId: f.workItem.id, planHash: f.planHash, inputHash: hex("b") },
        { via: "domain_service" }
      )
    ).not.toThrow();
  });

  it("refuses contradictory cleanup evidence and keeps the fence held", () => {
    const f = unknownAttemptFixture();
    directory = f.directory;
    f.store.recordExecutionScope(scopeInput(f), { via: "domain_service" });
    f.store.recordVerifiedCleanup(evidenceInput(f), { via: "domain_service" });
    const contradictory = { ...evidenceInput(f), evidenceHash: hex("f") };
    expect(codeOf(() => f.store.recordVerifiedCleanup(contradictory, { via: "domain_service" }))).toBe(
      "cleanup_evidence_contradiction"
    );
    const contradictedEffects = { ...evidenceInput(f), effectsEvidenceHash: hex("e") };
    expect(codeOf(() => f.store.recordVerifiedCleanup(contradictedEffects, { via: "domain_service" }))).toBe(
      "cleanup_evidence_contradiction"
    );
    const contradictedDisposition = { ...evidenceInput(f), effectsDisposition: "reconciled" as const };
    expect(codeOf(() => f.store.recordVerifiedCleanup(contradictedDisposition, { via: "domain_service" }))).toBe(
      "cleanup_evidence_contradiction"
    );
  });

  it("refuses scope or evidence bound to a different lease, epoch or unit", () => {
    const f = unknownAttemptFixture();
    directory = f.directory;
    expect(
      codeOf(() =>
        f.store.recordExecutionScope({ ...scopeInput(f), leaseId: "lease_stale" }, { via: "domain_service" })
      )
    ).toBe("execution_scope_binding_mismatch");
    expect(
      codeOf(() =>
        f.store.recordExecutionScope({ ...scopeInput(f), fencingEpoch: f.fencingEpoch + 1 }, { via: "domain_service" })
      )
    ).toBe("execution_scope_binding_mismatch");
    f.store.recordExecutionScope(scopeInput(f), { via: "domain_service" });
    expect(
      codeOf(() =>
        f.store.recordVerifiedCleanup(
          { ...evidenceInput(f), unitName: "acs-sandbox-other.scope" },
          { via: "domain_service" }
        )
      )
    ).toBe("cleanup_evidence_binding_mismatch");
  });

  it("survives restart: the fence is still held on a reopened store, and still released after verified cleanup", () => {
    const f = unknownAttemptFixture();
    directory = f.directory;
    f.store.recordExecutionScope(scopeInput(f), { via: "domain_service" });
    const reopened = new SqliteWorkItemStore(f.dbPath);
    expect(
      codeOf(() =>
        reopened.createAttempt(
          { workItemId: f.workItem.id, planHash: f.planHash, inputHash: hex("b") },
          { via: "domain_service" }
        )
      )
    ).toBe("execution_fence_held");
    reopened.recordVerifiedCleanup(evidenceInput(f), { via: "domain_service" });
    const afterRestart = new SqliteWorkItemStore(f.dbPath);
    expect(() =>
      afterRestart.createAttempt(
        { workItemId: f.workItem.id, planHash: f.planHash, inputHash: hex("b") },
        { via: "domain_service" }
      )
    ).not.toThrow();
  });
});
