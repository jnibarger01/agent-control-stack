import type { DatabaseSync } from "node:sqlite";
import { ControlStackError } from "@agent-control-stack/shared";
import { z } from "zod";
import type { WorkItemStore, StoredAuditEvent } from "./store.js";
import { readVerifiedChangeSetAuthorityEvent } from "./change-set-approval-store.js";

export const missionTraceQuerySchema = z
  .object({
    afterSequence: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().min(1).max(200).default(100),
    asOfSequence: z.number().int().nonnegative().optional()
  })
  .strict();
export type MissionTraceQuery = z.input<typeof missionTraceQuerySchema>;
type Link = {
  workItemId: string;
  manifestHash: string;
  operationId: string;
  permitId: string;
  authorityId: string;
  workerId: string;
  runtime: string;
};
export interface MissionTrace {
  schemaVersion: "acs.mission-trace.v1";
  missionId: string;
  integrity: "selected-events-and-predecessor-links";
  globalChainVerified: false;
  operations: Link[];
  traceIds: Array<{ workItemId: string; traceId: string }>;
  observations: Array<{
    observationId: string;
    workItemId: string;
    traceId: string;
    status: string;
    classifierVersion: string;
    questionSetVersion: string;
    telemetryCorrelationId: string | null;
    role: "telemetry_only";
  }>;

  events: Array<{ event: StoredAuditEvent; correlation: Record<string, string>; producer: Record<string, string> }>;
  nextAfterSequence?: number;
}

/** Read-only projection of the authoritative ledger; never a second authority source. */
export function readMissionTrace(
  db: DatabaseSync,
  store: WorkItemStore,
  missionId: string,
  query: MissionTraceQuery = {}
): MissionTrace {
  const { afterSequence, limit, asOfSequence } = missionTraceQuerySchema.parse(query);
  if (!store.get(missionId)) throw new ControlStackError("work_item_not_found", "mission not found");
  const rows = db
    .prepare(`SELECT p.permit_id FROM change_set_operation_permits p
      JOIN audit_events permit_event ON permit_event.id = p.audit_event_id
      WHERE p.mission_id = ? AND (? IS NULL OR permit_event.sequence <= ?)
      ORDER BY permit_event.sequence LIMIT 2049`)
    .all(missionId, asOfSequence ?? null, asOfSequence ?? null) as Array<{ permit_id: string }>;
  if (rows.length > 2048)
    throw new ControlStackError("mission_trace_resource_limit", "too many historical operation links");
  const operations = rows.map((row): Link => {
    const permit = store.getChangeSetOperationPermit(row.permit_id)!;
    return {
      workItemId: permit.executionWorkItemId,
      manifestHash: permit.manifestHash,
      operationId: permit.operationId,
      permitId: permit.permitId,
      authorityId: permit.approvalId ?? permit.authorizationId!,
      workerId: permit.workerId,
      runtime: permit.runtime
    };
  });
  // A historical revision remains traceable after amendment; do not follow only the
  // head. Bounding the history is the resource guard.
  const revisions = db
    .prepare(`SELECT revision FROM change_set_revisions WHERE mission_id = ? LIMIT 2049`)
    .all(missionId) as Array<{ revision: number }>;
  if (revisions.length > 2048)
    throw new ControlStackError("mission_trace_resource_limit", "too many historical revisions");
  // Verify the whole revision ancestry exactly once. readChangeSet with no revision
  // reads every revision up to the head in a single forward pass, checking
  // contiguity, parent bindings, canonical hashes and each submission audit event.
  // Calling it per revision re-verified the whole ancestry each time, which was
  // quadratic in the amendment count and rehashed the same audit events repeatedly.
  store.getChangeSet(missionId);
  const workIds = JSON.stringify([missionId, ...operations.map((link) => link.workItemId)]);
  const traceIds = (
    db
      .prepare(
        `SELECT work_item_id, trace_id FROM trace_missions
    WHERE work_item_id IN (SELECT value FROM json_each(?))`
      )
      .all(workIds) as Array<{ work_item_id: string; trace_id: string }>
  ).map((row) => ({ workItemId: row.work_item_id, traceId: row.trace_id }));
  const observationRows = db
    .prepare(
      `SELECT observation_id, work_item_id, trace_id, status,
    classifier_version, question_set_version, telemetry_correlation_id FROM jev_observation_outbox
    WHERE work_item_id IN (SELECT value FROM json_each(?)) LIMIT 2049`
    )
    .all(workIds) as Array<{
    observation_id: string;
    work_item_id: string;
    trace_id: string;
    status: string;
    classifier_version: string;
    question_set_version: string;
    telemetry_correlation_id: string | null;
  }>;
  if (observationRows.length > 2048)
    throw new ControlStackError("mission_trace_resource_limit", "too many historical observations");
  const observations = observationRows.map((row) => ({
    observationId: row.observation_id,
    workItemId: row.work_item_id,
    traceId: row.trace_id,
    status: row.status,
    classifierVersion: row.classifier_version,
    questionSetVersion: row.question_set_version,
    telemetryCorrelationId: row.telemetry_correlation_id,
    role: "telemetry_only" as const
  }));
  const selected = db
    .prepare(
      `SELECT id, sequence, previous_hash, event_hash FROM audit_events
    WHERE sequence > ? AND (
      json_extract(attributes, '$."work_item.id"') IN (SELECT value FROM json_each(?)) OR
      json_extract(attributes, '$."execution.work_item_id"') IN (SELECT value FROM json_each(?)) OR
      json_extract(body, '$.workItemId') IN (SELECT value FROM json_each(?)) OR
      json_extract(body, '$.missionId') = ? OR
      json_extract(body, '$.attemptId') IN (SELECT attempt_id FROM execution_attempts
        WHERE work_item_id IN (SELECT value FROM json_each(?))) OR
      json_extract(attributes, '$."attempt.id"') IN (SELECT attempt_id FROM execution_attempts
        WHERE work_item_id IN (SELECT value FROM json_each(?)))
    ) ORDER BY sequence ASC LIMIT ?`
    )
    .all(afterSequence, workIds, workIds, workIds, missionId, workIds, workIds, limit + 1) as Array<{
    id: string;
    sequence: number;
    previous_hash: string;
    event_hash: string;
  }>;
  const events = selected.slice(0, limit).map((row) => {
    const event = readVerifiedChangeSetAuthorityEvent(db, row.id);
    if (row.sequence === 1) {
      if (row.previous_hash !== "")
        throw new ControlStackError("mission_trace_integrity_mismatch", "invalid audit genesis");
    } else {
      const previous = db
        .prepare("SELECT id, event_hash FROM audit_events WHERE sequence = ?")
        .get(row.sequence - 1) as { id: string; event_hash: string } | undefined;
      if (!previous || previous.event_hash !== row.previous_hash)
        throw new ControlStackError("mission_trace_integrity_mismatch", "missing or invalid audit predecessor");
      readVerifiedChangeSetAuthorityEvent(db, previous.id);
    }
    const value = (key: string) => {
      const raw = event.body[key] ?? event.attributes[key];
      return typeof raw === "string" ? raw : undefined;
    };
    const workItemId =
      value("executionWorkItemId") ?? value("workItemId") ?? value("execution.work_item_id") ?? value("work_item.id");
    const link = operations.find((entry) => entry.workItemId === workItemId);
    const correlation: Record<string, string> = { missionId };
    if (workItemId) correlation.workItemId = workItemId;
    if (link) Object.assign(correlation, link);
    for (const [key, candidates] of Object.entries({
      manifestHash: ["manifestHash", "change_set.hash"],
      operationId: ["operationId"],
      permitId: ["permitId"],
      approvalId: ["approvalId", "approval.id"],
      authorizationId: ["authorizationId", "bindingId"],
      grantId: ["grantId"],
      attemptId: ["attemptId", "attempt.id"],
      leaseId: ["leaseId", "lease.id"],
      resultId: ["resultId", "result.id"],
      evidenceManifestHash: ["evidenceManifestHash", "manifestHash"],
      reviewerId: ["reviewerPrincipalId"],
      actorId: [
        "actor.id",
        "actorId",
        "approvedByActorId",
        "issuedByActorId",
        "createdByActorId",
        "reviewerPrincipalId",
        "workerId",
        "worker.id"
      ],
      capabilityId: ["capabilityId", "capability.id"],
      runtimeId: ["runtimeId"],
      requestId: ["requestId", "request.id"],
      planHash: ["planHash"],
      actionHash: ["actionHash"],
      invocationHash: ["invocationHash"]
    })) {
      if (key === "manifestHash" && event.name.startsWith("evidence.")) continue;
      const found = candidates.map(value).find((entry) => entry !== undefined);
      if (found) correlation[key] = found;
    }
    // A Change Set manifest hash is not a machine-evidence hash.
    if (
      !event.name.startsWith("evidence.") &&
      !event.name.startsWith("verification.") &&
      !event.name.startsWith("review.")
    )
      delete correlation.evidenceManifestHash;
    const producer: Record<string, string> = {};
    for (const key of ["acs.process.id", "acs.process.started_at", "acs.instance", "acs.release_sha"])
      producer[key] = typeof event.attributes[key] === "string" ? String(event.attributes[key]) : "unknown";
    return {
      event: { ...event, sequence: row.sequence, previousHash: row.previous_hash, eventHash: row.event_hash },
      correlation,
      producer
    };
  });
  return {
    schemaVersion: "acs.mission-trace.v1",
    missionId,
    integrity: "selected-events-and-predecessor-links",
    globalChainVerified: false,
    operations,
    traceIds,
    observations,
    events,
    ...(selected.length > limit ? { nextAfterSequence: selected[limit - 1]!.sequence } : {})
  };
}
