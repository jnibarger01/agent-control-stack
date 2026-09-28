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

  it("never evicts live buckets under capacity pressure; new keys fail closed instead", () => {
    const lockout = new AuthFailureLockout({ windowMs: 60_000, maxFailures: 3, maxBuckets: 2 });
    lockout.recordFailure("a", 0);
    lockout.recordFailure("b", 1);

    const refused = lockout.recordFailure("c", 2);
    expect(refused).toMatchObject({ locked: true, justLocked: false });
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);

    // Tracked streaks are untouched by the refused admission.
    expect(lockout.isLocked("a", 3)).toMatchObject({ locked: false, failures: 1 });
    expect(lockout.isLocked("b", 3)).toMatchObject({ locked: false, failures: 1 });
  });

  it("fails closed when capacity is entirely locked, and stays consistent on re-check", () => {
    const lockout = new AuthFailureLockout({ windowMs: 1_000, maxFailures: 1, maxBuckets: 2 });
    expect(lockout.recordFailure("a", 0).locked).toBe(true);
    expect(lockout.recordFailure("b", 10).locked).toBe(true);

    const refused = lockout.recordFailure("c", 20);
    expect(refused).toMatchObject({ locked: true, failures: 1, justLocked: false });
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    expect(lockout.isLocked("a", 20).locked).toBe(true);
    expect(lockout.isLocked("b", 20).locked).toBe(true);

    // The refused decision is backed by persisted state: the key is still
    // locked on its next request instead of reaching credential verification.
    expect(lockout.isLocked("c", 21)).toMatchObject({ locked: true, justLocked: false });

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

  it("keeps in-progress streaks alive through interleaved device-verification traffic", () => {
    // Regression test for the evicted-streak finding: distinct device codes
    // must not displace a login streak that has not reached maxFailures.
    const lockout = new AuthFailureLockout({ windowMs: 60_000, maxFailures: 3, maxBuckets: 4 });
    lockout.recordFailure("login:ip:1", 0);
    lockout.recordFailure("login:ip:1", 1);

    // Flood with distinct device-code keys until the map saturates; the
    // overflow keys fail closed while tracked keys keep counting.
    for (let i = 0; i < 10; i++) {
      lockout.recordFailure(`device_verify:code:CODE-${i}`, 2 + i);
    }

    // The login streak was never evicted: its third failure locks it.
    const third = lockout.recordFailure("login:ip:1", 20);
    expect(third).toMatchObject({ locked: true, failures: 3, justLocked: true });
    expect(lockout.isLocked("login:ip:1", 21).locked).toBe(true);
  });

  it("still records failures for tracked keys while saturated", () => {
    const lockout = new AuthFailureLockout({ windowMs: 60_000, maxFailures: 3, maxBuckets: 2 });
    lockout.recordFailure("a", 0);
    lockout.recordFailure("b", 1);
    expect(lockout.recordFailure("c", 2).locked).toBe(true);

    expect(lockout.recordFailure("a", 3)).toMatchObject({ locked: false, failures: 2 });
    expect(lockout.recordFailure("a", 4)).toMatchObject({ locked: true, failures: 3, justLocked: true });
  });

  it("records device-verification ip+code pairs atomically at small capacity", () => {
    const lockout = new AuthFailureLockout({ windowMs: 60_000, maxFailures: 2, maxBuckets: 2 });
    const ip = "device_verify:ip:9.9.9.9";
    const code = "device_verify:code:AAAA-BBBB";

    expect(lockout.recordFailures([ip, code], 0).map((d) => d.locked)).toEqual([false, false]);
    const second = lockout.recordFailures([ip, code], 1);
    expect(second).toMatchObject([
      { locked: true, failures: 2, justLocked: true },
      { locked: true, failures: 2, justLocked: true }
    ]);
    expect(lockout.isLocked(ip, 2).locked).toBe(true);
    expect(lockout.isLocked(code, 2).locked).toBe(true);
  });

  it("fails the whole device pair closed when two slots cannot be retained", () => {
    const lockout = new AuthFailureLockout({ windowMs: 60_000, maxFailures: 2, maxBuckets: 2 });
    lockout.recordFailure("other", 0);
    const ip = "device_verify:ip:9.9.9.9";
    const code = "device_verify:code:AAAA-BBBB";

    // Only one slot is free: admitting the pair partially would let the two
    // buckets displace each other, so both fail closed instead.
    const decisions = lockout.recordFailures([ip, code], 1);
    expect(decisions.map((d) => d.locked)).toEqual([true, true]);
    expect(decisions.every((d) => d.justLocked === false)).toBe(true);

    // The pre-existing bucket is untouched.
    expect(lockout.isLocked("other", 2)).toMatchObject({ locked: false, failures: 1 });

    // No partial admission persisted: after the overflow window, neither key
    // has a bucket of its own.
    expect(lockout.isLocked(ip, 60_001)).toMatchObject({ locked: false, failures: 0 });
    expect(lockout.isLocked(code, 60_001)).toMatchObject({ locked: false, failures: 0 });
  });

  it("a first failure under saturation returns a recorded locked decision, not a phantom 429", () => {
    const lockout = new AuthFailureLockout({ windowMs: 60_000, maxFailures: 5, maxBuckets: 2 });
    for (const key of ["a", "b"]) {
      for (let i = 0; i < 5; i++) lockout.recordFailure(key, i);
    }
    expect(lockout.isLocked("a", 10).locked).toBe(true);

    const first = lockout.recordFailure("new-key", 11);
    expect(first).toMatchObject({ locked: true, justLocked: false });
    expect(first.retryAfterSeconds).toBeGreaterThan(0);

    // The decision is backed by the persisted overflow marker: a re-check
    // agrees instead of behaving as if the key were never seen.
    expect(lockout.isLocked("new-key", 12)).toMatchObject({ locked: true, justLocked: false });

    // The overflow ends with the tracked windows; normal recording resumes.
    expect(lockout.recordFailure("new-key", 60_001)).toMatchObject({ locked: false, failures: 1 });
  });

  it("releases saturation-only lockout as soon as a successful login frees capacity", () => {
    const lockout = new AuthFailureLockout({ windowMs: 60_000, maxFailures: 5, maxBuckets: 2 });
    lockout.recordFailure("a", 0);
    lockout.recordFailure("b", 1);
    expect(lockout.recordFailure("overflowed", 2).locked).toBe(true);
    expect(lockout.isLocked("new-ip", 3).locked).toBe(true);

    // A successful authentication clears its tracked streak. Fresh principals
    // must be admitted immediately instead of inheriting the stale overflow marker.
    lockout.clear("a");
    expect(lockout.isLocked("new-ip", 4)).toMatchObject({ locked: false, failures: 0 });
    expect(lockout.recordFailure("new-ip", 4)).toMatchObject({ locked: false, failures: 1 });
  });

  it("releases saturation-only lockout when a tracked bucket expires and frees capacity", () => {
    const lockout = new AuthFailureLockout({ windowMs: 1_000, maxFailures: 5, maxBuckets: 2 });
    lockout.recordFailure("a", 0);
    lockout.recordFailure("b", 500);
    expect(lockout.recordFailure("overflowed", 600).locked).toBe(true);

    // Reading the expired tracked key lazily reclaims it and therefore ends
    // the global saturation marker before another principal is checked.
    expect(lockout.isLocked("a", 1_000)).toMatchObject({ locked: false, failures: 0 });
    expect(lockout.isLocked("new-ip", 1_001)).toMatchObject({ locked: false, failures: 0 });
  });

  it("recordFailures handles empty and duplicate key lists", () => {
    const lockout = new AuthFailureLockout({ windowMs: 60_000, maxFailures: 3 });
    expect(lockout.recordFailures([], 0)).toEqual([]);
    const decisions = lockout.recordFailures(["a", "a"], 1);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ failures: 1, locked: false });
  });
});
