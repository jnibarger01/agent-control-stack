import type { AttributeValue } from "@agent-control-stack/shared";
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
    "action.hash": auth.actionHash,
    "execution.mode": "desktop_commander",
    "desktop_commander.tool": auth.toolName,
    "desktop_commander.invocation_hash": auth.invocationFingerprint,
    "execution.risk": auth.risk,
    "execution.request_id": auth.requestId,
    ...(auth.approvalId ? { "approval.id": auth.approvalId } : {})
  };
}

export function authorizationRequestedEvent(input: {
  workItemId: string;
  workerId: string;
  requestId: string;
  toolName: string;
}): AuditEventDraft {
  return {
    name: ExecutionAuditEvent.AuthorizationRequested,
    body: { ...input, executionMode: "desktop_commander" },
    attributes: {
      "work_item.id": input.workItemId,
      "worker.id": input.workerId,
      "execution.request_id": input.requestId,
      "desktop_commander.tool": input.toolName,
      "execution.mode": "desktop_commander"
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
      "execution.mode": "desktop_commander"
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
  return {
    name: ExecutionAuditEvent.ToolCalled,
    body: {
      workItemId: auth.workItemId,
      toolName: auth.toolName,
      invocationFingerprint: auth.invocationFingerprint,
      arguments: auth.normalizedArguments
    },
    attributes: executionAuditAttributes(auth)
  };
}

export function toolOutcomeEvent(
  auth: ExecutionAuthorization,
  outcome: { ok: boolean; durationMs: number; resultHash: string; truncated: boolean; isError: boolean }
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
      isError: outcome.isError
    },
    attributes: {
      ...executionAuditAttributes(auth),
      "execution.result_hash": outcome.resultHash,
      "execution.duration_ms": outcome.durationMs
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
