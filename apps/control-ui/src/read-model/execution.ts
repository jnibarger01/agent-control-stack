import type { ExecutionReadModel, Viewer } from "@agent-control-stack/mission-control-contract";
import { redactSecrets } from "../redaction.js";
import type { MissionControlViewModel } from "../types.js";
import { displayLeaseStatus } from "./lease.js";

const text = (value: unknown, max: number): string => {
  const redacted = redactSecrets(value);
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted;
};
const ATTENTION = new Set(["unknown", "quarantined", "interrupted", "cancellation_requested"]);

/** Same rule as the classic console: active, unexpired, within max(60s, 20% of observed TTL). */
function expiringSoon(lease: { status: string; expiresAt: string; lastRenewedAt?: string; issuedAt?: string }, nowMs: number): boolean {
  if (lease.status !== "active") return false;
  const exp = Date.parse(lease.expiresAt);
  if (!Number.isFinite(exp) || exp <= nowMs) return false;
  const start = Date.parse(lease.lastRenewedAt ?? lease.issuedAt ?? "");
  const ttl = Number.isFinite(start) ? Math.max(0, exp - start) : 0;
  return exp - nowMs <= Math.max(60_000, 0.2 * ttl);
}

/** Pure projection of persisted attempts and safe lease projections. Lease token hashes never appear. */
export function toExecutionReadModel(model: MissionControlViewModel, viewer: Viewer): ExecutionReadModel {
  const nowMs = (model.now ?? new Date()).getTime();
  const byId = new Map(model.workItems.map((i) => [i.id, i] as const));
  const leases = model.attemptLeasesByWorkItem ?? {};
  const rows = Object.entries(model.executionAttemptsByWorkItem ?? {}).flatMap(([workItemId, attempts]) => {
    const item = byId.get(workItemId);
    if (!item) return [];
    return attempts.map((attempt) => {
      const own = (leases[workItemId] ?? []).filter((l) => l.attemptId === attempt.attemptId);
      const current = own.reduce<(typeof own)[number] | undefined>((best, l) => (!best || l.fencingEpoch > best.fencingEpoch ? l : best), undefined);
      const started = attempt.startedAt ? Date.parse(attempt.startedAt) : NaN;
      const ended = Date.parse(attempt.updatedAt);
      const terminal = ["succeeded", "failed", "cancelled"].includes(attempt.status);
      return {
        attemptId: attempt.attemptId,
        workItemId,
        title: text(item.title, 300),
        workItemStatus: item.status,
        risk: item.risk,
        attemptNumber: attempt.attemptNumber,
        status: attempt.status,
        ...(attempt.claimedByWorkerId ? { workerId: text(attempt.claimedByWorkerId, 200) } : {}),
        fencingEpoch: attempt.currentFencingEpoch,
        ...(current ? { lease: { status: displayLeaseStatus(current, nowMs), expiresAt: current.expiresAt, expiringSoon: expiringSoon(current, nowMs) } } : {}),
        ...(attempt.startedAt ? { startedAt: attempt.startedAt } : {}),
        updatedAt: attempt.updatedAt,
        ...(terminal && Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? { durationMs: ended - started } : {})
      };
    });
  });
  rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const backend = model.executionBackend;
  return {
    schemaVersion: 1,
    generatedAt: new Date(nowMs).toISOString(),
    viewer,
    summary: {
      running: rows.filter((r) => r.status === "running" || r.status === "leased").length,
      failed: rows.filter((r) => r.status === "failed").length,
      attention: rows.filter((r) => ATTENTION.has(r.status)).length,
      expiringLeases: rows.filter((r) => r.lease?.expiringSoon).length
    },
    attempts: rows.slice(0, 300),
    telemetry: model.executionTelemetry ?? null,
    admission: model.infrastructure?.admission ?? null,
    dryRun: backend === undefined ? "unknown" : backend === "dry_run" ? "yes" : "no"
  };
}
