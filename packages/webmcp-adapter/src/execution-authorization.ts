import { z } from "zod";
import { ControlStackError, stableHash } from "@agent-control-stack/shared";
import {
  executionActionHash,
  executionPlanApprovalRequestHash,
  type AttemptLease,
  type ClaimedWorkItem,
  type WorkItem
} from "@agent-control-stack/work-items";
import {
  WEBMCP_CALL_INTENT,
  WebMcpError,
  WebMcpErrorCode,
  type DiscoveryRecord,
  type WebMcpRiskClass
} from "./contracts.js";
import { argumentsHash, invocationFingerprint, validateArguments } from "./normalize.js";
import type { JsonValue } from "./json.js";
import { resolveEffectivePolicy, type WebMcpPolicyTable } from "./policy.js";

/**
 * The trusted WebMCP Authorization object.
 *
 * Mirrors `packages/desktop-commander-adapter`'s authorization boundary: this
 * is the ONLY thing `WebMcpExecutor.execute` accepts, it is a discriminated
 * brand that cannot be produced except by `authorizeWebMcpExecution`, and that
 * function re-runs every ACS check against authoritative state at execution
 * time. There is deliberately no `execute(toolName, args)` shortcut and no
 * caller-supplied "may I?" callback.
 */

const AUTHORIZATION_BRAND = Symbol("acs.webmcp.execution-authorization");

export interface WebMcpExecutionAuthorization {
  readonly [AUTHORIZATION_BRAND]: true;
  readonly requestId: string;
  readonly workItemId: string;
  readonly attemptId: string;
  readonly leaseId: string;
  readonly workerId: string;
  readonly planHash: string;
  readonly inputHash: string;
  readonly fencingEpoch: number;
  /** `executionActionHash(workItem)` re-derived from trusted state. */
  readonly actionHash: string;
  /** Re-derived approval request binding. */
  readonly requestHash: string;
  /** domainHash of the exact normalized WebMCP call. */
  readonly invocationFingerprint: string;
  /** Live browser identity the call is pinned to. */
  readonly sessionId: string;
  readonly pageId: string;
  readonly origin: string;
  readonly pageUrl: string;
  readonly navigationId: string;
  readonly toolName: string;
  readonly toolTitle: string;
  readonly toolDescription: string;
  readonly discoveryId: string;
  readonly registrationHash: string;
  readonly schemaHash: string;
  readonly normalizedSchema: DiscoveryRecord["tool"]["inputSchema"];
  readonly normalizedArguments: Readonly<Record<string, JsonValue>>;
  readonly annotations: DiscoveryRecord["tool"]["annotations"];
  readonly risk: WebMcpRiskClass;
  readonly requiresApproval: boolean;
  readonly approvalId?: string;
  /** Approval-bound action fingerprint when the lease rides a consumed approval. */
  readonly approvalActionHash?: string;
  readonly policyVersion: string;
  readonly policyDecisionHash: string;
  readonly authorizedAt: string;
}

/**
 * Exact binding a work item must carry for a WebMCP call to be authorizable.
 *
 * It carries the whole approval surface: the browser/session/page identity, the
 * navigation generation, the tool's advisory metadata, the ACS-normalized
 * schema, the exact normalized arguments, and the hashes that pin them. A worker
 * therefore executes precisely what an approver saw - nothing is re-supplied by
 * the caller at execution time.
 */
export const webmcpActionBindingSchema = z
  .object({
    intent: z.literal(WEBMCP_CALL_INTENT),
    origin: z.string().min(1).max(2_048),
    toolName: z.string().min(1).max(200),
    toolTitle: z.string().max(300).nullable(),
    toolDescription: z.string().max(2_000).nullable(),
    discoveryId: z.string().regex(/^[a-f0-9]{64}$/u),
    invocationHash: z.string().regex(/^[a-f0-9]{64}$/u),
    argumentsHash: z.string().regex(/^[a-f0-9]{64}$/u),
    schemaHash: z.string().regex(/^[a-f0-9]{64}$/u),
    registrationHash: z.string().regex(/^[a-f0-9]{64}$/u),
    inputSchema: z.record(z.string(), z.unknown()),
    advisoryAnnotations: z.record(z.string(), z.unknown()).nullable(),
    arguments: z.record(z.string(), z.unknown()),
    sessionId: z.string().min(1).max(128),
    pageId: z.string().min(1).max(128),
    navigationId: z.string().min(1).max(128)
  })
  .strict();
export type WebMcpActionBinding = z.infer<typeof webmcpActionBindingSchema>;

export function webmcpActionBinding(
  discovery: DiscoveryRecord,
  invocationHash: string,
  args: Record<string, JsonValue>
): WebMcpActionBinding {
  return {
    intent: WEBMCP_CALL_INTENT,
    origin: discovery.origin,
    toolName: discovery.tool.name,
    toolTitle: discovery.tool.title,
    toolDescription: discovery.tool.description,
    discoveryId: discovery.discoveryId,
    invocationHash,
    argumentsHash: argumentsHash(args),
    schemaHash: discovery.tool.schemaHash,
    registrationHash: discovery.tool.registrationHash,
    inputSchema: discovery.tool.inputSchema as unknown as Record<string, unknown>,
    advisoryAnnotations: (discovery.tool.annotations ?? null) as Record<string, unknown> | null,
    arguments: args,
    sessionId: discovery.sessionId,
    pageId: discovery.pageId,
    navigationId: discovery.navigationId
  };
}

export interface AuthorizeWebMcpExecutionInput {
  /** Item as returned by `claim_next_approved_work_item`. */
  claimed: ClaimedWorkItem;
  /** Item re-read from the authoritative store immediately before execution. */
  trustedWorkItem: Pick<
    WorkItem,
    "id" | "status" | "requester" | "intent" | "target" | "requestedActions" | "risk"
  >;
  lease: AttemptLease;
  workerId: string;
  requestId: string;
  /** The discovery record the caller presented; re-verified against live state by the executor. */
  discovery: DiscoveryRecord;
  /** Raw caller arguments (untrusted until validated). */
  arguments: unknown;
  /** ACS-owned policy table. Never caller-supplied at call time. */
  policy: WebMcpPolicyTable;
  now?: Date;
}

function deny(code: string, message: string): never {
  throw new ControlStackError(code, message);
}

export function authorizeWebMcpExecution(
  input: AuthorizeWebMcpExecutionInput
): WebMcpExecutionAuthorization {
  const now = input.now ?? new Date();
  const { claimed, trustedWorkItem, lease, workerId, discovery } = input;

  // --- work item must be executable -----------------------------------------
  if (trustedWorkItem.status !== "running") {
    deny("webmcp_work_item_not_executable", `work item ${trustedWorkItem.id} is ${trustedWorkItem.status}, not running`);
  }
  if (claimed.id !== trustedWorkItem.id) {
    deny("webmcp_work_item_mismatch", "claimed work item id does not match trusted state");
  }

  // --- worker lease enforcement ---------------------------------------------
  if (claimed.workerId !== workerId || lease.workerId !== workerId) {
    deny("webmcp_lease_worker_mismatch", "lease is not held by this worker");
  }
  if (lease.workItemId !== trustedWorkItem.id) {
    deny("webmcp_lease_work_item_mismatch", "lease does not belong to this work item");
  }
  if (claimed.attemptId !== undefined && lease.attemptId !== claimed.attemptId) {
    deny("webmcp_lease_attempt_mismatch", "lease does not belong to this attempt");
  }
  if (lease.status !== "active") {
    deny("webmcp_lease_inactive", `attempt lease is ${lease.status}`);
  }
  const expiresAt = Date.parse(lease.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    deny("webmcp_lease_expired", "attempt lease has expired");
  }
  if (claimed.fencingEpoch !== undefined && lease.fencingEpoch !== claimed.fencingEpoch) {
    deny("webmcp_lease_fencing_mismatch", "lease fencing epoch does not match the claim");
  }

  // --- exact action-hash revalidation ---------------------------------------
  const recomputedActionHash = executionActionHash(trustedWorkItem);
  if (recomputedActionHash !== claimed.actionHash) {
    deny("webmcp_action_hash_changed", "work item action hash changed since it was claimed");
  }
  if (
    claimed.planHash === undefined ||
    claimed.inputHash === undefined ||
    claimed.fencingEpoch === undefined ||
    claimed.attemptId === undefined
  ) {
    deny("webmcp_attempt_authority_missing", "claim did not carry attempt authority");
  }
  if (lease.planHash !== claimed.planHash) {
    deny("webmcp_plan_hash_mismatch", "lease plan hash does not match the claim");
  }

  // --- the work item must carry exactly this call's binding ------------------
  const actions = trustedWorkItem.requestedActions ?? [];
  const binding = webmcpActionBindingSchema.safeParse(actions[0]?.params ?? {});
  if (actions.length !== 1 || !binding.success) {
    deny("webmcp_action_binding_missing", "work item does not carry exactly one canonical WebMCP action binding");
  }
  if (binding.data.discoveryId !== discovery.discoveryId) {
    deny("webmcp_discovery_binding_mismatch", "work-item binding references a different discovery record");
  }

  // --- ACS policy (annotations may only escalate) ---------------------------
  const effective = resolveEffectivePolicy(input.policy, {
    origin: discovery.origin,
    toolName: discovery.tool.name,
    annotations: discovery.tool.annotations
  });

  // --- arguments re-validated against the ACS-normalized schema -------------
  const normalizedArguments = validateArguments(input.arguments, discovery.tool.inputSchema) as Record<
    string,
    JsonValue
  >;
  const fingerprint = invocationFingerprint({
    identity: {
      sessionId: discovery.sessionId,
      pageId: discovery.pageId,
      origin: discovery.origin,
      pageUrl: discovery.pageUrl,
      navigationId: discovery.navigationId
    },
    toolName: discovery.tool.name,
    registrationHash: discovery.tool.registrationHash,
    schemaHash: discovery.tool.schemaHash,
    arguments: normalizedArguments
  });
  if (fingerprint !== binding.data.invocationHash) {
    throw new WebMcpError(
      WebMcpErrorCode.ArgumentsChanged,
      "supplied arguments do not match the approved invocation fingerprint"
    );
  }
  if (binding.data.argumentsHash !== argumentsHash(normalizedArguments)) {
    throw new WebMcpError(
      WebMcpErrorCode.ArgumentsChanged,
      "supplied arguments do not match the arguments hash on the work-item binding"
    );
  }
  if (binding.data.origin !== discovery.origin || binding.data.toolName !== discovery.tool.name) {
    deny("webmcp_invocation_binding_mismatch", "work-item binding does not match the presented discovery record");
  }
  if (
    binding.data.sessionId !== discovery.sessionId ||
    binding.data.pageId !== discovery.pageId ||
    binding.data.navigationId !== discovery.navigationId
  ) {
    deny("webmcp_invocation_binding_mismatch", "work-item binding is pinned to a different browser identity");
  }

  // --- approval must exist for a requires-approval tool ----------------------
  if (effective.requiresApproval && lease.approvalId === undefined) {
    throw new WebMcpError(
      WebMcpErrorCode.ApprovalRequired,
      `tool ${effective.toolName} requires approval but the lease carries no approval reference`
    );
  }

  return Object.freeze({
    [AUTHORIZATION_BRAND]: true as const,
    requestId: input.requestId,
    workItemId: trustedWorkItem.id,
    attemptId: claimed.attemptId,
    leaseId: claimed.leaseId,
    workerId,
    planHash: claimed.planHash,
    inputHash: claimed.inputHash,
    fencingEpoch: claimed.fencingEpoch,
    actionHash: recomputedActionHash,
    requestHash: executionPlanApprovalRequestHash({
      workItemId: trustedWorkItem.id,
      planHash: claimed.planHash,
      actionHash: recomputedActionHash
    }),
    invocationFingerprint: fingerprint,
    sessionId: discovery.sessionId,
    pageId: discovery.pageId,
    origin: discovery.origin,
    pageUrl: discovery.pageUrl,
    navigationId: discovery.navigationId,
    toolName: discovery.tool.name,
    toolTitle: discovery.tool.title,
    toolDescription: discovery.tool.description,
    discoveryId: discovery.discoveryId,
    registrationHash: discovery.tool.registrationHash,
    schemaHash: discovery.tool.schemaHash,
    normalizedSchema: discovery.tool.inputSchema,
    normalizedArguments: Object.freeze({ ...normalizedArguments }),
    annotations: discovery.tool.annotations,
    risk: effective.risk,
    requiresApproval: effective.requiresApproval,
    approvalId: lease.approvalId,
    approvalActionHash: lease.approvalId === undefined ? undefined : recomputedActionHash,
    policyVersion: lease.policyVersion,
    policyDecisionHash: lease.policyDecisionHash,
    authorizedAt: now.toISOString()
  });
}

export function isWebMcpExecutionAuthorization(value: unknown): value is WebMcpExecutionAuthorization {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[AUTHORIZATION_BRAND] === true
  );
}

/** Replay guard key: one execution per (work item, attempt, exact invocation). */
export function webmcpExecutionKey(auth: WebMcpExecutionAuthorization): string {
  return stableHash({
    domain: "acs:webmcp-execution:v1",
    workItemId: auth.workItemId,
    attemptId: auth.attemptId,
    leaseId: auth.leaseId,
    invocationFingerprint: auth.invocationFingerprint
  });
}
