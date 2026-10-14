import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  advisorConsultRequestSchema,
  missionUnitSubjectId,
  advisorOutputDigest,
  projectFlightForAdvisor,
  resolveAdvisorModelId,
  type AdvisorCheckpoint,
  type AdvisorDisposition,
  type AdvisorFlightEvent,
  type AdvisorModelId
} from "@agent-control-stack/advisory";
import {
  consultAdvisorModel,
  type AdvisorModelCaller,
  type AdvisorModelRequest
} from "@agent-control-stack/advisory/guidance";
import { readFlightRecords, verifyFlightRecord, type FlightVerdict } from "@agent-control-stack/coding-mission";
import { ControlStackError } from "@agent-control-stack/shared";
import type { WorkItemStore } from "@agent-control-stack/work-items";
import { createRoutingModelCaller, type ModelCallerEnv } from "./moa/model-caller.js";

const domain = { via: "domain_service" as const };
const UNVERIFIED_FLIGHT = "flight_unverified";

export interface AdvisorFlightRead {
  verdict: FlightVerdict;
  events: AdvisorFlightEvent[];
}

export type AdvisorFlightReader = (missionId: string) => AdvisorFlightRead;

export interface AdvisorConsultPort {
  caller: AdvisorModelCaller;
  readFlight: AdvisorFlightReader;
}

export interface AdvisorConsultationResult {
  consultationId: string;
  checkpoint: AdvisorCheckpoint;
  disposition: AdvisorDisposition;
  guidance: string | null;
  declineReason: string | null;
  errorCode: string | null;
}

export function createAdvisorModelCaller(env?: ModelCallerEnv): AdvisorModelCaller {
  const routing = createRoutingModelCaller(env);
  return {
    async complete(request: AdvisorModelRequest) {
      const text = await routing.complete({
        model: request.model,
        system: request.system,
        user: request.user,
        maxTokens: request.maxTokens,
        timeoutMs: request.timeoutMs,
        signal: request.signal
      });
      return { text };
    }
  };
}

/**
 * Production wiring for consult_advisor. ACS has no production path to create advisor bindings yet
 * (only privileged in-process store calls), so the MCP tool is disabled unless an operator explicitly
 * opts in with ACS_ADVISOR_CONSULTATION_ENABLED=1. When disabled, consult_advisor answers
 * advisor_not_configured and never calls a model.
 */
export function advisorPortFromEnv(
  env: Record<string, string | undefined>,
  dbPath: string,
  callerEnv?: ModelCallerEnv
): AdvisorConsultPort | undefined {
  if (env.ACS_ADVISOR_CONSULTATION_ENABLED !== "1") return undefined;
  return { caller: createAdvisorModelCaller(callerEnv), readFlight: openAdvisorFlightReader(dbPath) };
}

export function openAdvisorFlightReader(dbPath: string): AdvisorFlightReader {
  return (missionId) => {
    const db = new DatabaseSync(dbPath);
    try {
      const verification = verifyFlightRecord(db, missionId);
      if (verification.verdict === "tampered") return { verdict: "tampered", events: [] };
      const events: AdvisorFlightEvent[] = [];
      let afterSeq = 0;
      for (;;) {
        const batch = readFlightRecords(db, missionId, { afterSeq, limit: 5000 });
        for (const record of batch) {
          events.push({ seq: record.seq, kind: record.kind, body: parseFlightBody(record.bodyJson) });
          if (events.length > 40) events.shift();
        }
        if (batch.length < 5000) break;
        afterSeq = batch[batch.length - 1]!.seq;
      }
      return { verdict: verification.verdict, events };
    } finally {
      db.close();
    }
  };
}

function parseFlightBody(bodyJson: string): unknown {
  try {
    return JSON.parse(bodyJson) as unknown;
  } catch {
    return null;
  }
}

export async function runAdvisorConsultation(input: {
  store: WorkItemStore;
  caller: AdvisorModelCaller;
  readFlight: AdvisorFlightReader;
  request: unknown;
  /** Authenticated MCP actor. When set, must match the worker that holds the lease/claim. */
  actor?: string;
  now?: string;
}): Promise<AdvisorConsultationResult> {
  const request = advisorConsultRequestSchema.parse(input.request);
  const located = locateBinding(input.store, request);
  if (input.actor !== undefined && input.actor !== located.fence.workerId) {
    throw new ControlStackError("advisor_actor_mismatch", "authenticated actor does not match the lease holder");
  }
  // Pre-call lease check (fence existence). Recording rechecks with a fresh clock after the advisor returns.
  const preCallAt = input.now ?? new Date().toISOString();
  input.store.assertAdvisorConsultationLease({
    subjectId: located.subjectId,
    missionId: located.binding.missionId,
    subjectKind: located.binding.subjectKind,
    fence: located.fence,
    now: preCallAt
  });

  const advisorModelId = resolveAdvisorModelId(located.binding.advisorModelId);
  if (!advisorModelId) {
    throw new ControlStackError("advisor_pairing_rejected", "stored advisor model is not recognized");
  }
  let inputSha256 = createHash("sha256").update(UNVERIFIED_FLIGHT).digest("hex");
  let draft: Awaited<ReturnType<typeof consultAdvisorModel>>;
  try {
    const flight = input.readFlight(located.binding.missionId);
    if (flight.verdict === "tampered") {
      draft = unavailableDraft(advisorModelId, located.binding.advisorTransportModel, "advisor_flight_unverified");
    } else {
      const projection = projectFlightForAdvisor(flight.events);
      inputSha256 = projection.sha256;
      draft = await consultAdvisorModel({
        caller: input.caller,
        advisorModelId,
        transportModel: located.binding.advisorTransportModel,
        checkpoint: request.checkpoint,
        projectionText: projection.text
      });
    }
  } catch {
    draft = unavailableDraft(advisorModelId, located.binding.advisorTransportModel, "advisor_flight_unverified");
    inputSha256 = createHash("sha256").update(UNVERIFIED_FLIGHT).digest("hex");
  }

  // Fresh clock after the (possibly long) advisor call so a lease that expired during the call cannot record.
  const recordedAt = input.now ?? new Date().toISOString();
  const record = input.store.recordAdvisorConsultation(
    {
      subjectId: located.subjectId,
      missionId: located.binding.missionId,
      subjectKind: located.binding.subjectKind,
      checkpoint: request.checkpoint,
      disposition: draft.disposition,
      inputSha256,
      guidanceText: draft.guidance,
      declineReason: draft.declineReason,
      errorCode: draft.errorCode,
      executorModelId: located.binding.executorModelId,
      advisorModelId: located.binding.advisorModelId,
      inputTokens: draft.inputTokens,
      outputTokens: draft.outputTokens,
      createdAt: recordedAt,
      fence: located.fence
    },
    domain
  );
  return {
    consultationId: record.consultationId,
    checkpoint: record.checkpoint,
    disposition: record.disposition,
    guidance: record.guidanceText,
    declineReason: record.declineReason,
    errorCode: record.errorCode
  };
}

function unavailableDraft(
  advisorModelId: AdvisorModelId,
  transportModel: string,
  errorCode: string
): Awaited<ReturnType<typeof consultAdvisorModel>> {
  return {
    disposition: "unavailable",
    guidance: null,
    declineReason: null,
    errorCode,
    outputSha256: advisorOutputDigest("unavailable", errorCode),
    inputTokens: null,
    outputTokens: null,
    advisorModelId,
    transportModel
  };
}

function locateBinding(store: WorkItemStore, request: ReturnType<typeof advisorConsultRequestSchema.parse>) {
  if (request.subject.kind === "work_item") {
    const active = store.listAdvisorBindings(request.subject.workItemId).filter((binding) => !binding.disabledAt);
    if (active.length === 0) {
      throw new ControlStackError("advisor_not_configured", "advisor consultation requires an active binding");
    }
    if (active.length > 1) {
      throw new ControlStackError(
        "advisor_binding_ambiguous",
        "more than one advisor binding is active for this work item"
      );
    }
    const binding = active[0]!;
    return {
      binding,
      subjectId: request.subject.workItemId,
      fence: {
        kind: "work_item" as const,
        workItemId: request.subject.workItemId,
        ...(request.subject.attemptId ? { attemptId: request.subject.attemptId } : {}),
        leaseId: request.subject.leaseId,
        leaseToken: request.subject.leaseToken,
        workerId: request.subject.workerId,
        fencingEpoch: request.subject.fencingEpoch
      }
    };
  }
  const subjectId = missionUnitSubjectId(request.subject.missionId, request.subject.unitId);
  const binding = store.getAdvisorBinding(request.subject.missionId, subjectId);
  if (!binding || binding.disabledAt) {
    throw new ControlStackError("advisor_not_configured", "advisor consultation requires an active binding");
  }
  return {
    binding,
    subjectId,
    fence: {
      kind: "mission_unit" as const,
      missionId: request.subject.missionId,
      unitId: request.subject.unitId,
      workerId: request.subject.workerId,
      claimToken: request.subject.claimToken
    }
  };
}
