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
});
