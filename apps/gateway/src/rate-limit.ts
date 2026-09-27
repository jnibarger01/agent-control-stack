export interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  /**
   * Upper bound on concurrently tracked buckets. Bounds memory when keys have
   * unbounded cardinality (e.g. per-client-IP limits behind a proxy). When the
   * bound is hit, expired buckets are reclaimed first; if none are expired the
   * least-recently-checked bucket is evicted. Defaults to 50_000.
   */
  maxBuckets?: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

type Bucket = { startedAt: number; count: number };

const DEFAULT_MAX_BUCKETS = 50_000;

export class SlidingWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly maxBuckets: number;

  constructor(private readonly options: RateLimitOptions) {
    if (!Number.isInteger(options.windowMs) || options.windowMs <= 0)
      throw new Error("rate-limit window must be positive");
    if (!Number.isInteger(options.maxRequests) || options.maxRequests <= 0)
      throw new Error("rate-limit max must be positive");
    if (options.maxBuckets !== undefined && (!Number.isInteger(options.maxBuckets) || options.maxBuckets <= 0))
      throw new Error("rate-limit maxBuckets must be positive");
    this.maxBuckets = options.maxBuckets ?? DEFAULT_MAX_BUCKETS;
  }

  check(key: string, now = Date.now()): RateLimitDecision {
    this.reclaimExpired(now);
    const current = this.buckets.get(key);
    if (!current || now - current.startedAt >= this.options.windowMs) {
      // Re-check capacity only on insertion so denial paths stay allocation-free.
      if (!current && this.buckets.size >= this.maxBuckets) this.evictOne();
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
    // Refresh insertion order so "least-recently-checked" eviction reflects activity.
    this.buckets.delete(key);
    this.buckets.set(key, current);
    return { allowed: true, remaining: this.options.maxRequests - current.count, retryAfterSeconds: 0 };
  }

  clear(): void {
    this.buckets.clear();
  }

  private reclaimExpired(now: number): void {
    for (const [bucketKey, bucket] of this.buckets) {
      if (now - bucket.startedAt >= this.options.windowMs) this.buckets.delete(bucketKey);
    }
  }

  /**
   * Capacity fallback after expired buckets were reclaimed. Evicts the oldest
   * Map entry (least-recently checked, since allowed checks refresh order);
   * an unbounded-but-tiny leak beats unbounded memory under key churn.
   */
  private evictOne(): void {
    if (this.buckets.size === 0) return;
    const oldest = this.buckets.keys().next();
    if (!oldest.done) this.buckets.delete(oldest.value);
  }
}
