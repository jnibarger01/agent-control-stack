import { z } from "zod";
import { ControlStackError } from "@agent-control-stack/shared";
import { createWorkItemSchema, executionActionHash, type SqliteWorkItemStore } from "@agent-control-stack/work-items";
import type { createWorkItemTools, PolicyEngine } from "@agent-control-stack/policy-gate";
import {
  authorizeJaceMemExecution,
  jaceMemActionParams,
  jaceMemCapabilityId,
  jaceMemSubjectHash,
  jaceMemRuntimeConfigFingerprint,
  jaceMemVerificationKey,
  prepareJaceMemCapability,
  signPreparedJaceMemCapability,
  validateJaceMemInvocation,
  validateJaceMemSigningConfig,
  validateJaceMemSubject,
  type JaceMemSigningConfig,
  type JaceMemSubject
} from "./issuer.js";
import { SqliteJaceMemIssuanceRegistry } from "./registry.js";

export const JM_BRIDGE_WORKER_ID = "acs-jm-bridge";
export interface JaceMemLaunch {
  readonly launchId: string;
  readonly runtimeId: string;
  readonly subject: JaceMemSubject;
}
export const jaceMemIssueRequestSchema = z
  .object({
    launchId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
    tool: z.string().min(1).max(128),
    arguments: z.record(z.string(), z.unknown())
  })
  .strict();

export const jaceMemBootstrapRequestSchema = z
  .object({
    launchId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u)
  })
  .strict();
export const jaceMemBootstrapCompleteSchema = z
  .object({
    launchId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
    runtimeIdentity: z.unknown()
  })
  .strict();

/** Synchronous authority path: no transport, process launch, admin escalation or caller identities. */
export class JaceMemGatewayIssuer {
  private readonly launches = new Map<string, JaceMemLaunch>();
  private readonly config: JaceMemSigningConfig;
  /** ACS's own verification-config fingerprint; a launch must attest exactly this value. */
  readonly configFingerprint: string;

  constructor(
    private readonly dependencies: {
      store: SqliteWorkItemStore;
      policy: PolicyEngine;
      tools: ReturnType<typeof createWorkItemTools>;
      registry: SqliteJaceMemIssuanceRegistry;
      config: JaceMemSigningConfig;
      launches: readonly JaceMemLaunch[];
      maxPendingWorkItems: number;
    }
  ) {
    this.config = Object.freeze({ ...dependencies.config });
    validateJaceMemSigningConfig(this.config);
    this.configFingerprint = jaceMemRuntimeConfigFingerprint({
      keyId: this.config.keyId,
      publicKey: jaceMemVerificationKey(this.config),
      runtimeId: this.config.runtimeId
    });
    for (const launch of dependencies.launches) {
      if (launch.runtimeId !== this.config.runtimeId || this.launches.has(launch.launchId)) {
        throw new ControlStackError("jace_mem_launch_invalid", "duplicate launch or runtime mismatch");
      }
      const snapshot = Object.freeze({ ...launch, subject: validateJaceMemSubject(launch.subject) });
      dependencies.registry.registerLaunch(snapshot.launchId, snapshot.runtimeId, snapshot.subject);
      this.launches.set(snapshot.launchId, snapshot);
    }
  }

  /**
   * JM-ACS-02 step 1: a fresh single-use challenge for a registered launch. The returned object (minus
   * expiresAt) is what the bridge sends as MCP initialize `_meta.acsRuntimeBootstrap` to the Jace-Mem process it
   * launched over private stdio. The subject comes from the trusted registration, never from the caller.
   */
  bootstrap(raw: unknown) {
    const body = jaceMemBootstrapRequestSchema.parse(raw);
    const launch = this.launches.get(body.launchId);
    if (!launch) throw new ControlStackError("jace_mem_launch_unknown", "trusted launch is not registered");
    return this.dependencies.registry.issueLaunchChallenge(launch.launchId, launch.subject, this.configFingerprint);
  }

  /** JM-ACS-02 step 2: record the identity the Jace-Mem process echoed in its initialize result. */
  completeBootstrap(raw: unknown) {
    const body = jaceMemBootstrapCompleteSchema.parse(raw);
    if (!this.launches.has(body.launchId))
      throw new ControlStackError("jace_mem_launch_unknown", "trusted launch is not registered");
    return this.dependencies.registry.completeLaunchAttestation(
      body.launchId,
      body.runtimeIdentity,
      this.configFingerprint
    );
  }

  issue(raw: unknown) {
    const body = jaceMemIssueRequestSchema.parse(raw);
    const launch = this.launches.get(body.launchId);
    if (!launch) throw new ControlStackError("jace_mem_launch_unknown", "trusted launch is not registered");
    if (!this.dependencies.registry.isLaunchAttested(launch.launchId, this.configFingerprint)) {
      throw new ControlStackError(
        "jace_mem_launch_unattested",
        "the launch has not completed runtime identity attestation"
      );
    }
    const invocation = validateJaceMemInvocation(body.tool, body.arguments);
    if (body.tool === "memory_search_shared" && invocation.arguments.targetAgent === launch.subject.agent) {
      throw new ControlStackError("jace_mem_share_target_invalid", "sharing requires a different target agent");
    }
    const { store, policy, tools, registry } = this.dependencies;
    const params = jaceMemActionParams(invocation, launch.subject, launch.runtimeId);
    // Reuse only pending exact requests. Running and terminal attempts never inherit approval.
    let item = store.list().find((candidate) => {
      const bound = candidate.requestedActions[0]?.params;
      return (
        ["needs_approval", "approved"].includes(candidate.status) &&
        candidate.requestedActions.length === 1 &&
        candidate.requesterSubject === launch.subject.agent &&
        bound?.contract === "acs.jm.v1" &&
        bound.runtimeId === launch.runtimeId &&
        bound.subjectHash === params.subjectHash &&
        bound.invocationHash === invocation.invocationHash
      );
    });
    if (!item) {
      const pending = store
        .list()
        .filter((candidate) =>
          ["draft", "pending_policy", "needs_approval", "approved"].includes(candidate.status)
        ).length;
      if (pending >= this.dependencies.maxPendingWorkItems) {
        throw new ControlStackError("work_queue_full", "pending work-item limit reached");
      }
      item = tools.create_work_item(
        createWorkItemSchema.parse({
          title: `Jace-Mem ${invocation.toolName}`,
          intent: `Exact ${invocation.toolName} invocation ${invocation.invocationHash}; subject ${params.subjectHash}`,
          requester: "agent",
          requesterSubject: launch.subject.agent,
          target: {},
          requestedActions: [
            { kind: invocation.policy.actionKind, description: `Jace-Mem ${invocation.toolName}`, params }
          ],
          risk: invocation.policy.risk
        })
      );
    }
    const evaluations = policy.evaluateWorkItem(item, JM_BRIDGE_WORKER_ID, "approve");
    const summary = policy.summarize(evaluations);
    if (item.status === "blocked" || summary.decision === "deny") {
      throw new ControlStackError("jace_mem_policy_denied", "work-item policy denied issuance");
    }
    const actionHash =
      evaluations.find((evaluation) => evaluation.decision.decision === "require_approval")?.actionHash ??
      executionActionHash(item);
    if (item.status !== "approved") return { decision: "require_approval" as const, workItemId: item.id, actionHash };
    const claimed = tools.claim_approved_work_item_by_id({
      id: item.id,
      workerId: JM_BRIDGE_WORKER_ID,
      leaseMs: 60_000
    });
    if (!claimed?.attemptId) return { decision: "require_approval" as const, workItemId: item.id, actionHash };
    const lease = store.getActiveLeaseForAttempt(claimed.attemptId);
    const current = store.get(item.id);
    if (!lease || !current)
      throw new ControlStackError("jace_mem_capability_lease_rejected", "canonical lease is unavailable");
    const approval = lease.approvalId ? store.getExecutionPlanApprovalById(lease.approvalId) : undefined;
    const authorization = authorizeJaceMemExecution({
      claimed,
      trustedWorkItem: current,
      lease,
      workerId: JM_BRIDGE_WORKER_ID,
      invocation,
      subject: launch.subject,
      ...(approval ? { approvalActionHash: approval.actionHash } : {})
    });
    const payload = prepareJaceMemCapability(authorization, this.config);
    const recorded = registry.recordIssuance({
      launchId: launch.launchId,
      configFingerprint: this.configFingerprint,
      runtimeId: payload.runtimeId,
      toolName: payload.toolName,
      leaseId: payload.leaseId,
      attemptId: payload.attemptId,
      workItemId: payload.workItemId,
      workerId: JM_BRIDGE_WORKER_ID,
      fencingEpoch: payload.leaseEpoch,
      planHash: payload.planHash,
      actionHash: payload.actionHash,
      invocationHash: payload.invocationHash,
      subject: launch.subject,
      requesterSubject: launch.subject.agent,
      approvalId: payload.approvalId,
      keyId: this.config.keyId,
      nonce: payload.nonce,
      issuedAt: payload.issuedAt,
      expiresAt: payload.expiresAt
    });
    if (recorded.requestHash !== payload.requestHash || recorded.approvalId !== payload.approvalId) {
      throw new ControlStackError("jace_mem_capability_issuance_rejected", "issuance binding mismatch");
    }
    // Existing execution audit vocabulary, with lease authority checked transactionally by the store.
    store.recordExecutionEvent({
      name: "execution.authorization_granted",
      workItemId: payload.workItemId,
      attemptId: payload.attemptId,
      leaseId: payload.leaseId,
      workerId: JM_BRIDGE_WORKER_ID,
      fencingEpoch: payload.leaseEpoch,
      body: {
        contract: "acs.jm.v1",
        capabilityId: jaceMemCapabilityId(payload),
        tool: payload.toolName,
        subjectHash: jaceMemSubjectHash(launch.subject),
        requestHash: payload.requestHash,
        expiresAt: payload.expiresAt
      },
      attributes: { "execution.contract": "acs.jm.v1" }
    });
    return {
      decision: "allow" as const,
      capability: signPreparedJaceMemCapability(payload, this.config),
      workItemId: item.id,
      attemptId: payload.attemptId,
      leaseId: payload.leaseId,
      leaseEpoch: payload.leaseEpoch,
      planHash: payload.planHash,
      actionHash: payload.actionHash,
      claimActionHash: claimed.actionHash,
      inputHash: claimed.inputHash,
      workerId: JM_BRIDGE_WORKER_ID
    };
  }
}
