import { isPublicRecorderId, recorderEventIdFor } from "./store.js";
import type { IngestDraft } from "./types.js";

/**
 * One row of ACS's execution audit trail, as the emitter needs it. Field names mirror the ACS audit builders and
 * ExecutionAuthorization in the desktop-commander adapter. This module has no ACS dependency, so the recorder keeps
 * no execution or approval authority.
 */
export type AcsExecutionRow = {
  /** ACS audit name, for example "execution.authorization_granted". */
  name: string;
  /** Unique per ACS audit row. The store deduplicates on component plus this id. */
  producerEventId: string;
  requestId: string;
  workItemId: string;
  workerId: string;
  actionHash: string;
  /** domainHash of the exact tool call. Binds the capability to one invocation. */
  invocationFingerprint: string;
  toolName: string;
  /** Row time as ACS recorded it. */
  at: string;
  /** Present on execution.completed and tool outcome rows. */
  outcome?: "succeeded" | "failed";
  /** Present on verification rows: the producerEventId of the execution row they verify. */
  verifiesProducerEventId?: string;
  verification?: "passed" | "failed";
};

const COMPONENT = "acs-execution";

const TYPE_BY_NAME: Readonly<Record<string, string>> = {
  "execution.authorization_granted": "authorization.allowed",
  "execution.authorization_denied": "authorization.denied",
  "execution.completed": "execution.completed",
  "desktop_commander.tool_succeeded": "tool.completed",
  "desktop_commander.tool_failed": "tool.failed"
};

/**
 * Maps one ACS execution row to a recorder draft. The decision identity is the authorization's requestId, the actor is
 * the worker, and the capability is the invocation fingerprint. Every row carries those, so a grant can only cover
 * executions with the same decision. Verification rows name the execution row they verify.
 *
 * The draft is unsigned. Only a signature from an ACS key, added by the signer, can make it authoritative.
 */
export async function toRecorderDraft(row: AcsExecutionRow): Promise<IngestDraft> {
  let type = TYPE_BY_NAME[row.name] ?? row.name;
  if (row.name === "verification.finished") {
    type = row.verification === "passed" || row.verification === "failed"
      ? `verification.${row.verification}`
      : "verification.unknown";
  }
  const metadata: Record<string, unknown> = {
    acsEventName: row.name,
    decisionId: row.requestId,
    actor: row.workerId,
    capabilityId: row.invocationFingerprint,
    actionHash: row.actionHash,
    tool: row.toolName
  };
  if (row.outcome) metadata.outcome = row.outcome;
  if (row.name === "verification.finished" && isPublicRecorderId(row.verifiesProducerEventId)) {
    metadata.executionEventId = await recorderEventIdFor(COMPONENT, row.verifiesProducerEventId);
  }
  return {
    producerEventId: row.producerEventId,
    component: COMPONENT,
    identityRef: "acs-audit-log",
    eventType: type,
    runId: row.workItemId,
    missionId: row.workItemId,
    correlationId: row.requestId,
    parentEventId: null,
    sourceTimestamp: row.at,
    ingestedAt: row.at,
    trustLevel: "acs_authoritative",
    metadata
  };
}
