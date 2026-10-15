/**
 * Fixed-cadence lease reaper.
 *
 * `failExpiredLeases` is the store's expiry sweep: it flips past-due active
 * attempt leases to `expired`, marks their attempts `unknown`/`lease_expired`,
 * and emits `attempt_lease.expired` audit events. Before this module, the
 * sweep only ran opportunistically (permit acquisition, readiness probes,
 * shutdown drain): an idle gateway never reaped, so a crashed worker's lease
 * sat `active` until something else happened to touch it. The reaper runs the
 * sweep on a fixed cadence so expiry converges without traffic.
 *
 * The sweep itself stays fail-closed (it throws on inconsistent lease state,
 * aborting that tick). The reaper treats a sweep failure as best-effort
 * noise: it reports the error and continues on the next tick. A reaper
 * failure must never crash the gateway or wedge the sweep loop.
 */

export const DEFAULT_LEASE_REAPER_INTERVAL_MS = 60_000;
export const LEASE_REAPER_INTERVAL_ENV = "ACS_LEASE_REAPER_INTERVAL_MS";

/**
 * Reaper cadence in ms. 0 disables the loop. Throws on non-integer or
 * negative input, mirroring ACS_ACTOR_DISCOVERY_INTERVAL_MS.
 */
export function resolveLeaseReaperIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[LEASE_REAPER_INTERVAL_ENV]?.trim();
  if (!raw) return DEFAULT_LEASE_REAPER_INTERVAL_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${LEASE_REAPER_INTERVAL_ENV} must be a non-negative integer (0 disables)`);
  }
  return value;
}

export interface LeaseReaperDeps {
  /** The store's expiry sweep. Must be safe to call repeatedly. */
  failExpiredLeases: () => void;
  intervalMs: number;
  onError?: (error: unknown) => void;
  /** Timer injection seam for tests; defaults to the globals. */
  setIntervalFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalFn?: (timer: NodeJS.Timeout) => void;
}

export interface LeaseReaperHandle {
  stop(): void;
}

/**
 * Start the fixed-cadence sweep loop. The first sweep lands one interval
 * after start. Timer ticks cannot overlap (synchronous sweep), so no
 * re-entrancy guard is needed.
 */
export function startLeaseReaper(deps: LeaseReaperDeps): LeaseReaperHandle {
  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  const onError = deps.onError ?? (() => {});
  let stopped = false;
  const timer = setIntervalFn(() => {
    if (stopped) return;
    try {
      deps.failExpiredLeases();
    } catch (error) {
      onError(error);
    }
  }, deps.intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return {
    stop(): void {
      stopped = true;
      clearIntervalFn(timer);
    }
  };
}
