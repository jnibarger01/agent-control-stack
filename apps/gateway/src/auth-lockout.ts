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
   * Upper bound on concurrently tracked failure buckets. Bounds memory when
   * keys have unbounded cardinality (e.g. attacker-sprayed unique principals
   * on unauthenticated endpoints). When the bound is hit, expired buckets are
   * reclaimed first; if none are expired the least-recently-checked bucket is
   * evicted. Defaults to 50_000.
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
    if (options.maxBuckets !== undefined && (!Number.isInteger(options.maxBuckets) || options.maxBuckets <= 0)) {
      throw new Error("auth-lockout maxBuckets must be positive");
    }
    this.maxBuckets = options.maxBuckets ?? DEFAULT_MAX_BUCKETS;
  }

  isLocked(key: string, now = Date.now()): AuthLockoutDecision {
    this.prune(now);
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.startedAt >= this.options.windowMs) {
      return { locked: false, failures: 0, retryAfterSeconds: 0, justLocked: false };
    }
    // Refresh insertion order so "least-recently-checked" eviction reflects activity.
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
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
      // Re-check capacity only on insertion so non-inserting paths stay allocation-free.
      if (this.buckets.size >= this.maxBuckets) this.evictOne();
      this.buckets.set(key, { startedAt: now, count: 1 });
      const locked = 1 >= this.options.maxFailures;
      return {
        locked,
        failures: 1,
        retryAfterSeconds: locked ? retryAfter(now, this.options.windowMs, now) : 0,
        justLocked: locked
      };
    }
    current.count += 1;
    // Refresh insertion order so "least-recently-checked" eviction reflects activity.
    this.buckets.delete(key);
    this.buckets.set(key, current);
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

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.startedAt >= this.options.windowMs) this.buckets.delete(key);
    }
  }

  /**
   * Capacity fallback after expired buckets were reclaimed. Evicts the oldest
   * Map entry (least-recently checked, since reads and increments refresh
   * order); a bounded eviction of an unconfirmed attacker key beats unbounded
   * memory growth under key churn.
   */
  private evictOne(): void {
    if (this.buckets.size === 0) return;
    const oldest = this.buckets.keys().next();
    if (!oldest.done) this.buckets.delete(oldest.value);
  }
}

function retryAfter(startedAt: number, windowMs: number, now: number): number {
  return Math.max(1, Math.ceil((windowMs - (now - startedAt)) / 1000));
}
