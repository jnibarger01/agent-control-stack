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
  it("allows bounded retry for a disappeared process", () => {
    expect(planRecovery({ ...base, failureClass: "process_gone" })).toMatchObject({ decision: "retryable", retryAllowed: true, retryAfterMs: 1000 });
  });
  it("never retries policy, approval, integrity, or fencing failures", () => {
    for (const failureClass of ["policy_failure", "approval_failure", "integrity_failure", "fencing_violation"] as const) {
      expect(planRecovery({ ...base, failureClass })).toMatchObject({ decision: "terminal_failed", retryAllowed: false });
    }
  });
  it("requires cleanup after validated evidence instead of rerunning the task", () => {
    expect(planRecovery({ ...base, validationPresent: true, validationPassed: true, workspacePresent: true, cleanupComplete: false })).toMatchObject({ decision: "cleanup_pending", retryAllowed: false });
  });
  it("quarantines exhausted attempts rather than looping", () => {
    expect(planRecovery({ ...base, attemptNumber: 3, failureClass: "engine_timeout" })).toMatchObject({ decision: "terminal_failed", retryAllowed: false });
  });
});
