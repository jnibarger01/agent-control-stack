import { describe, expect, it } from "vitest";
import { AuthFailureLockout } from "./auth-lockout.js";

describe("AuthFailureLockout", () => {
  it("locks on the N-th failure and stays locked until the window elapses", () => {
    const lockout = new AuthFailureLockout({ windowMs: 1_000, maxFailures: 3 });

    expect(lockout.recordFailure("ip:1", 0)).toMatchObject({ locked: false, failures: 1, justLocked: false });
    expect(lockout.recordFailure("ip:1", 10)).toMatchObject({ locked: false, failures: 2, justLocked: false });
    expect(lockout.recordFailure("ip:1", 20)).toMatchObject({
      locked: true,
      failures: 3,
      justLocked: true,
      retryAfterSeconds: 1
    });
    expect(lockout.isLocked("ip:1", 30)).toMatchObject({ locked: true, justLocked: false });
    expect(lockout.recordFailure("ip:1", 40).locked).toBe(true);

    expect(lockout.isLocked("ip:1", 1_000)).toMatchObject({ locked: false, failures: 0 });
    expect(lockout.recordFailure("ip:1", 1_000)).toMatchObject({ locked: false, failures: 1 });
  });

  it("clears a principal's failure streak on success", () => {
    const lockout = new AuthFailureLockout({ windowMs: 60_000, maxFailures: 3 });
    lockout.recordFailure("ip:1", 0);
    lockout.recordFailure("ip:1", 1);
    lockout.clear("ip:1");
    expect(lockout.isLocked("ip:1", 2)).toMatchObject({ locked: false, failures: 0 });
    expect(lockout.recordFailure("ip:1", 3)).toMatchObject({ failures: 1, locked: false });
  });

  it("keeps principals isolated", () => {
    const lockout = new AuthFailureLockout({ windowMs: 60_000, maxFailures: 1 });
    expect(lockout.recordFailure("a", 0).justLocked).toBe(true);
    expect(lockout.isLocked("b", 1).locked).toBe(false);
    expect(lockout.recordFailure("b", 1).justLocked).toBe(true);
  });

  it("rejects capacities below the two buckets required by device verification", () => {
    for (const maxBuckets of [0, 1, 1.5]) {
      expect(
        () => new AuthFailureLockout({ windowMs: 60_000, maxFailures: 3, maxBuckets })
      ).toThrow("auth-lockout maxBuckets must be an integer of at least 2");
    }
  });

  it("evicts only the least-recently-checked non-locked bucket", () => {
    const lockout = new AuthFailureLockout({ windowMs: 60_000, maxFailures: 2, maxBuckets: 2 });
    lockout.recordFailure("locked", 0);
    expect(lockout.recordFailure("locked", 1).locked).toBe(true);
    lockout.recordFailure("candidate", 2);

    // "locked" is older but security state must survive capacity churn.
    lockout.recordFailure("new", 3);
    expect(lockout.isLocked("locked", 4).locked).toBe(true);
    expect(lockout.isLocked("candidate", 4)).toMatchObject({ locked: false, failures: 0 });
    expect(lockout.isLocked("new", 4)).toMatchObject({ locked: false, failures: 1 });
  });

  it("fails closed when capacity is entirely locked", () => {
    const lockout = new AuthFailureLockout({ windowMs: 1_000, maxFailures: 1, maxBuckets: 2 });
    expect(lockout.recordFailure("a", 0).locked).toBe(true);
    expect(lockout.recordFailure("b", 10).locked).toBe(true);

    const refused = lockout.recordFailure("c", 20);
    expect(refused).toMatchObject({ locked: true, failures: 1, justLocked: false });
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    expect(lockout.isLocked("a", 20).locked).toBe(true);
    expect(lockout.isLocked("b", 20).locked).toBe(true);

    // Once the protected windows expire, capacity is reclaimed normally.
    expect(lockout.recordFailure("c", 1_100)).toMatchObject({ locked: true, failures: 1 });
  });

  it("reclaims expired buckets before applying capacity pressure", () => {
    const lockout = new AuthFailureLockout({ windowMs: 1_000, maxFailures: 3, maxBuckets: 2 });
    lockout.recordFailure("a", 0);
    lockout.recordFailure("b", 10);
    lockout.recordFailure("c", 5_000);
    expect(lockout.isLocked("a", 5_001)).toMatchObject({ locked: false, failures: 0 });
    expect(lockout.isLocked("b", 5_001)).toMatchObject({ locked: false, failures: 0 });
    expect(lockout.isLocked("c", 5_001)).toMatchObject({ locked: false, failures: 1 });
  });

});
