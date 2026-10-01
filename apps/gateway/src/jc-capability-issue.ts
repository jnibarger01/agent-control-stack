import {
  jaceCommanderApprovalDetail,
  jaceCommanderBindingHash,
  jaceCommanderToolPolicy,
  normalizeJaceCommanderInvocation,
  prepareJaceCommanderCapability,
  signJaceCommanderCapability,
  validateJaceCommanderSigningConfig,
  type JaceCommanderCapabilityPayload,
  type JaceCommanderInvocation,
  type JaceCommanderSigningConfig,
  type SqliteJaceCommanderIssuanceRegistry
} from "@agent-control-stack/desktop-commander-adapter";
import {
  ACS_ADMIN_APPROVER,
  readExecutionModeValue,
  type createPolicyEngine,
  type createWorkItemTools
} from "@agent-control-stack/policy-gate";
import { ControlStackError } from "@agent-control-stack/shared";
import {
  executionActionHash,
  executionPlanApprovalRequestHash,
  type SqliteWorkItemStore,
  type WorkItem
} from "@agent-control-stack/work-items";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createWorkItemSchema, jcCapabilityIssueSchema } from "./public-contracts.js";

/** The only worker identity allowed to mint acs.jc.v1 capabilities. */
export const JC_BRIDGE_WORKER_ID = "acs-jc-bridge";
/** Attempt lease TTL for gateway-claimed Jace Commander executions. */
const JC_BRIDGE_LEASE_MS = 300_000;
export const JC_CAPABILITY_ROUTE = "/jc/capability/issue";

export const JaceCommanderAuditEvent = {
  CapabilityIssued: "jace_commander.capability_issued",
  CapabilityDenied: "jace_commander.capability_denied"
} as const;

type LeaseAuthority = {
  workItemId: string;
  attemptId: string;
  leaseId: string;
  workerId: string;
  fencingEpoch: number;
};

export interface JcCapabilityRouteDeps {
  signingConfig: JaceCommanderSigningConfig | undefined;
  registry: SqliteJaceCommanderIssuanceRegistry;
  workItems: SqliteWorkItemStore;
  policy: ReturnType<typeof createPolicyEngine>;
  tools: Pick<ReturnType<typeof createWorkItemTools>, "create_work_item" | "claim_approved_work_item_by_id">;
  maxPendingWorkItems: number;
  requireWorkerIdentity: (request: FastifyRequest, reply: FastifyReply) => string | undefined;
  hasPendingWorkItemCapacity: (maxPendingWorkItems: number) => boolean;
  recordLeaseAuthorizedExecutionEvent: (
    authority: LeaseAuthority,
    draft: { name: string; body: Record<string, unknown>; attributes: Record<string, string | number | boolean> }
  ) => void;
  sendError: (reply: FastifyReply, error: unknown) => unknown;
}

/**
 * POST /jc/capability/issue — ACS-issued acs.jc.v1 capability, lease-bound, per call.
 *
 * Mirrors /dc/capability/issue: the dedicated bridge sends the exact current
 * tool arguments; ACS validates them in memory, creates (or re-finds) a work
 * item bound to their invocation hash, runs policy, and only mints once the
 * item is approved, claimed under a fresh lease, and the durable issuance row
 * commits. `privileged_exec` is always require_approval: the human approves
 * the exact argv shown in the work item, the claim consumes that approval,
 * and the issuance row makes it single-use.
 */
export function registerJcCapabilityIssueRoute(app: FastifyInstance, deps: JcCapabilityRouteDeps): void {
  const { workItems, policy, tools } = deps;

  function audit(
    worker: string,
    requestId: string,
    toolName: string,
    jcActor: string,
    outcome: "issued" | "denied",
    workItemId?: string
  ): void {
    workItems.recordConnectorRequest({
      actor: worker,
      source: `jc-capability-${outcome}`,
      route: JC_CAPABILITY_ROUTE,
      toolName,
      workItemId,
      requestId,
      authMethod: "gateway_bearer",
      authSubject: jcActor
    });
  }

  function evidence(
    authority: LeaseAuthority,
    name: string,
    body: Record<string, unknown>,
    invocation: JaceCommanderInvocation
  ): void {
    // Never arguments, nonce, or signature: only hashes and identifiers.
    deps.recordLeaseAuthorizedExecutionEvent(authority, {
      name,
      body: { workItemId: authority.workItemId, attemptId: authority.attemptId, leaseId: authority.leaseId, ...body },
      attributes: {
        "work_item.id": authority.workItemId,
        "attempt.id": authority.attemptId,
        "lease.id": authority.leaseId,
        "worker.id": authority.workerId,
        "lease.fencing_epoch": authority.fencingEpoch,
        "execution.mode": "jace_commander",
        "jace_commander.tool": invocation.toolName,
        "jace_commander.invocation_hash": invocation.invocationHash,
        ...(typeof body.approvalId === "string" ? { "approval.id": body.approvalId } : {})
      }
    });
  }

  app.post(
    JC_CAPABILITY_ROUTE,
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      try {
        const workerId = deps.requireWorkerIdentity(request, reply);
        if (!workerId) return;
        if (workerId !== JC_BRIDGE_WORKER_ID) {
          return reply.code(403).send({
            error: "dedicated Jace Commander bridge identity is required",
            code: "jc_bridge_identity_required"
          });
        }
        const rawActor = request.headers["x-jc-actor"];
        const jcActor = Array.isArray(rawActor) ? rawActor[0] : rawActor;
        if (!jcActor || !/^[A-Za-z0-9._:@-]{1,128}$/u.test(jcActor)) {
          return reply.code(400).send({ error: "x-jc-actor header is required", code: "jc_actor_invalid" });
        }
        const body = jcCapabilityIssueSchema.parse(request.body ?? {});
        const config = deps.signingConfig;
        if (!config) {
          return reply
            .code(503)
            .send({ error: "capability issuance not configured", code: "capability_issuance_unconfigured" });
        }
        try {
          validateJaceCommanderSigningConfig(config);
        } catch {
          return reply
            .code(503)
            .send({ error: "capability signing key is invalid", code: "capability_signing_key_invalid" });
        }

        const toolPolicy = jaceCommanderToolPolicy(body.tool);
        if (!toolPolicy) {
          audit(workerId, request.id, body.tool, jcActor, "denied");
          return reply.code(403).send({ decision: "deny", reason: "unknown_tool", code: "unknown_tool" });
        }

        let invocation: JaceCommanderInvocation;
        try {
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.argsSummary);
          } catch {
            throw new ControlStackError("jace_commander_argument_invalid", "arguments must be valid JSON");
          }
          invocation = normalizeJaceCommanderInvocation(body.tool, parsed);
        } catch (error) {
          audit(workerId, request.id, body.tool, jcActor, "denied");
          return reply.code(400).send({
            decision: "deny",
            reason: "invalid_arguments",
            code: error instanceof ControlStackError ? error.code : "jace_commander_argument_invalid",
            ...(error instanceof ControlStackError ? { detail: error.message.slice(0, 512) } : {})
          });
        }

        const mode = readExecutionModeValue(workItems.getExecutionMode().raw);
        if (mode.state !== "ok") {
          audit(workerId, request.id, body.tool, jcActor, "denied");
          return reply.code(403).send({
            decision: "deny",
            code: mode.state === "missing" ? "execution_mode_missing" : "execution_mode_corrupt",
            reason: "canonical execution mode is not usable"
          });
        }

        const bindingHash = jaceCommanderBindingHash(config, {
          tool: body.tool,
          invocationHash: invocation.invocationHash,
          runtimeId: config.runtimeId,
          keyId: config.keyId,
          scopes: [...toolPolicy.scopes],
          requesterSubject: jcActor
        });
        const approvalDetail = jaceCommanderApprovalDetail(invocation);

        const existing = workItems
          .list()
          .filter((candidate) => {
            const action = candidate.requestedActions[0];
            const params = action?.params as Record<string, unknown> | undefined;
            return (
              candidate.requestedActions.length === 1 &&
              candidate.requesterSubject === jcActor &&
              action?.kind === toolPolicy.actionKind &&
              params?.tool === body.tool &&
              params?.bindingHash === bindingHash &&
              ["needs_approval", "approved"].includes(candidate.status) &&
              // Admin-mode auto-approvals never authorize a Jace Commander call.
              !workItems.hasGrantedApprovalBy(candidate.id, ACS_ADMIN_APPROVER)
            );
          })
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];

        if (!existing && !deps.hasPendingWorkItemCapacity(deps.maxPendingWorkItems)) {
          return reply.code(429).send({ error: "pending work-item limit reached", code: "work_queue_full" });
        }

        const workItem: WorkItem =
          existing ??
          tools.create_work_item(
            createWorkItemSchema.parse({
              title: `Jace Commander capability: ${body.tool}`,
              intent:
                body.tool === "privileged_exec"
                  ? `Run as root on the Jace Commander host (${config.runtimeId}), exactly: ${JSON.stringify(approvalDetail)}`
                  : `ACS-issued capability for Jace Commander tool ${body.tool} requested by ${jcActor}`,
              requester: "agent",
              requesterSubject: jcActor,
              target: {},
              requestedActions: [
                {
                  kind: toolPolicy.actionKind,
                  description: `Jace Commander tool ${body.tool}`,
                  params: {
                    tool: body.tool,
                    invocationHash: invocation.invocationHash,
                    bindingHash,
                    runtimeId: config.runtimeId,
                    requiredScopes: [...toolPolicy.scopes],
                    requesterSubject: jcActor,
                    approvalDetail
                  }
                }
              ],
              risk: toolPolicy.risk,
              ...(body.correlationId ? { metadata: { correlationId: body.correlationId } } : {})
            })
          );

        const evaluations = policy.evaluateWorkItem(workItem, workerId, "approve");
        const required = evaluations.filter((evaluation) => evaluation.decision.decision === "require_approval");
        const actionHash = required[0]?.actionHash ?? executionActionHash(workItem);

        if (workItem.status === "blocked" || workItem.status === "rejected") {
          audit(workerId, request.id, body.tool, jcActor, "denied", workItem.id);
          return reply.code(403).send({
            decision: "deny",
            reason: "policy_denied",
            workItemId: workItem.id,
            detail: policy.summarize(evaluations).reason
          });
        }
        // Fail closed on any drift between the acs.jc.v1 tool table and policy:
        // privileged_exec must require approval, nothing else may.
        if (toolPolicy.requiresApproval !== required.length > 0) {
          audit(workerId, request.id, body.tool, jcActor, "denied", workItem.id);
          return reply.code(403).send({
            decision: "deny",
            reason: "policy_drift",
            code: "jace_commander_policy_drift",
            workItemId: workItem.id
          });
        }
        if (workItem.status !== "approved") {
          audit(workerId, request.id, body.tool, jcActor, "denied", workItem.id);
          return reply.code(409).send({
            decision: "require_approval",
            workItemId: workItem.id,
            actionHash,
            approvalDetail,
            approvalInstructions: `POST /work-items/${workItem.id}/approve with actionHash ${actionHash}`
          });
        }

        const claimed = tools.claim_approved_work_item_by_id({
          id: workItem.id,
          workerId,
          leaseMs: JC_BRIDGE_LEASE_MS
        });
        if (!claimed?.attemptId || claimed.fencingEpoch === undefined || !claimed.planHash || !claimed.inputHash) {
          // e.g. the approval expired before the call: the claim blocks the item.
          audit(workerId, request.id, body.tool, jcActor, "denied", workItem.id);
          return reply.code(403).send({
            decision: "deny",
            reason: "claim_rejected",
            code: "jace_commander_claim_rejected",
            workItemId: workItem.id,
            status: claimed?.status ?? workItems.get(workItem.id)?.status
          });
        }
        const authority: LeaseAuthority = {
          workItemId: claimed.id,
          attemptId: claimed.attemptId,
          leaseId: claimed.leaseId,
          workerId,
          fencingEpoch: claimed.fencingEpoch
        };
        const deny = (code: string, status = 403) => {
          try {
            evidence(
              authority,
              JaceCommanderAuditEvent.CapabilityDenied,
              { runtimeId: config.runtimeId, code },
              invocation
            );
          } catch {
            // Lease authority may already have lapsed.
          }
          audit(workerId, request.id, body.tool, jcActor, "denied", workItem.id);
          return reply
            .code(status)
            .send({ decision: "deny", reason: "issuance_rejected", code, workItemId: workItem.id });
        };

        // Re-derive everything from trusted state after the claim.
        const trusted = workItems.get(workItem.id);
        const lease = workItems.getActiveLeaseForAttempt(claimed.attemptId);
        const trustedParams = trusted?.requestedActions[0]?.params as Record<string, unknown> | undefined;
        if (
          !trusted ||
          !lease ||
          trusted.status !== "running" ||
          trusted.requestedActions.length !== 1 ||
          lease.workerId !== workerId ||
          lease.workItemId !== trusted.id ||
          lease.status !== "active" ||
          lease.fencingEpoch !== claimed.fencingEpoch ||
          lease.planHash !== claimed.planHash ||
          executionActionHash(trusted) !== claimed.actionHash ||
          trustedParams?.tool !== body.tool ||
          trustedParams?.invocationHash !== invocation.invocationHash ||
          trustedParams?.bindingHash !== bindingHash
        ) {
          return deny("jace_commander_authority_mismatch");
        }

        let approvalId: string | undefined;
        let payloadActionHash = claimed.actionHash;
        if (toolPolicy.requiresApproval) {
          const approval = lease.approvalId ? workItems.getExecutionPlanApprovalById(lease.approvalId) : undefined;
          if (!approval) return deny("approval_binding_missing");
          if (approval.approvedByActorId === jcActor || approval.approvedByActorId === ACS_ADMIN_APPROVER) {
            return deny("approval_self_denied");
          }
          approvalId = approval.approvalId;
          payloadActionHash = approval.actionHash;
        } else if (lease.approvalId) {
          return deny("approval_not_permitted");
        }
        const requestHash = executionPlanApprovalRequestHash({
          workItemId: workItem.id,
          planHash: claimed.planHash,
          actionHash: payloadActionHash
        });

        let payload: JaceCommanderCapabilityPayload;
        try {
          payload = prepareJaceCommanderCapability(
            invocation,
            {
              workItemId: workItem.id,
              attemptId: claimed.attemptId,
              leaseId: claimed.leaseId,
              leaseEpoch: claimed.fencingEpoch,
              planHash: claimed.planHash,
              actionHash: payloadActionHash,
              requestHash,
              ...(approvalId !== undefined ? { approvalId } : {})
            },
            config
          );
          deps.registry.recordIssuance({ payload, workerId, keyId: config.keyId });
        } catch (error) {
          return deny(error instanceof ControlStackError ? error.code : "jace_commander_capability_issuance_rejected");
        }

        try {
          evidence(
            authority,
            JaceCommanderAuditEvent.CapabilityIssued,
            {
              runtimeId: payload.runtimeId,
              keyId: config.keyId,
              toolName: payload.toolName,
              scopes: [...payload.scopes],
              requestHash: payload.requestHash,
              invocationHash: payload.invocationHash,
              expiresAt: payload.expiresAt,
              ...(approvalId !== undefined ? { approvalId } : {})
            },
            invocation
          );
        } catch (error) {
          return reply.code(503).send({
            error: "capability evidence could not be committed",
            code: "capability_evidence_unavailable",
            detail: error instanceof Error ? error.message : String(error)
          });
        }

        const capability = signJaceCommanderCapability(payload, config);
        audit(workerId, request.id, body.tool, jcActor, "issued", workItem.id);
        return {
          decision: "allow",
          capability,
          workItemId: workItem.id,
          attemptId: payload.attemptId,
          leaseId: payload.leaseId,
          leaseEpoch: payload.leaseEpoch,
          planHash: payload.planHash,
          actionHash: payload.actionHash,
          invocationHash: payload.invocationHash,
          workerId
        };
      } catch (error) {
        return deps.sendError(reply, error);
      }
    }
  );
}

/**
 * acs.jc.v1 signing material: a SEPARATE Ed25519 key from acs.dc.v1 so a DC
 * key compromise can never mint `process.privileged`. Partial config fails
 * closed (the route answers 503) rather than crashing gateway startup.
 */
export function jaceCommanderSigningConfigFromEnv(env: NodeJS.ProcessEnv): JaceCommanderSigningConfig | undefined {
  const privateKey = env.ACS_JACE_COMMANDER_CAPABILITY_PRIVATE_KEY?.trim();
  const keyId = env.ACS_JACE_COMMANDER_CAPABILITY_KEY_ID?.trim();
  const runtimeId = env.ACS_JACE_COMMANDER_RUNTIME_ID?.trim();
  if (!privateKey || !keyId || !runtimeId) return undefined;
  if (privateKey === env.ACS_DESKTOP_COMMANDER_CAPABILITY_PRIVATE_KEY?.trim()) return undefined;
  const config = { runtimeId, keyId, privateKey, ttlMs: 29_000 };
  try {
    validateJaceCommanderSigningConfig(config);
  } catch {
    return undefined;
  }
  return config;
}
