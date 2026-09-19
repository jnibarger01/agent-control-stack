import type { ExecutionAttempt, SafeLease, StoredAuditEvent, WorkItem } from "../api/types";

/**
 * Plan and admission identity, reconstructed from `execution_plan.created` /
 * `execution_plan.admitted` audit events. The gateway exposes no HTTP route
 * for plan definitions (steps, constraints), so those are reported as
 * unavailable rather than invented.
 */
export interface PlanSummary {
  planId: string;
  planNumber: number | undefined;
  planHash: string;
  createdByActorId: string | undefined;
}

export interface AdmissionSummary {
  admissionId: string | undefined;
  planId: string | undefined;
  planHash: string | undefined;
  policyVersion: string | undefined;
  policyDecisionHash: string | undefined;
  requiresApproval: boolean | undefined;
  admittedByActorId: string | undefined;
  admittedAt: string | undefined;
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

export function currentPlan(events: readonly StoredAuditEvent[]): PlanSummary | undefined {
  let plan: PlanSummary | undefined;
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (event.name !== "execution_plan.created") continue;
    const body = rec(event.body);
    const planId = str(body.planId) ?? str(event.attributes?.["plan.id"]);
    const planHash = str(body.planHash) ?? str(event.attributes?.["plan.hash"]);
    if (!planId || !planHash) continue;
    plan = { planId, planNumber: num(body.planNumber), planHash, createdByActorId: str(body.createdByActorId) };
  }
  return plan;
}

export function admissionFor(
  events: readonly StoredAuditEvent[],
  plan: PlanSummary | undefined
): AdmissionSummary | undefined {
  let admission: AdmissionSummary | undefined;
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (event.name !== "execution_plan.admitted") continue;
    const body = rec(event.body);
    if (plan && str(body.planHash) !== plan.planHash) continue;
    admission = {
      admissionId: str(body.admissionId),
      planId: str(body.planId),
      planHash: str(body.planHash),
      policyVersion: str(body.policyVersion),
      policyDecisionHash: str(body.policyDecisionHash),
      requiresApproval: typeof body.requiresApproval === "boolean" ? body.requiresApproval : undefined,
      admittedByActorId: str(body.admittedByActorId),
      admittedAt: str(body.admittedAt)
    };
  }
  return admission;
}

export interface ExecutionRow {
  key: string;
  workItem: WorkItem;
  attempt: ExecutionAttempt | undefined;
  lease: SafeLease | undefined;
  retryCount: number;
  attemptCount: number;
}

export function latestAttempt(attempts: readonly ExecutionAttempt[]): ExecutionAttempt | undefined {
  return [...attempts].sort((a, b) => b.attemptNumber - a.attemptNumber)[0];
}

export function leaseForAttempt(leases: readonly SafeLease[], attemptId: string | undefined): SafeLease | undefined {
  if (!attemptId) return undefined;
  return [...leases]
    .filter((lease) => lease.attemptId === attemptId)
    .sort((a, b) => b.fencingEpoch - a.fencingEpoch)[0];
}

export interface ExecutionSummary {
  running: number;
  queued: number;
  completed: number;
  failed: number;
  retries: number;
  activeLeases: number;
}

const RUNNING = new Set(["leased", "running", "cancellation_requested"]);
const FAILED = new Set(["failed", "quarantined", "unknown", "interrupted"]);

export function summarizeExecutions(rows: readonly ExecutionRow[]): ExecutionSummary {
  const summary: ExecutionSummary = { running: 0, queued: 0, completed: 0, failed: 0, retries: 0, activeLeases: 0 };
  for (const row of rows) {
    const status = row.attempt?.status;
    if (status && RUNNING.has(status)) summary.running += 1;
    else if (status === "pending") summary.queued += 1;
    else if (status === "succeeded") summary.completed += 1;
    else if (status && FAILED.has(status)) summary.failed += 1;
    summary.retries += Math.max(0, row.attemptCount - 1);
    if (row.lease?.status === "active") summary.activeLeases += 1;
  }
  return summary;
}

/** Fields that must never reach the UI, even if a future/older gateway includes them. */
const FORBIDDEN_LEASE_KEYS = ["tokenHash", "token", "leaseToken", "secret", "authorization"];

/** Defence in depth for the lease projection: strip secret-bearing keys before anything is stored or rendered. */
export function sanitizeLease<T extends Record<string, unknown>>(lease: T): SafeLease {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(lease)) {
    if (FORBIDDEN_LEASE_KEYS.includes(key)) continue;
    clean[key] = value;
  }
  return clean as unknown as SafeLease;
}

/** Remaining lease life; negative once expired. */
export function leaseRemainingMs(lease: Pick<SafeLease, "expiresAt" | "status">, now: number): number | undefined {
  if (lease.status !== "active") return undefined;
  const expires = Date.parse(lease.expiresAt);
  return Number.isNaN(expires) ? undefined : expires - now;
}
