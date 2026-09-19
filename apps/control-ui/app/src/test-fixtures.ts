import type { ExecutionAttempt, SafeLease, StoredAuditEvent, WorkItem } from "./api/types";

/** Test-only fixtures. Nothing in this file is imported by production code. */
export const HASH_A = "a".repeat(64);
export const HASH_B = "b".repeat(64);

export function workItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "wrk_1",
    title: "Write config",
    requester: "user",
    requesterSubject: "operator-1",
    status: "needs_approval",
    intent: "Update the deploy config",
    target: { cwd: "/repo" },
    requestedActions: [{ kind: "fs.write", description: "write config.yml", params: {} }],
    risk: "high",
    createdAt: "2026-09-19T10:00:00.000Z",
    updatedAt: "2026-09-19T10:00:00.000Z",
    ...overrides
  } as WorkItem;
}

let seq = 0;
export function event(
  name: string,
  attributes: Record<string, string | number | boolean> = {},
  body: Record<string, unknown> = {},
  at = "2026-09-19T10:00:00.000Z"
): StoredAuditEvent {
  seq += 1;
  return {
    id: `evt_${seq}`,
    name,
    timeUnixNano: `${BigInt(Date.parse(at)) * 1_000_000n}`,
    attributes,
    body,
    sequence: seq,
    previousHash: "0".repeat(64),
    eventHash: "1".repeat(64)
  } as StoredAuditEvent;
}

export function policyDecided(
  workItemId: string,
  actionHash: string,
  decision: "allow" | "deny" | "require_approval",
  extra: Record<string, unknown> = {}
): StoredAuditEvent {
  return event(
    "policy.decided",
    { "work_item.id": workItemId, "action.hash": actionHash, "policy.decision": decision },
    {
      decision,
      reason: "high risk work requires approval",
      matchedRules: ["approval:risk"],
      actionHash,
      context: { action: { kind: "fs.write" } },
      ...extra
    }
  );
}

export function attempt(overrides: Partial<ExecutionAttempt> = {}): ExecutionAttempt {
  return {
    attemptId: "att_1",
    workItemId: "wrk_1",
    planId: "plan_1",
    planHash: HASH_A,
    attemptNumber: 1,
    protocolVersion: 1,
    inputHash: HASH_B,
    status: "running",
    currentFencingEpoch: 1,
    claimedByWorkerId: "worker-1",
    startedAt: "2026-09-19T10:00:00.000Z",
    createdAt: "2026-09-19T10:00:00.000Z",
    updatedAt: "2026-09-19T10:00:05.000Z",
    ...overrides
  } as ExecutionAttempt;
}

export function lease(overrides: Partial<SafeLease> = {}): SafeLease {
  return {
    leaseId: "lease_1",
    attemptId: "att_1",
    workItemId: "wrk_1",
    admissionId: "adm_1",
    workerId: "worker-1",
    planHash: HASH_A,
    inputHash: HASH_B,
    fencingEpoch: 1,
    protocolVersion: 1,
    policyVersion: "v1",
    policyDecisionHash: HASH_A,
    issuedAt: "2026-09-19T10:00:00.000Z",
    expiresAt: "2026-09-19T10:05:00.000Z",
    maxExpiresAt: "2026-09-19T11:00:00.000Z",
    lastRenewedAt: "2026-09-19T10:00:00.000Z",
    status: "active",
    ...overrides
  } as SafeLease;
}
