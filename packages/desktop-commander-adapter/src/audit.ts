import { domainHash, type AttributeValue } from "@agent-control-stack/shared";
import type { ExecutionAuthorization } from "./execution-authorization.js";

/**
 * Phase 12 - canonical audit evidence for every real execution attempt.
 *
 * These builders only shape `{ name, body, attributes }`. Persistence goes
 * through the existing hash-chained audit sink via
 * `WorkItemStore.recordExecutionEvent` - there is no second audit authority and
 * no secret is ever placed in a field (the shared `createEvent` also redacts).
 */

export const ExecutionAuditEvent = {
  AuthorizationRequested: "execution.authorization_requested",
  AuthorizationGranted: "execution.authorization_granted",
  AuthorizationDenied: "execution.authorization_denied",
  Started: "execution.started",
  ToolCalled: "desktop_commander.tool_called",
  CapabilityIssued: "desktop_commander.capability_issued",
  CapabilityDenied: "desktop_commander.capability_denied",
  ToolSucceeded: "desktop_commander.tool_succeeded",
  ToolFailed: "desktop_commander.tool_failed",
  ResultPersisted: "execution.result_persisted",
  Completed: "execution.completed"
} as const;

export type ExecutionAuditEventName = (typeof ExecutionAuditEvent)[keyof typeof ExecutionAuditEvent];

export interface AuditEventDraft {
  name: string;
  body: Record<string, unknown>;
  attributes: Record<string, AttributeValue>;
}

export function executionAuditAttributes(auth: ExecutionAuthorization): Record<string, AttributeValue> {
  return {
    "work_item.id": auth.workItemId,
    "attempt.id": auth.attemptId,
    "lease.id": auth.leaseId,
    "worker.id": auth.workerId,
    "lease.fencing_epoch": auth.fencingEpoch,
    "action.hash": auth.actionHash,
    "execution.mode": "desktop_commander",
    "desktop_commander.tool": auth.toolName,
    "desktop_commander.invocation_hash": auth.invocationFingerprint,
    "execution.risk": auth.risk,
    "execution.request_id": auth.requestId,
    ...(auth.approvalId ? { "approval.id": auth.approvalId } : {})
  };
}

/** Claim-time identity: available before the full authorization exists. */
export interface ClaimAuditIdentity {
  attemptId?: string;
  leaseId?: string;
  workerId?: string;
  fencingEpoch?: number;
}

export function authorizationRequestedEvent(input: {
  workItemId: string;
  workerId: string;
  requestId: string;
  toolName: string;
  attemptId?: string;
  leaseId?: string;
  fencingEpoch?: number;
}): AuditEventDraft {
  return {
    name: ExecutionAuditEvent.AuthorizationRequested,
    body: { ...input, executionMode: "desktop_commander" },
    attributes: {
      "work_item.id": input.workItemId,
      "worker.id": input.workerId,
      "execution.request_id": input.requestId,
      "desktop_commander.tool": input.toolName,
      "execution.mode": "desktop_commander",
      ...(input.attemptId ? { "attempt.id": input.attemptId } : {}),
      ...(input.leaseId ? { "lease.id": input.leaseId } : {}),
      ...(input.fencingEpoch !== undefined ? { "lease.fencing_epoch": input.fencingEpoch } : {})
    }
  };
}

export function authorizationDeniedEvent(input: {
  workItemId: string;
  workerId: string;
  requestId: string;
  toolName?: string;
  code: string;
  reason: string;
  attemptId?: string;
  leaseId?: string;
  fencingEpoch?: number;
}): AuditEventDraft {
  return {
    name: ExecutionAuditEvent.AuthorizationDenied,
    body: {
      workItemId: input.workItemId,
      workerId: input.workerId,
      requestId: input.requestId,
      ...(input.toolName ? { toolName: input.toolName } : {}),
      code: input.code,
      reason: input.reason,
      executionMode: "desktop_commander"
    },
    attributes: {
      "work_item.id": input.workItemId,
      "worker.id": input.workerId,
      "execution.request_id": input.requestId,
      "execution.deny_code": input.code,
      "execution.mode": "desktop_commander",
      ...(input.attemptId ? { "attempt.id": input.attemptId } : {}),
      ...(input.leaseId ? { "lease.id": input.leaseId } : {}),
      ...(input.fencingEpoch !== undefined ? { "lease.fencing_epoch": input.fencingEpoch } : {})
    }
  };
}

export function authorizationGrantedEvent(auth: ExecutionAuthorization): AuditEventDraft {
  return {
    name: ExecutionAuditEvent.AuthorizationGranted,
    body: {
      workItemId: auth.workItemId,
      attemptId: auth.attemptId,
      leaseId: auth.leaseId,
      actionHash: auth.actionHash,
      invocationFingerprint: auth.invocationFingerprint,
      toolName: auth.toolName,
      risk: auth.risk,
      requiresApproval: auth.requiresApproval,
      approvalId: auth.approvalId ?? null,
      policyVersion: auth.policyVersion,
      policyDecisionHash: auth.policyDecisionHash,
      canonicalPaths: auth.canonicalPaths,
      authorizedAt: auth.authorizedAt
    },
    attributes: executionAuditAttributes(auth)
  };
}

export function executionStartedEvent(auth: ExecutionAuthorization): AuditEventDraft {
  return {
    name: ExecutionAuditEvent.Started,
    body: { workItemId: auth.workItemId, toolName: auth.toolName, requestId: auth.requestId },
    attributes: executionAuditAttributes(auth)
  };
}

export function toolCalledEvent(auth: ExecutionAuthorization): AuditEventDraft {
  // Arguments are NEVER persisted raw: normalized arguments can carry file
  // contents, commands, tokens, or credentials. Forensic value is preserved
  // through the deterministic arguments digest (recomputable from the
  // authorized invocation), the invocation fingerprint, and the canonical
  // paths — without any argument value itself.
  const normalizedArguments = auth.normalizedArguments as Record<string, unknown>;
  return {
    name: ExecutionAuditEvent.ToolCalled,
    body: {
      workItemId: auth.workItemId,
      toolName: auth.toolName,
      invocationFingerprint: auth.invocationFingerprint,
      argumentsDigest: domainHash("acs:dc-argv:v1", auth.normalizedArguments),
      argumentCount: Object.keys(normalizedArguments ?? {}).length,
      canonicalPaths: [...auth.canonicalPaths]
    },
    attributes: executionAuditAttributes(auth)
  };
}

/** Capability evidence intentionally excludes nonce, signature, and arguments. */
export function capabilityIssuedEvent(input: {
  auth: ExecutionAuthorization;
  runtimeId: string;
  keyId: string;
  requestHash: string;
  expiresAt: string;
}): AuditEventDraft {
  return {
    name: ExecutionAuditEvent.CapabilityIssued,
    body: {
      workItemId: input.auth.workItemId,
      attemptId: input.auth.attemptId,
      leaseId: input.auth.leaseId,
      runtimeId: input.runtimeId,
      keyId: input.keyId,
      requestHash: input.requestHash,
      expiresAt: input.expiresAt
    },
    attributes: {
      ...executionAuditAttributes(input.auth),
      "desktop_commander.runtime_id": input.runtimeId,
      "desktop_commander.key_id": input.keyId,
      "execution.request_hash": input.requestHash
    }
  };
}

export function capabilityDeniedEvent(input: {
  auth: ExecutionAuthorization;
  runtimeId: string;
  code: string;
}): AuditEventDraft {
  return {
    name: ExecutionAuditEvent.CapabilityDenied,
    body: {
      workItemId: input.auth.workItemId,
      attemptId: input.auth.attemptId,
      runtimeId: input.runtimeId,
      code: input.code
    },
    attributes: {
      ...executionAuditAttributes(input.auth),
      "desktop_commander.runtime_id": input.runtimeId,
      "execution.deny_code": input.code
    }
  };
}

export function toolOutcomeEvent(
  auth: ExecutionAuthorization,
  outcome: {
    ok: boolean;
    durationMs: number;
    resultHash: string;
    truncated: boolean;
    isError: boolean;
    /** Terminal classification; exactly one terminal outcome per execution. */
    outcome?: "succeeded" | "failed" | "timeout" | "aborted" | "runtime_error";
    /** Canonical ACS error code when the failure originated in ACS. */
    errorCode?: string;
  }
): AuditEventDraft {
  return {
    name: outcome.ok ? ExecutionAuditEvent.ToolSucceeded : ExecutionAuditEvent.ToolFailed,
    body: {
      workItemId: auth.workItemId,
      toolName: auth.toolName,
      invocationFingerprint: auth.invocationFingerprint,
      durationMs: outcome.durationMs,
      resultHash: outcome.resultHash,
      truncated: outcome.truncated,
      isError: outcome.isError,
      ...(outcome.outcome ? { outcome: outcome.outcome } : {}),
      ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {})
    },
    attributes: {
      ...executionAuditAttributes(auth),
      "execution.result_hash": outcome.resultHash,
      "execution.duration_ms": outcome.durationMs,
      ...(outcome.outcome ? { "execution.terminal_outcome": outcome.outcome } : {}),
      ...(outcome.errorCode ? { "execution.error_code": outcome.errorCode } : {})
    }
  };
}

export function resultPersistedEvent(auth: ExecutionAuthorization, resultHash: string): AuditEventDraft {
  return {
    name: ExecutionAuditEvent.ResultPersisted,
    body: { workItemId: auth.workItemId, toolName: auth.toolName, resultHash },
    attributes: { ...executionAuditAttributes(auth), "execution.result_hash": resultHash }
  };
}

export function executionCompletedEvent(
  auth: ExecutionAuthorization,
  outcome: { ok: boolean; resultHash: string }
): AuditEventDraft {
  return {
    name: ExecutionAuditEvent.Completed,
    body: { workItemId: auth.workItemId, toolName: auth.toolName, ok: outcome.ok, resultHash: outcome.resultHash },
    attributes: {
      ...executionAuditAttributes(auth),
      "execution.result_hash": outcome.resultHash,
      "execution.completed": outcome.ok ? "succeeded" : "failed"
    }
  };
}
