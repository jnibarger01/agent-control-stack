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
      /maxBuckets/,
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
});
