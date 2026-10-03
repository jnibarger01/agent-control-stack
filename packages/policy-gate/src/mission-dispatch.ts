import { ControlStackError, stableHash } from "@agent-control-stack/shared";
import {
  changeSetManifestHash,
  executionPlanSubjectInputHash,
  type WorkItemStore
} from "@agent-control-stack/work-items";
import { z } from "zod";
import { runMissionOnce, type MissionRunnerPorts, type MissionRunnerResult } from "./mission-runner.js";

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
export const missionDispatchInputSchema = z
  .object({
    missionId: identifier,
    expectedManifestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    approvalId: identifier
  })
  .strict();
export const missionDispatchConfirmedSchema = missionDispatchInputSchema
  .extend({
    confirmationHash: z.string().regex(/^[a-f0-9]{64}$/u)
  })
  .strict();
const requestSchema = missionDispatchInputSchema
  .extend({
    dispatchId: z.string().regex(/^[a-f0-9]{64}$/u),
    actorId: z.string().min(1).max(256),
    executingActorId: z.string().min(1).max(256),
    confirmationHash: z.string().regex(/^[a-f0-9]{64}$/u)
  })
  .strict();
export type MissionDispatchRequest = z.infer<typeof requestSchema>;
export const MISSION_DISPATCH_REQUESTED = "mission.dispatch.requested";
export const MISSION_DISPATCH_OBSERVED = "mission.dispatch.observed";

function bindingHash(input: z.infer<typeof missionDispatchInputSchema>, executingActorId: string) {
  return stableHash({ domain: "acs.mission-dispatch.v1", ...input, executingActorId });
}

/** A scheduling receipt, never an approval, lease, capability or result authority. */
export function previewMissionDispatch(store: WorkItemStore, input: unknown) {
  const parsed = missionDispatchInputSchema.parse(input);
  const mission = store.get(parsed.missionId);
  const record = store.getChangeSet(parsed.missionId);
  if (!mission || !record) throw new ControlStackError("mission_dispatch_not_found", "mission snapshot not found");
  if (
    record.manifestHash !== parsed.expectedManifestHash ||
    changeSetManifestHash(record.snapshot) !== record.manifestHash ||
    record.snapshot.definition.subjectInputHash !== executionPlanSubjectInputHash(mission)
  )
    throw new ControlStackError(
      "mission_dispatch_snapshot_mismatch",
      "mission snapshot changed or failed integrity checks"
    );
  const executingActorId = record.snapshot.definition.executingActorId;
  const authority = store.requireActiveChangeSetExecutionAuthority(
    { approvalId: parsed.approvalId },
    parsed.expectedManifestHash,
    executingActorId
  );
  if (authority.missionId !== parsed.missionId)
    throw new ControlStackError("mission_dispatch_authority_mismatch", "approval belongs to another mission");
  return {
    ...parsed,
    executingActorId,
    objective: record.snapshot.definition.objective,
    operations: record.snapshot.definition.operations.map(({ operationId, runtime, toolName }) => ({
      operationId,
      runtime,
      toolName
    })),
    expiresAt: authority.expiresAt,
    confirmationHash: bindingHash(parsed, executingActorId)
  };
}

export function requestMissionDispatch(store: WorkItemStore, input: unknown, actorId: string): MissionDispatchRequest {
  const { confirmationHash, ...parsed } = missionDispatchConfirmedSchema.parse(input);
  return store.withTransaction(() => {
    const preview = previewMissionDispatch(store, parsed);
    if (confirmationHash !== preview.confirmationHash)
      throw new ControlStackError("mission_dispatch_confirmation_mismatch", "confirmed mission binding does not match");
    // One receipt per immutable execution authority, even across operators/restarts.
    const dispatchId = confirmationHash;
    for (const existing of iterateMissionDispatches(store, parsed.missionId)) {
      if (existing.dispatchId === dispatchId) return existing;
    }
    const request = requestSchema.parse({
      ...parsed,
      actorId,
      executingActorId: preview.executingActorId,
      confirmationHash,
      dispatchId
    });
    store.recordSystemEvent({
      name: MISSION_DISPATCH_REQUESTED,
      body: request,
      attributes: { "work_item.id": parsed.missionId, "mission.dispatch.id": dispatchId }
    });
    return request;
  });
}

/** Bounded UI projection; worker/replay consumers stream the complete ledger instead. */
export function readMissionDispatches(store: WorkItemStore, missionId?: string): MissionDispatchRequest[] {
  const recent: MissionDispatchRequest[] = [];
  for (const request of iterateMissionDispatches(store, missionId)) {
    recent.push(request);
    if (recent.length > 50) recent.shift();
  }
  return recent;
}

export function* iterateMissionDispatches(store: WorkItemStore, missionId?: string): Generator<MissionDispatchRequest> {
  // Freeze the read boundary so concurrent producers cannot extend a replay forever.
  const last = store
    .readEvents({ name: MISSION_DISPATCH_REQUESTED, ...(missionId ? { workItemId: missionId } : {}), limit: 1 })
    .at(-1);
  if (!last) return;
  let afterSequence = 0;
  for (;;) {
    const events = store.readEvents({
      name: MISSION_DISPATCH_REQUESTED,
      ...(missionId ? { workItemId: missionId } : {}),
      afterSequence,
      beforeSequence: last.sequence + 1,
      limit: 500
    });
    for (const event of events) {
      const request = requestSchema.parse(event.body);
      if (
        request.dispatchId !==
          bindingHash(
            missionDispatchInputSchema.parse({
              missionId: request.missionId,
              expectedManifestHash: request.expectedManifestHash,
              approvalId: request.approvalId
            }),
            request.executingActorId
          ) ||
        request.confirmationHash !== request.dispatchId ||
        event.attributes["work_item.id"] !== request.missionId
      )
        throw new ControlStackError("mission_dispatch_integrity", "persisted dispatch binding failed integrity checks");
      yield request;
    }
    if (events.length < 500) return;
    afterSequence = events.at(-1)!.sequence;
  }
}

/** Each tick reconstructs authoritative progress; it cannot grant or replay an execution. */
export async function advanceMissionDispatch(
  store: WorkItemStore,
  ports: MissionRunnerPorts,
  request: MissionDispatchRequest,
  executingActorId: string
): Promise<MissionRunnerResult> {
  if (request.executingActorId !== executingActorId)
    throw new ControlStackError(
      "mission_dispatch_executor_mismatch",
      "worker is not configured for this mission executor"
    );
  const result = await runMissionOnce(ports, {
    missionId: request.missionId,
    expectedManifestHash: request.expectedManifestHash,
    authority: { approvalId: request.approvalId }
  });
  recordMissionDispatchObservation(store, request, result);
  return result;
}

export function recordMissionDispatchObservation(
  store: WorkItemStore,
  request: MissionDispatchRequest,
  result: Pick<MissionRunnerResult, "status" | "code" | "operationId">
): void {
  const body = {
    dispatchId: request.dispatchId,
    missionId: request.missionId,
    status: result.status,
    ...(result.code ? { code: result.code } : {}),
    ...(result.operationId ? { operationId: result.operationId } : {})
  };
  // Stable polling states are telemetry, not new transitions. Read one common history.
  let beforeSequence: number | undefined;
  for (;;) {
    const events = store.readEvents({
      name: MISSION_DISPATCH_OBSERVED,
      workItemId: request.missionId,
      limit: 500,
      ...(beforeSequence ? { beforeSequence } : {})
    });
    const previous = [...events]
      .reverse()
      .find((event) => (event.body as Record<string, unknown>).dispatchId === request.dispatchId);
    if (previous) {
      if (stableHash(previous.body) === stableHash(body)) return;
      break;
    }
    if (events.length < 500) break;
    beforeSequence = events[0]!.sequence;
  }
  store.recordSystemEvent({
    name: MISSION_DISPATCH_OBSERVED,
    body,
    attributes: { "work_item.id": request.missionId, "mission.dispatch.id": request.dispatchId }
  });
}
