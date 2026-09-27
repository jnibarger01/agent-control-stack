/**
 * Per-principal failed-attempt lockout for dashboard login and device-auth
 * user-code verification. Independent of the request-rate SlidingWindowRateLimiter:
 * this only counts authentication/verification failures, and while locked it
 * skips credential / user-code checks until the window ends.
 */
export interface AuthLockoutOptions {
  windowMs: number;
  maxFailures: number;
  /**
   * Upper bound on concurrently tracked failure buckets. Device verification
   * records both an IP key and a user-code key, so capacities below two are
   * invalid. Expired buckets are reclaimed first; capacity eviction may remove
   * only a non-locked bucket. Defaults to 50_000.
   */
  maxBuckets?: number;
}

export interface AuthLockoutDecision {
  locked: boolean;
  failures: number;
  retryAfterSeconds: number;
  /** True only when this recordFailure call crossed the threshold. */
  justLocked: boolean;
}

type FailureBucket = { startedAt: number; count: number };

const DEFAULT_MAX_BUCKETS = 50_000;

export const DEFAULT_AUTH_LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
export const DEFAULT_AUTH_LOCKOUT_MAX_FAILURES = 5;

export class AuthFailureLockout {
  private readonly buckets = new Map<string, FailureBucket>();
  private readonly maxBuckets: number;

  constructor(private readonly options: AuthLockoutOptions) {
    if (!Number.isInteger(options.windowMs) || options.windowMs <= 0) {
      throw new Error("auth-lockout window must be positive");
    }
    if (!Number.isInteger(options.maxFailures) || options.maxFailures <= 0) {
      throw new Error("auth-lockout maxFailures must be positive");
    }
    if (options.maxBuckets !== undefined && (!Number.isInteger(options.maxBuckets) || options.maxBuckets < 2)) {
      throw new Error("auth-lockout maxBuckets must be an integer of at least 2");
    }
    this.maxBuckets = options.maxBuckets ?? DEFAULT_MAX_BUCKETS;
  }

  isLocked(key: string, now = Date.now()): AuthLockoutDecision {
    this.prune(now);
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.startedAt >= this.options.windowMs) {
      return { locked: false, failures: 0, retryAfterSeconds: 0, justLocked: false };
    }
    this.touch(key, bucket);
    if (bucket.count >= this.options.maxFailures) {
      return {
        locked: true,
        failures: bucket.count,
        retryAfterSeconds: retryAfter(bucket.startedAt, this.options.windowMs, now),
        justLocked: false
      };
    }
    return { locked: false, failures: bucket.count, retryAfterSeconds: 0, justLocked: false };
  }

  recordFailure(key: string, now = Date.now()): AuthLockoutDecision {
    this.prune(now);
    const current = this.buckets.get(key);
    if (!current || now - current.startedAt >= this.options.windowMs) {
      if (this.buckets.size >= this.maxBuckets && !this.evictOldestUnlocked()) {
        // Every tracked bucket is already locked. Dropping one would reopen an
        // authentication path before its window ends, so fail closed for this
        // untracked key until at least one locked bucket expires.
        return {
          locked: true,
          failures: this.options.maxFailures,
          retryAfterSeconds: this.earliestTrackedExpiry(now),
          justLocked: false
        };
      }
      const bucket = { startedAt: now, count: 1 };
      this.buckets.set(key, bucket);
      const locked = 1 >= this.options.maxFailures;
      return {
        locked,
        failures: 1,
        retryAfterSeconds: locked ? retryAfter(now, this.options.windowMs, now) : 0,
        justLocked: locked
      };
    }
    current.count += 1;
    this.touch(key, current);
    const locked = current.count >= this.options.maxFailures;
    const justLocked = locked && current.count === this.options.maxFailures;
    return {
      locked,
      failures: current.count,
      retryAfterSeconds: locked ? retryAfter(current.startedAt, this.options.windowMs, now) : 0,
      justLocked
    };
  }

  clear(key: string): void {
    this.buckets.delete(key);
  }

  clearAll(): void {
    this.buckets.clear();
  }

  private touch(key: string, bucket: FailureBucket): void {
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.startedAt >= this.options.windowMs) this.buckets.delete(key);
    }
  }

  /** Evict the least-recently-checked non-locked bucket, never a locked one. */
  private evictOldestUnlocked(): boolean {
    for (const [key, bucket] of this.buckets) {
      if (bucket.count < this.options.maxFailures) {
        this.buckets.delete(key);
        return true;
      }
    }
    return false;
  }

  private earliestTrackedExpiry(now: number): number {
    let seconds = Math.ceil(this.options.windowMs / 1000);
    for (const bucket of this.buckets.values()) {
      seconds = Math.min(seconds, retryAfter(bucket.startedAt, this.options.windowMs, now));
    }
    return Math.max(1, seconds);
  }
}

function retryAfter(startedAt: number, windowMs: number, now: number): number {
  return Math.max(1, Math.ceil((windowMs - (now - startedAt)) / 1000));
}
