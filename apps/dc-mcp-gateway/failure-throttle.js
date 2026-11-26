/**
 * Bounded, per-key failure throttle for approval attempts.
 *
 * Design constraints (see docs/adr/0031 follow-up):
 *  - A lock only ever applies to the key that failed. One caller can never lock out everyone else.
 *  - Keys must identify a caller. The public ingress strips X-Forwarded-*, so the socket address is the proxy for every
 *    request and is NOT a caller identity. Callers pass an authenticated session id; for the legacy passphrase path
 *    there is no caller identity, so `softDelayMs` mode never locks: it only slows repeated failures down.
 *  - Memory is bounded (maxKeys, oldest key evicted) and entries expire with the window.
 */
export function createFailureThrottle({
  max = 5,
  windowMs = 5 * 60_000,
  maxKeys = 1000,
  softDelayMs = 0,
  maxSoftDelayMs = 2000,
  nowMs = () => Date.now(),
} = {}) {
  const entries = new Map();

  function prune(key, t) {
    const e = entries.get(key);
    if (!e) return null;
    e.failures = e.failures.filter((ts) => t - ts < windowMs);
    if (e.failures.length === 0) {
      entries.delete(key);
      return null;
    }
    return e;
  }

  return {
    /** Locked only in hard mode (softDelayMs === 0). Returns { locked, retryAfterS }. */
    check(key) {
      if (softDelayMs > 0) return { locked: false, retryAfterS: 0 };
      const t = nowMs();
      const e = prune(key, t);
      if (!e || e.failures.length < max) return { locked: false, retryAfterS: 0 };
      const oldest = e.failures[0];
      return { locked: true, retryAfterS: Math.max(1, Math.ceil((oldest + windowMs - t) / 1000)) };
    },
    fail(key) {
      const t = nowMs();
      let e = prune(key, t);
      if (!e) {
        if (entries.size >= maxKeys) entries.delete(entries.keys().next().value);
        e = { failures: [] };
        entries.set(key, e);
      }
      e.failures.push(t);
      if (e.failures.length > max * 4) e.failures.shift();
    },
    clear(key) {
      entries.delete(key);
    },
    /** Soft mode only: how long to hold a response after recent failures. Never blocks. */
    delayMs(key) {
      if (softDelayMs <= 0) return 0;
      const e = prune(key, nowMs());
      return e ? Math.min(maxSoftDelayMs, e.failures.length * softDelayMs) : 0;
    },
    size: () => entries.size,
  };
}
