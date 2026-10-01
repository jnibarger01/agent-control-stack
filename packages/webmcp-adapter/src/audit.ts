import type { AttributeValue } from "@agent-control-stack/shared";
import type { DiscoveryRecord } from "./contracts.js";
import type { WebMcpExecutionAuthorization } from "./execution-authorization.js";

/**
 * Canonical audit evidence for WebMCP execution.
 *
 * Builders shape `{ name, body, attributes }` only. Persistence goes through
 * the existing hash-chained audit sink (`WorkItemStore.recordExecutionEvent`):
 * there is no second audit authority, and no secret, capability token,
 * normalized argument, or raw page content ever enters a field.
 */

export const WebMcpAuditEvent = {
  AuthorizationRequested: "execution.authorization_requested",
  AuthorizationGranted: "execution.authorization_granted",
  AuthorizationDenied: "execution.authorization_denied",
  Started: "execution.started",
  DiscoveryListed: "webmcp.discovery_listed",
  ToolCalled: "webmcp.tool_called",
  ToolSucceeded: "webmcp.tool_succeeded",
  ToolFailed: "webmcp.tool_failed",
  StaleBindingRejected: "webmcp.stale_binding_rejected",
  ReplayRejected: "webmcp.replay_rejected",
  ApprovalRequired: "webmcp.approval_required",
  Completed: "execution.completed"
} as const;

export type WebMcpAuditEventName = (typeof WebMcpAuditEvent)[keyof typeof WebMcpAuditEvent];

export interface WebMcpAuditEventDraft {
  name: WebMcpAuditEventName | string;
  body: Record<string, unknown>;
  attributes: Record<string, AttributeValue>;
}

export function webmcpAuditAttributes(auth: WebMcpExecutionAuthorization): Record<string, AttributeValue> {
  return {
    "work_item.id": auth.workItemId,
    "attempt.id": auth.attemptId,
    "lease.id": auth.leaseId,
    "worker.id": auth.workerId,
    "lease.fencing_epoch": auth.fencingEpoch,
    "action.hash": auth.actionHash,
    "execution.mode": "webmcp",
    "webmcp.session_id": auth.sessionId,
    "webmcp.page_id": auth.pageId,
    "webmcp.origin": auth.origin,
    "webmcp.navigation_id": auth.navigationId,
    "webmcp.tool": auth.toolName,
    "webmcp.invocation_hash": auth.invocationFingerprint,
    "execution.risk": auth.risk,
    "execution.request_id": auth.requestId,
    ...(auth.approvalId ? { "approval.id": auth.approvalId } : {})
  };
}

export function authorizationRequestedEvent(input: {
  workItemId: string;
  workerId: string;
  requestId: string;
  toolName?: string;
  discoveryId?: string;
  attemptId?: string;
  leaseId?: string;
  fencingEpoch?: number;
}): WebMcpAuditEventDraft {
  return {
    name: WebMcpAuditEvent.AuthorizationRequested,
    body: { ...input, executionMode: "webmcp" },
    attributes: {
      "work_item.id": input.workItemId,
      "worker.id": input.workerId,
      "execution.request_id": input.requestId,
      "execution.mode": "webmcp",
      ...(input.toolName ? { "webmcp.tool": input.toolName } : {}),
      ...(input.discoveryId ? { "webmcp.discovery_id": input.discoveryId } : {}),
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
  code: string;
  reason: string;
  toolName?: string;
  attemptId?: string;
  leaseId?: string;
  fencingEpoch?: number;
}): WebMcpAuditEventDraft {
  return {
    name: WebMcpAuditEvent.AuthorizationDenied,
    body: {
      workItemId: input.workItemId,
      workerId: input.workerId,
      requestId: input.requestId,
      code: input.code,
      reason: input.reason,
      executionMode: "webmcp"
    },
    attributes: {
      "work_item.id": input.workItemId,
      "worker.id": input.workerId,
      "execution.request_id": input.requestId,
      "execution.deny_code": input.code,
      "execution.mode": "webmcp",
      ...(input.toolName ? { "webmcp.tool": input.toolName } : {}),
      ...(input.attemptId ? { "attempt.id": input.attemptId } : {}),
      ...(input.leaseId ? { "lease.id": input.leaseId } : {}),
      ...(input.fencingEpoch !== undefined ? { "lease.fencing_epoch": input.fencingEpoch } : {})
    }
  };
}

export function approvalRequiredEvent(auth: WebMcpExecutionAuthorization): WebMcpAuditEventDraft {
  return {
    name: WebMcpAuditEvent.ApprovalRequired,
    body: {
      workItemId: auth.workItemId,
      toolName: auth.toolName,
      risk: auth.risk,
      approvalId: auth.approvalId ?? null,
      requiresApproval: auth.requiresApproval
    },
    attributes: webmcpAuditAttributes(auth)
  };
}

export function authorizationGrantedEvent(auth: WebMcpExecutionAuthorization): WebMcpAuditEventDraft {
  return {
    name: WebMcpAuditEvent.AuthorizationGranted,
    body: {
      workItemId: auth.workItemId,
      attemptId: auth.attemptId,
      leaseId: auth.leaseId,
      actionHash: auth.actionHash,
      invocationFingerprint: auth.invocationFingerprint,
      discoveryId: auth.discoveryId,
      toolName: auth.toolName,
      toolTitle: auth.toolTitle,
      toolDescription: auth.toolDescription,
      origin: auth.origin,
      pageUrl: auth.pageUrl,
      navigationId: auth.navigationId,
      schemaHash: auth.schemaHash,
      registrationHash: auth.registrationHash,
      annotations: auth.annotations,
      risk: auth.risk,
      requiresApproval: auth.requiresApproval,
      approvalId: auth.approvalId ?? null,
      policyVersion: auth.policyVersion,
      policyDecisionHash: auth.policyDecisionHash,
      authorizedAt: auth.authorizedAt
    },
    attributes: webmcpAuditAttributes(auth)
  };
}

export function executionStartedEvent(auth: WebMcpExecutionAuthorization): WebMcpAuditEventDraft {
  return {
    name: WebMcpAuditEvent.Started,
    body: { workItemId: auth.workItemId, toolName: auth.toolName, requestId: auth.requestId },
    attributes: webmcpAuditAttributes(auth)
  };
}

export function discoveryListedEvent(input: {
  sessionId: string;
  pageId: string;
  origin: string;
  navigationId: string;
  toolCount: number;
  actor: string;
}): WebMcpAuditEventDraft {
  return {
    name: WebMcpAuditEvent.DiscoveryListed,
    body: { ...input, executionMode: "webmcp" },
    attributes: {
      "execution.mode": "webmcp",
      "webmcp.session_id": input.sessionId,
      "webmcp.page_id": input.pageId,
      "webmcp.origin": input.origin,
      "webmcp.navigation_id": input.navigationId,
      "webmcp.tool_count": input.toolCount,
      "mcp.actor": input.actor
    }
  };
}

export function discoveryRecordEvent(record: DiscoveryRecord): Record<string, unknown> {
  /** Discovery output exposed to callers — schema and identity are visible; secrets never are. */
  return {
    discoveryId: record.discoveryId,
    sessionId: record.sessionId,
    pageId: record.pageId,
    origin: record.origin,
    pageUrl: record.pageUrl,
    navigationId: record.navigationId,
    tool: {
      name: record.tool.name,
      title: record.tool.title,
      description: record.tool.description,
      inputSchema: record.tool.inputSchema,
      schemaHash: record.tool.schemaHash,
      registrationHash: record.tool.registrationHash,
      annotations: record.tool.annotations
    },
    discoveredAt: record.discoveredAt
  };
}

/**
 * Arguments are never persisted raw: they can carry personal data, tokens, or
 * page-supplied content. Forensic value is preserved through the invocation
 * fingerprint and an argument count.
 */
export function toolCalledEvent(auth: WebMcpExecutionAuthorization): WebMcpAuditEventDraft {
  return {
    name: WebMcpAuditEvent.ToolCalled,
    body: {
      workItemId: auth.workItemId,
      toolName: auth.toolName,
      discoveryId: auth.discoveryId,
      invocationFingerprint: auth.invocationFingerprint,
      argumentCount: Object.keys(auth.normalizedArguments).length,
      risk: auth.risk
    },
    attributes: webmcpAuditAttributes(auth)
  };
}

export function staleBindingRejectedEvent(input: {
  auth: WebMcpExecutionAuthorization;
  code: string;
  dimension: "session" | "page" | "origin" | "navigation" | "tool" | "schema" | "arguments";
}): WebMcpAuditEventDraft {
  return {
    name: WebMcpAuditEvent.StaleBindingRejected,
    body: {
      workItemId: input.auth.workItemId,
      toolName: input.auth.toolName,
      discoveryId: input.auth.discoveryId,
      code: input.code,
      dimension: input.dimension
    },
    attributes: {
      ...webmcpAuditAttributes(input.auth),
      "webmcp.stale_dimension": input.dimension,
      "execution.deny_code": input.code
    }
  };
}

export function replayRejectedEvent(auth: WebMcpExecutionAuthorization, executionKey: string): WebMcpAuditEventDraft {
  return {
    name: WebMcpAuditEvent.ReplayRejected,
    body: {
      workItemId: auth.workItemId,
      attemptId: auth.attemptId,
      toolName: auth.toolName,
      invocationFingerprint: auth.invocationFingerprint,
      executionKey
    },
    attributes: { ...webmcpAuditAttributes(auth), "webmcp.execution_key": executionKey }
  };
}

export function toolOutcomeEvent(
  auth: WebMcpExecutionAuthorization,
  outcome: {
    ok: boolean;
    durationMs: number;
    resultHash: string;
    outcome?: "succeeded" | "failed" | "timeout" | "aborted" | "runtime_error";
    errorCode?: string;
  }
): WebMcpAuditEventDraft {
  return {
    name: outcome.ok ? WebMcpAuditEvent.ToolSucceeded : WebMcpAuditEvent.ToolFailed,
    body: {
      workItemId: auth.workItemId,
      toolName: auth.toolName,
      discoveryId: auth.discoveryId,
      invocationFingerprint: auth.invocationFingerprint,
      durationMs: outcome.durationMs,
      resultHash: outcome.resultHash,
      ...(outcome.outcome ? { outcome: outcome.outcome } : {}),
      ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {})
    },
    attributes: {
      ...webmcpAuditAttributes(auth),
      "execution.result_hash": outcome.resultHash,
      "execution.duration_ms": outcome.durationMs,
      ...(outcome.outcome ? { "execution.terminal_outcome": outcome.outcome } : {}),
      ...(outcome.errorCode ? { "execution.error_code": outcome.errorCode } : {})
    }
  };
}

export function executionCompletedEvent(
  auth: WebMcpExecutionAuthorization,
  outcome: { ok: boolean; resultHash: string }
): WebMcpAuditEventDraft {
  return {
    name: WebMcpAuditEvent.Completed,
    body: { workItemId: auth.workItemId, toolName: auth.toolName, ok: outcome.ok, resultHash: outcome.resultHash },
    attributes: {
      ...webmcpAuditAttributes(auth),
      "execution.result_hash": outcome.resultHash,
      "execution.completed": outcome.ok ? "succeeded" : "failed"
    }
  };
}
