export const DEFAULT_HEARTBEAT_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_HEARTBEAT_ONLINE_WINDOW_MS = 2 * 60 * 1000;

export const livenessAgentStatuses = ["AVAILABLE", "BUSY", "DEGRADED"] as const;

export type LivenessAgentStatus = (typeof livenessAgentStatuses)[number];

export interface LivenessReconciliationOptions {
  now?: Date;
  actorId?: string;
}

export function validateHeartbeatTtl(ttlMs: number): number {
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw new Error("heartbeat TTL must be a positive integer in milliseconds");
  }
  return ttlMs;
}

export function isHeartbeatExpired(
  lastHeartbeatAt: string | null | undefined,
  referenceAt: string,
  now: Date,
  ttlMs = DEFAULT_HEARTBEAT_TTL_MS
): boolean {
  validateHeartbeatTtl(ttlMs);
  const timestamp = Date.parse(lastHeartbeatAt ?? referenceAt);
  const nowMs = now.getTime();
  return !Number.isFinite(timestamp) || !Number.isFinite(nowMs) || nowMs - timestamp > ttlMs;
}
