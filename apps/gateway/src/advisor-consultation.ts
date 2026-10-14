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
  now?: string;
}): Promise<AdvisorConsultationResult> {
  const request = advisorConsultRequestSchema.parse(input.request);
  const located = locateBinding(input.store, request);
  const createdAt = input.now ?? new Date().toISOString();
  input.store.assertAdvisorConsultationLease({
    subjectId: located.subjectId,
    missionId: located.binding.missionId,
    subjectKind: located.binding.subjectKind,
    fence: located.fence,
    now: createdAt
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
      createdAt,
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
