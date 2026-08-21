export interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

type Bucket = { startedAt: number; count: number };

export class SlidingWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly options: RateLimitOptions) {
    if (!Number.isInteger(options.windowMs) || options.windowMs <= 0) throw new Error("rate-limit window must be positive");
    if (!Number.isInteger(options.maxRequests) || options.maxRequests <= 0) throw new Error("rate-limit max must be positive");
  }

  check(key: string, now = Date.now()): RateLimitDecision {
    const current = this.buckets.get(key);
    if (!current || now - current.startedAt >= this.options.windowMs) {
      this.buckets.set(key, { startedAt: now, count: 1 });
      return { allowed: true, remaining: this.options.maxRequests - 1, retryAfterSeconds: 0 };
    }
    if (current.count >= this.options.maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((this.options.windowMs - (now - current.startedAt)) / 1000))
      };
    }
    current.count += 1;
    return { allowed: true, remaining: this.options.maxRequests - current.count, retryAfterSeconds: 0 };
  }

  clear(): void {
    this.buckets.clear();
  }
}
