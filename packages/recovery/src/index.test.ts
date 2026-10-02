import { describe, expect, it } from "vitest";
import { planRecovery } from "./index.js";

const base = {
  attemptNumber: 1,
  maxAttempts: 3,
  attemptStatus: "unknown" as const,
  processAlive: false,
  leaseActive: false,
  leaseExpired: true,
  workspacePresent: false,
  validationPresent: false,
  validationPassed: false,
  cleanupComplete: true
};

describe("planRecovery", () => {
  it("allows bounded retry only for confirmed non-execution", () => {
    expect(
      planRecovery({
        ...base,
        attemptStatus: "pending",
        executionDisposition: "not_started",
        failureClass: "process_gone"
      })
    ).toMatchObject({ decision: "retryable", retryAllowed: true, retryAfterMs: 1000 });
  });
  it.each(["process_gone", "engine_timeout", "unknown"] as const)(
    "never replays an unknown outcome after %s",
    (failureClass) => {
      expect(planRecovery({ ...base, failureClass })).toMatchObject({
        decision: "validation_pending",
        retryAllowed: false
      });
    }
  );
  it("requires fencing and cleanup even with non-execution evidence", () => {
    const unstarted = {
      ...base,
      attemptStatus: "pending" as const,
      executionDisposition: "not_started" as const,
      failureClass: "process_gone" as const
    };
    expect(planRecovery({ ...unstarted, leaseActive: true, leaseExpired: false }).retryAllowed).toBe(false);
    expect(planRecovery({ ...unstarted, processAlive: true }).retryAllowed).toBe(false);
    expect(planRecovery({ ...unstarted, workspacePresent: true }).decision).toBe("cleanup_pending");
    expect(planRecovery({ ...unstarted, attemptStatus: "running" }).retryAllowed).toBe(false);
    expect(planRecovery({ ...unstarted, maxAttempts: NaN }).retryAllowed).toBe(false);
  });
  it("never retries policy, approval, integrity, or fencing failures", () => {
    for (const failureClass of [
      "policy_failure",
      "approval_failure",
      "integrity_failure",
      "fencing_violation"
    ] as const) {
      expect(planRecovery({ ...base, failureClass })).toMatchObject({
        decision: "terminal_failed",
        retryAllowed: false
      });
    }
  });
  it("only resumes an active non-terminal attempt with live fenced ownership", () => {
    const live = { ...base, processAlive: true, leaseActive: true, leaseExpired: false };
    expect(planRecovery({ ...live, attemptStatus: "running" }).decision).toBe("resumable");
    for (const attemptStatus of ["unknown", "interrupted", "failed", "succeeded", "cancelled", "quarantined"] as const)
      expect(planRecovery({ ...live, attemptStatus }).decision).not.toBe("resumable");
    expect(planRecovery({ ...live, attemptStatus: "running", failureClass: "fencing_violation" }).decision).not.toBe(
      "resumable"
    );
  });
  it("requires cleanup after validated evidence instead of rerunning the task", () => {
    expect(
      planRecovery({
        ...base,
        validationPresent: true,
        validationPassed: true,
        workspacePresent: true,
        cleanupComplete: false
      })
    ).toMatchObject({ decision: "cleanup_pending", retryAllowed: false });
  });
  it("quarantines exhausted attempts rather than looping", () => {
    expect(
      planRecovery({
        ...base,
        attemptStatus: "pending",
        executionDisposition: "not_started",
        attemptNumber: 3,
        failureClass: "engine_timeout"
      })
    ).toMatchObject({ decision: "terminal_failed", retryAllowed: false });
  });
});
