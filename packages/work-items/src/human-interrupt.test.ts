import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStackError, stableHash } from "@agent-control-stack/shared";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteWorkItemStore, defaultExecutionPlanForWorkItem } from "./index.js";

function hex(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "acs-human-interrupt-"));
  const store = new SqliteWorkItemStore(join(directory, "control.db"));
  const workItem = store.create({
    title: "Durable HITL fixture",
    requester: "user",
    requesterSubject: "actor-user",
    intent: "pause for a human decision and resume durably",
    target: { cwd: "/repo" },
    requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["README.md"] } }],
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
  store.approveWorkItem(workItem.id, { via: "domain_service" });
  const claimed = store.claimNextApprovedWorkItem("worker-a", {
    attemptAuthority: {
      planHash: plan.planHash,
      admissionId: admission.admissionId,
      policyVersion: admission.policyVersion,
      policyDecisionHash: admission.policyDecisionHash
    }
  });
  if (!claimed?.attemptId || claimed.fencingEpoch === undefined) throw new Error("expected claim");
  return { directory, store, workItem, plan, admission, claimed };
}

describe("durable human interruption and resumption", () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });
  it("revokes stale authority, persists the checkpoint, and resumes with a new fence", () => {
    const f = fixture();
    directory = f.directory;
    const interrupt = f.store.requestHumanInterrupt(
      {
        attemptId: f.claimed.attemptId!,
        workItemId: f.claimed.id,
        workerId: f.claimed.workerId,
        fencingEpoch: f.claimed.fencingEpoch!,
        leaseToken: f.claimed.leaseToken,
        prompt: "Choose whether execution should continue",
        checkpoint: { phase: "before-write", completedSteps: ["inspect"] },
        responseSpec: { type: "boolean" },
        idempotencyKey: "hitl-request-1"
      },
      { via: "domain_service", actorId: f.claimed.workerId }
    );

    expect(f.store.getAttempt(f.claimed.attemptId!)?.status).toBe("interrupted");
    expect(f.store.getActiveLeaseForAttempt(f.claimed.attemptId!)?.status).toBe("revoked");
    expect(f.store.getPendingHumanInterruptForAttempt(f.claimed.attemptId!)?.checkpoint).toEqual({
      phase: "before-write",
      completedSteps: ["inspect"]
    });

    expect(() =>
      f.store.submitWorkResult({
        workItemId: f.claimed.id,
        attemptId: f.claimed.attemptId!,
        leaseId: f.claimed.leaseId,
        workerId: f.claimed.workerId,
        actionHash: f.claimed.actionHash,
        planHash: f.claimed.planHash!,
        inputHash: f.claimed.inputHash!,
        fencingEpoch: f.claimed.fencingEpoch!,
        idempotencyKey: stableHash({ domain: "acs.attempt-result.v1", attemptId: f.claimed.attemptId }),
        outcome: "succeeded",
        startedAt: f.claimed.startedAt,
        finishedAt: new Date().toISOString(),
        summary: "stale",
        structuredOutput: {},
        artifacts: [],
        simulationMetadata: { executionMode: "dry_run", simulated: true }
      })
    ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "attempt_fence_mismatch" }));

    const resolution = f.store.resolveHumanInterrupt(
      {
        interruptId: interrupt.interruptId,
        decision: "resume",
        resolvedByActorId: "actor-user",
        response: { continue: true },
        reason: "approved after inspection"
      },
      { via: "domain_service", actorId: "actor-user" }
    );
    expect(resolution.decision).toBe("resume");

    const resumed = f.store.resumeHumanInterrupt(
      {
        interruptId: interrupt.interruptId,
        workerId: "worker-b",
        attemptAuthority: {
          planHash: f.plan.planHash,
          admissionId: f.admission.admissionId,
          policyVersion: f.admission.policyVersion,
          policyDecisionHash: f.admission.policyDecisionHash
        }
      },
      { via: "domain_service", actorId: "worker-b" }
    );

    expect(resumed.running.attemptId).toBe(f.claimed.attemptId);
    expect(resumed.running.fencingEpoch).toBe(f.claimed.fencingEpoch! + 1);
    expect(resumed.running.workerId).toBe("worker-b");
    expect(resumed.interrupt.checkpoint).toEqual({ phase: "before-write", completedSteps: ["inspect"] });
    expect(resumed.resolution.response).toEqual({ continue: true });
    expect(f.store.listResolvedHumanInterrupts()).toHaveLength(0);
    expect(f.store.readEvents().map((event) => event.name)).toEqual(
      expect.arrayContaining(["human_interrupt.requested", "human_interrupt.resolved", "human_interrupt.resumed"])
    );
  });

  it("lets a human cancel an interrupted attempt without restoring execution authority", () => {
    const f = fixture();
    directory = f.directory;
    const interrupt = f.store.requestHumanInterrupt(
      {
        attemptId: f.claimed.attemptId!,
        workItemId: f.claimed.id,
        workerId: f.claimed.workerId,
        fencingEpoch: f.claimed.fencingEpoch!,
        leaseToken: f.claimed.leaseToken,
        prompt: "Continue?",
        checkpoint: { phase: "review" },
        idempotencyKey: "hitl-request-cancel"
      },
      { via: "domain_service", actorId: f.claimed.workerId }
    );
    f.store.resolveHumanInterrupt(
      {
        interruptId: interrupt.interruptId,
        decision: "cancel",
        resolvedByActorId: "actor-user",
        reason: "stop here"
      },
      { via: "domain_service", actorId: "actor-user" }
    );

    expect(f.store.getAttempt(f.claimed.attemptId!)?.status).toBe("cancelled");
    expect(f.store.get(f.claimed.id)?.status).toBe("cancelled");
    expect(() =>
      f.store.resumeHumanInterrupt(
        {
          interruptId: interrupt.interruptId,
          workerId: "worker-b",
          attemptAuthority: {
            planHash: f.plan.planHash,
            admissionId: f.admission.admissionId,
            policyVersion: f.admission.policyVersion,
            policyDecisionHash: f.admission.policyDecisionHash
          }
        },
        { via: "domain_service", actorId: "worker-b" }
      )
    ).toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "human_interrupt_resume_not_authorized" })
    );
  });
});
