import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executionActionHash,
  type AttemptLease,
  type ClaimedWorkItem,
  type WorkItem
} from "@agent-control-stack/work-items";
import type { ContainmentConfig } from "./containment.js";

export const HASH64 = "a".repeat(64);

export function makeRoot(prefix = "dc-fix-"): { root: string; config: ContainmentConfig } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  mkdirSync(join(root, "pkg"));
  writeFileSync(join(root, "pkg", "a.txt"), "hello world");
  return { root, config: { allowedRoots: [root], deniedRoots: [] } };
}

export function makeWorkItem(root: string, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "wi_dc_1",
    title: "read a file via desktop commander",
    requester: "agent",
    status: "running",
    intent: "inspect a file",
    target: {},
    requestedActions: [
      {
        kind: "read_file",
        description: "read a file",
        params: { tool: "read_file", arguments: { path: join(root, "pkg", "a.txt") } }
      }
    ],
    risk: "medium",
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
    ...overrides
  } as WorkItem;
}

export function makeClaimed(workItem: WorkItem, overrides: Partial<ClaimedWorkItem> = {}): ClaimedWorkItem {
  return {
    ...workItem,
    workerId: "worker_1",
    leaseToken: "lease-token-abcdefabcdef",
    leaseId: "lease_1",
    actionHash: executionActionHash(workItem),
    attemptId: "attempt_1",
    planHash: "b".repeat(64),
    inputHash: "c".repeat(64),
    fencingEpoch: 1,
    workspaceHash: "d".repeat(64),
    startedAt: "2026-08-30T00:00:01.000Z",
    leaseExpiresAt: "2999-01-01T00:00:00.000Z",
    ...overrides
  };
}

export function makeLease(claimed: ClaimedWorkItem, overrides: Partial<AttemptLease> = {}): AttemptLease {
  return {
    leaseId: claimed.leaseId,
    attemptId: claimed.attemptId ?? "attempt_1",
    workItemId: claimed.id,
    admissionId: "adm_1",
    approvalId: undefined,
    workerId: claimed.workerId,
    tokenHash: HASH64,
    planHash: claimed.planHash ?? "b".repeat(64),
    inputHash: claimed.inputHash ?? "c".repeat(64),
    fencingEpoch: claimed.fencingEpoch ?? 1,
    protocolVersion: "acs.worker.v2",
    policyVersion: "acs.policy.v1",
    policyDecisionHash: "e".repeat(64),
    issuedAt: "2026-08-30T00:00:01.000Z",
    expiresAt: "2999-01-01T00:00:00.000Z",
    maxExpiresAt: "2999-01-01T01:00:00.000Z",
    lastRenewedAt: "2026-08-30T00:00:01.000Z",
    status: "active",
    ...overrides
  };
}
