import { ControlStackError } from "@agent-control-stack/shared";
import { capabilityDeniedEvent, capabilityIssuedEvent, type AuditEventDraft } from "./audit.js";
import { prepareDesktopCommanderCapability, signPreparedDesktopCommanderCapability, type DesktopCommanderCapability } from "./capability.js";
import type { DesktopCommanderAdapterConfig } from "./config.js";
import type { ExecutionAuthorization } from "./execution-authorization.js";
import type { CapabilityIssuanceBinding } from "./runtime-registry.js";

export type ManagedCapabilityConfig = NonNullable<DesktopCommanderAdapterConfig["capability"]>;

export interface CapabilityIssuanceDeps {
  /** Authoritative transaction gate; a capability is never signed before it commits. */
  capabilityRegistry: { recordIssuance(input: CapabilityIssuanceBinding): { requestHash: string; approvalId?: string } };
  /** Canonical audit persistence; failure prevents signing and transmission. */
  persistAuditEvent: (event: AuditEventDraft) => void | Promise<void>;
}

/**
 * The single "record-then-sign" gate every capability issuance path shares -
 * the in-process machine executor and the ACS-owned HTTP issuer alike. There
 * is exactly one place that calls `signPreparedDesktopCommanderCapability`,
 * and it only does so after `capabilityRegistry.recordIssuance` has
 * transactionally committed the durable issuance row. A rejected or failed
 * issuance is audited as denied and the error propagates; nothing is ever
 * signed on the failure path.
 */
export async function issueAndSignDesktopCommanderCapability(
  authorization: ExecutionAuthorization,
  config: ManagedCapabilityConfig,
  deps: CapabilityIssuanceDeps,
  now: Date = new Date()
): Promise<DesktopCommanderCapability> {
  const payload = prepareDesktopCommanderCapability(authorization, authorization.requestHash, config, now);
  try {
    const recorded = deps.capabilityRegistry.recordIssuance({
      runtimeId: payload.runtimeId,
      identityConfigFingerprint: config.runtimeIdentityConfigFingerprint,
      leaseId: payload.leaseId,
      attemptId: payload.attemptId,
      workItemId: payload.workItemId,
      workerId: authorization.workerId,
      fencingEpoch: payload.leaseEpoch,
      planHash: payload.planHash,
      actionHash: payload.actionHash,
      invocationHash: payload.invocationHash,
      requiredScopes: payload.scopes,
      approvalRequired: authorization.requiresApproval,
      approvalId: payload.approvalId,
      keyId: config.keyId,
      nonce: payload.nonce,
      issuedAt: payload.issuedAt,
      expiresAt: payload.expiresAt
    });
    if (recorded.requestHash !== payload.requestHash || recorded.approvalId !== payload.approvalId) {
      throw new ControlStackError(
        "desktop_commander_capability_issuance_rejected",
        "issuance binding does not match capability payload"
      );
    }
    await deps.persistAuditEvent(
      capabilityIssuedEvent({
        auth: authorization,
        runtimeId: payload.runtimeId,
        keyId: config.keyId,
        requestHash: payload.requestHash,
        expiresAt: payload.expiresAt
      })
    );
    return signPreparedDesktopCommanderCapability(payload, config);
  } catch (error) {
    const code = error instanceof ControlStackError ? error.code : "desktop_commander_capability_issuance_rejected";
    try {
      await deps.persistAuditEvent(capabilityDeniedEvent({ auth: authorization, runtimeId: payload.runtimeId, code }));
    } catch {
      // Capability was neither signed nor transmitted.
    }
    throw error;
  }
}
