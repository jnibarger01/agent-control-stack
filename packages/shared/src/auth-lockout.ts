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
   * invalid. Expired buckets are reclaimed first. Live buckets — locked or
   * still accumulating a failure streak — are NEVER evicted: when the map is
   * full of live buckets, new keys fail closed until the earliest tracked
   * bucket expires. Evicting a live bucket would hand its principal extra
   * guesses before its window ends (a locked principal released early, or an
   * in-progress streak reset to zero), so admission refuses instead of
   * displacing. Defaults to 50_000.
   *
   * Fail-closed trade-off: saturating the map denies fresh authentication
   * attempts until the earliest tracked window expires. That is inherent to
   * bounding memory while refusing to grant extra guesses; the alternative
   * (evicting live buckets) demonstrably weakens lockout, and the
   * pre-capacity code grew memory without bound instead.
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
  /**
   * Epoch-ms until which keys without a tracked bucket are treated as locked.
   * Set when a new key cannot be admitted because every bucket is live;
   * extends no further than the earliest expiry observed at saturation time.
   * This O(1) marker is what keeps record-then-decide honest under capacity
   * pressure: a saturated recordFailure returns a locked decision AND
   * persists the state that decision implies, so the key's next isLocked
   * check agrees instead of falling through to credential verification.
   */
  private overflowLockedUntil = 0;

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
    const bucket = this.buckets.get(key);
    if (bucket !== undefined) {
      if (now - bucket.startedAt < this.options.windowMs) {
        // Tracked state is authoritative, even during a saturation overflow.
        return this.readDecision(bucket, now);
      }
      // Lazily drop the expired bucket; freeing capacity also ends the
      // saturation-only lock for untracked keys.
      this.buckets.delete(key);
      this.clearOverflowIfCapacityAvailable();
    }
    if (now < this.overflowLockedUntil) {
      return this.overflowDecision(now);
    }
    // Reclaim expired buckets only under capacity pressure so steady-state
    // reads stay O(1). Without this, expired entries could pin the map at
    // capacity and fail closed indefinitely after their windows end.
    if (this.buckets.size >= this.maxBuckets) {
      this.prune(now);
    }
    return { locked: false, failures: 0, retryAfterSeconds: 0, justLocked: false };
  }

  recordFailure(key: string, now = Date.now()): AuthLockoutDecision {
    return this.recordFailures([key], now)[0];
  }

  /**
   * Record one failure for each key. Admission of new buckets is atomic:
   * either every new key gets a bucket or none does — a partial admission is
   * never persisted. Device verification records an IP key and a user-code
   * key together; admitting only one of the pair under capacity pressure
   * would let the two buckets displace each other on later attempts so
   * neither counter ever reaches maxFailures.
   *
   * Keys that already have a live bucket always have their streak
   * incremented, even under capacity pressure: saturation never drops or
   * freezes tracked state. When the new keys cannot all be admitted, each of
   * them fails closed via the overflow marker while the tracked keys keep
   * their real per-key decisions.
   */
  recordFailures(keys: string[], now = Date.now()): AuthLockoutDecision[] {
    const unique = [...new Set(keys)];
    const byKey = new Map<string, AuthLockoutDecision>();
    const fresh: string[] = [];
    for (const key of unique) {
      const bucket = this.buckets.get(key);
      if (bucket !== undefined && now - bucket.startedAt < this.options.windowMs) {
        byKey.set(key, this.increment(bucket, now));
      } else {
        fresh.push(key);
      }
    }
    if (fresh.length > 0) {
      if (this.buckets.size + fresh.length <= this.maxBuckets) {
        for (const key of fresh) byKey.set(key, this.insertFresh(key, now));
      } else {
        // Single prune pass: reclaims expired buckets and yields the
        // earliest live expiry for the overflow marker in the same scan.
        const earliestExpiry = this.prune(now);
        if (this.buckets.size + fresh.length <= this.maxBuckets) {
          for (const key of fresh) byKey.set(key, this.insertFresh(key, now));
        } else {
          // Every bucket is live. Evicting one would grant its principal
          // extra guesses, so fail closed: persist the overflow marker and
          // return locked decisions that isLocked will honor until the
          // earliest tracked window expires.
          const until = earliestExpiry === Infinity ? now + this.options.windowMs : earliestExpiry;
          if (until > this.overflowLockedUntil) this.overflowLockedUntil = until;
          for (const key of fresh) byKey.set(key, this.overflowDecision(now));
        }
      }
    }
    return unique.map((key) => byKey.get(key) as AuthLockoutDecision);
  }

  clear(key: string): void {
    if (this.buckets.delete(key)) this.clearOverflowIfCapacityAvailable();
  }

  clearAll(): void {
    this.buckets.clear();
    this.overflowLockedUntil = 0;
  }

  private readDecision(bucket: FailureBucket, now: number): AuthLockoutDecision {
    const locked = bucket.count >= this.options.maxFailures;
    return {
      locked,
      failures: bucket.count,
      retryAfterSeconds: locked ? retryAfter(bucket.startedAt, this.options.windowMs, now) : 0,
      justLocked: false
    };
  }

  private increment(bucket: FailureBucket, now: number): AuthLockoutDecision {
    bucket.count += 1;
    const locked = bucket.count >= this.options.maxFailures;
    return {
      locked,
      failures: bucket.count,
      retryAfterSeconds: locked ? retryAfter(bucket.startedAt, this.options.windowMs, now) : 0,
      justLocked: locked && bucket.count === this.options.maxFailures
    };
  }

  private insertFresh(key: string, now: number): AuthLockoutDecision {
    this.buckets.set(key, { startedAt: now, count: 1 });
    const locked = 1 >= this.options.maxFailures;
    return {
      locked,
      failures: 1,
      retryAfterSeconds: locked ? retryAfter(now, this.options.windowMs, now) : 0,
      justLocked: locked
    };
  }

  private overflowDecision(now: number): AuthLockoutDecision {
    return {
      locked: true,
      failures: this.options.maxFailures,
      retryAfterSeconds: Math.max(1, Math.ceil((this.overflowLockedUntil - now) / 1000)),
      justLocked: false
    };
  }

  /**
   * Delete expired buckets in a single pass and return the earliest expiry
   * (epoch ms) among the survivors, or Infinity when nothing survives.
   * Deleting during Map iteration is safe and keeps saturated admissions to
   * one scan instead of separate prune / evict / earliest-expiry passes.
   */
  private prune(now: number): number {
    let earliest = Infinity;
    for (const [key, bucket] of this.buckets) {
      const expiresAt = bucket.startedAt + this.options.windowMs;
      if (now >= expiresAt) {
        this.buckets.delete(key);
      } else if (expiresAt < earliest) {
        earliest = expiresAt;
      }
    }
    this.clearOverflowIfCapacityAvailable();
    return earliest;
  }

  private clearOverflowIfCapacityAvailable(): void {
    if (this.buckets.size < this.maxBuckets) this.overflowLockedUntil = 0;
  }
}

function retryAfter(startedAt: number, windowMs: number, now: number): number {
  return Math.max(1, Math.ceil((windowMs - (now - startedAt)) / 1000));
}
