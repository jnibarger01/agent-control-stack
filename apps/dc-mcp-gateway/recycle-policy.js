/**
 * Lease-safe recycle decision (pure, unit-testable). While a tools/call is in
 * flight the running session may own an ACS attempt/lease — the recycle is
 * deferred; on wait expiry the new session is refused (fail closed) rather
 * than killing a governed attempt mid-flight.
 */
export function recycleDecision(inFlightCount, waitMs, elapsed) {
  if (inFlightCount === 0) return { action: 'recycle' };
  if (elapsed >= waitMs) return { action: 'refuse' };
  return { action: 'defer' };
}
