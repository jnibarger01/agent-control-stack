import { describe, expect, it } from "vitest";
import { SlidingWindowRateLimiter } from "./rate-limit.js";

describe("SlidingWindowRateLimiter", () => {
  it("limits a principal within the window and resets afterward", () => {
    const limiter = new SlidingWindowRateLimiter({ windowMs: 1_000, maxRequests: 2 });

    expect(limiter.check("principal", 0)).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.check("principal", 100)).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.check("principal", 200)).toMatchObject({ allowed: false, remaining: 0, retryAfterSeconds: 1 });
    expect(limiter.check("principal", 1_000)).toMatchObject({ allowed: true, remaining: 1 });
  });

  it("keeps principals isolated", () => {
    const limiter = new SlidingWindowRateLimiter({ windowMs: 1_000, maxRequests: 1 });
    expect(limiter.check("a", 0).allowed).toBe(true);
    expect(limiter.check("b", 0).allowed).toBe(true);
    expect(limiter.check("a", 1).allowed).toBe(false);
  });

  it("rejects a non-positive maxBuckets", () => {
    expect(() => new SlidingWindowRateLimiter({ windowMs: 1_000, maxRequests: 1, maxBuckets: 0 })).toThrow(
      /maxBuckets/
    );
  });

  it("evicts expired buckets before reclaiming capacity", () => {
    const limiter = new SlidingWindowRateLimiter({ windowMs: 1_000, maxRequests: 1, maxBuckets: 2 });
    expect(limiter.check("a", 0).allowed).toBe(true);
    expect(limiter.check("b", 0).allowed).toBe(true);
    // "a" and "b" are expired at t=1_000, so both are reclaimed rather than evicted.
    expect(limiter.check("c", 1_000).allowed).toBe(true);
    expect(limiter.check("c", 1_500).allowed).toBe(false);
  });

  it("caps bucket count by evicting the least-recently-checked bucket", () => {
    const limiter = new SlidingWindowRateLimiter({ windowMs: 1_000, maxRequests: 2, maxBuckets: 2 });
    expect(limiter.check("a", 0).allowed).toBe(true);
    expect(limiter.check("b", 1).allowed).toBe(true);
    // Refresh "a" so "b" becomes the least-recently-checked entry.
    expect(limiter.check("a", 2)).toMatchObject({ allowed: true, remaining: 0 });
    // At capacity: "b" (least recently checked) is evicted to admit "c".
    expect(limiter.check("c", 3).allowed).toBe(true);
    // Evicted "b" gets a fresh window; admitting it evicts "a".
    expect(limiter.check("b", 4)).toMatchObject({ allowed: true, remaining: 1 });
    // "c" survived both later admissions, so its earlier usage still counts.
    expect(limiter.check("c", 5)).toMatchObject({ allowed: true, remaining: 0 });
  });

  it("sweeps for expired buckets at most once per window instead of on every check", () => {
    const limiter = new SlidingWindowRateLimiter({ windowMs: 1_000, maxRequests: 1 });
    // t=0: first check sweeps and anchors the sweep cadence.
    expect(limiter.check("a", 0).allowed).toBe(true);
    // t=999: inside the same window, so no sweep.
    expect(limiter.check("b", 999).allowed).toBe(true);
    // t=1_000: the cadence is due again, so the expired "a" goes and the live "b" stays.
    expect(limiter.check("c", 1_000).allowed).toBe(true);
    expect(limiter.trackedBuckets).toBe(2);
    expect(limiter.check("d", 1_500).allowed).toBe(true);
    // t=1_999: "b" (window started at 999) is expired, but the next sweep is not due
    // until t=2_000, so it is still tracked. Scanning every bucket on every check
    // would have dropped it here; that scan is what this change removes.
    expect(limiter.check("e", 1_999).allowed).toBe(true);
    expect(limiter.trackedBuckets).toBe(4);
    // The next window boundary reclaims the stale entries ("b" from t=999 and "c"
    // from t=1_000), so memory stays bounded by ~one window of keys.
    expect(limiter.check("f", 2_000).allowed).toBe(true);
    expect(limiter.trackedBuckets).toBe(3);
  });

  it("reclaims expired buckets on the capacity path even when the sweep is not due", () => {
    const limiter = new SlidingWindowRateLimiter({ windowMs: 1_000, maxRequests: 2, maxBuckets: 2 });
    // t=1 anchors the sweep cadence, so the next scheduled sweep is t=1_001.
    expect(limiter.check("anchor", 1).allowed).toBe(true);
    expect(limiter.check("a", 0).allowed).toBe(true);
    expect(limiter.check("b", 500).allowed).toBe(true);
    expect(limiter.check("b", 600)).toMatchObject({ allowed: true, remaining: 0 });
    // Refresh "a": its window still started at t=0, but it is now the newest entry,
    // so a blind least-recently-checked eviction would evict the live "b" instead.
    expect(limiter.check("a", 900)).toMatchObject({ allowed: true, remaining: 0 });
    // t=1_000: "a" is expired, "b" is live, and the next scheduled sweep is at 1_001.
    // Admitting "c" at capacity must reclaim "a" rather than evict live "b".
    expect(limiter.check("c", 1_000).allowed).toBe(true);
    // "b" kept its original window, so its two earlier requests still count.
    expect(limiter.check("b", 1_000)).toMatchObject({ allowed: false, remaining: 0 });
  });

  it("keeps the tracked bucket count bounded under key churn", () => {
    const limiter = new SlidingWindowRateLimiter({ windowMs: 1_000, maxRequests: 1, maxBuckets: 64 });
    for (let i = 0; i < 1_000; i += 1) limiter.check(`churn-${i}`, i);
    expect(limiter.trackedBuckets).toBeLessThanOrEqual(64);
    // Idle past the window: the next check sweeps everything stale away.
    expect(limiter.check("after-idle", 100_000).allowed).toBe(true);
    expect(limiter.trackedBuckets).toBe(1);
  });
});
