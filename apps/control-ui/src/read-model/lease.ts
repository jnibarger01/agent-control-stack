/**
 * A lease is current authority only while it is `active` AND unexpired. Expired rows stay `active` until the
 * reaper reconciles them, so the status alone is not enough to draw ownership or pick a current lease.
 */
export function isCurrentLease(lease: { status: string; expiresAt: string }, nowMs: number): boolean {
  if (lease.status !== "active") return false;
  const expiresMs = Date.parse(lease.expiresAt);
  return Number.isFinite(expiresMs) && expiresMs > nowMs;
}

/**
 * The status to show for a lease. A row still stored as `active` after its expiry is reported as `expired`, so a
 * projection never presents a lapsed lease as current ownership while the reaper has not yet reconciled it.
 */
export function displayLeaseStatus(lease: { status: string; expiresAt: string }, nowMs: number): string {
  return lease.status === "active" && !isCurrentLease(lease, nowMs) ? "expired" : lease.status;
}
