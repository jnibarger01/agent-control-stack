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
});
