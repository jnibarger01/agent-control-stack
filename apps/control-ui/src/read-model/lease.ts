/**
 * A lease is current authority only while it is `active` AND unexpired. Expired rows stay `active` until the
 * reaper reconciles them, so the status alone is not enough to draw ownership or pick a current lease.
 */
export function isCurrentLease(lease: { status: string; expiresAt: string }, nowMs: number): boolean {
  if (lease.status !== "active") return false;
  const expiresMs = Date.parse(lease.expiresAt);
  return Number.isFinite(expiresMs) && expiresMs > nowMs;
}
