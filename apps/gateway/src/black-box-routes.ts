import {
  RecorderStore,
  recomputeFindings,
  recorderFeatureEnabled,
  summarizeRun,
  verifyJcWitnessReceipt
} from "@agent-control-stack/black-box-recorder";
import type { CodingMissionController } from "@agent-control-stack/coding-mission";
import type { SqliteWorkItemStore, StoredAuditEvent } from "@agent-control-stack/work-items";
import type { FastifyInstance } from "fastify";
import {
  gatewayCredentialForRequest,
  requireMutationActor,
  type GatewayAuthOptions
} from "./credentials.js";

export interface GatewayBlackBoxOptions {
  enabled?: boolean;
  trustedWitnessKeys?: Record<string, string>;
  requireLiveMode?: boolean;
}

function loadWitnessKeysFromEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const raw = env.ACS_KERNEL_WITNESS_PUBLIC_KEYS;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && v.length > 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function registerBlackBoxRoutes(params: {
  app: FastifyInstance;
  auth: GatewayAuthOptions | undefined;
  workItems: SqliteWorkItemStore;
  codingMissions: CodingMissionController | undefined;
  broadcast: (event: StoredAuditEvent) => void;
  options?: GatewayBlackBoxOptions;
}): void {
  const { app, auth, workItems, codingMissions, broadcast, options } = params;
  const enabled = options?.enabled ?? recorderFeatureEnabled();
  const trustedWitnessKeys = options?.trustedWitnessKeys ?? loadWitnessKeysFromEnv();
  const seenEvidenceHashes = new Set<string>();
  const recorderStore = new RecorderStore({ enabled });

  app.post("/black-box/kernel-witness/receipts", async (request, reply) => {
    const actor = requireMutationActor(request, reply, auth, "acs:write");
    if (!actor) return;
    if (!enabled) {
      return reply.code(503).send({ error: "black box recorder is disabled", code: "black_box_disabled" });
    }
    const body = request.body as { receipt?: unknown } | null | undefined;
    if (!body || typeof body !== "object" || !("receipt" in body)) {
      return reply.code(400).send({ error: "request body must include receipt", code: "invalid_request" });
    }

    const precheck = await verifyJcWitnessReceipt(body.receipt, {
      trustedWitnessKeys,
      seenEvidenceHashes,
      requireAcsAnchor: false,
      requireLiveMode: options?.requireLiveMode ?? false
    });
    if (!precheck.valid) {
      const isReplay = precheck.reasons.some((r) => r.includes("replayed"));
      return reply.code(isReplay ? 409 : 422).send({
        error: precheck.reasons.join("; "),
        code: isReplay ? "witness_receipt_replay" : "invalid_witness_receipt",
        reasons: precheck.reasons
      });
    }

    const receipt = precheck.receipt;
    const workItemExists = Boolean(workItems.get(receipt.workItemId) || codingMissions?.store.exists(receipt.workItemId));
    const hasAnchor = workItemExists && typeof receipt.acsAnchorRef === "string" && receipt.acsAnchorRef.length > 0;
    const observed = precheck.observed && hasAnchor;

    const anchored = workItems.recordSystemEventOnce({
      name: observed ? "black_box.witness_observed" : "black_box.witness_incomplete",
      uniqueAttribute: "witness.evidence_hash",
      attributes: {
        "work_item.id": receipt.workItemId,
        "witness.attempt_id": receipt.attemptId,
        "witness.lease_id": receipt.leaseId,
        "witness.evidence_hash": receipt.evidenceHash,
        "witness.observed": observed,
        "black_box.actor": actor
      },
      body: {
        schemaVersion: receipt.schemaVersion,
        observerId: receipt.observerId,
        observerMode: receipt.observerMode,
        status: receipt.status,
        cgroupId: receipt.cgroupId,
        droppedEvents: receipt.droppedEvents,
        sequenceGaps: receipt.sequenceGaps,
        evidenceHash: receipt.evidenceHash,
        previousEvidenceHash: receipt.previousEvidenceHash,
        acsAnchorRef: receipt.acsAnchorRef
      }
    });
    if (anchored.recorded) {
      broadcast(anchored.event);
    }

    const ingested = await recorderStore.ingestWitnessReceipt(receipt, {
      trustedWitnessKeys,
      seenEvidenceHashes,
      requireAcsAnchor: true,
      acsAnchorVerified: workItemExists,
      requireLiveMode: options?.requireLiveMode ?? false,
      ingestedAt: new Date().toISOString()
    });
    if (!ingested.accepted) {
      const isReplay = ingested.reasons.some((r) => r.includes("replayed"));
      return reply.code(isReplay ? 409 : 422).send({
        error: ingested.reason ?? "witness receipt rejected",
        code: isReplay ? "witness_receipt_replay" : "invalid_witness_receipt",
        reasons: ingested.reasons
      });
    }

    const statusCode = ingested.ingestResult?.status === "duplicate" ? 200 : 201;
    const eventId =
      ingested.ingestResult && "event" in ingested.ingestResult ? ingested.ingestResult.event.eventId : null;
    return reply.code(statusCode).send({
      status: ingested.ingestResult?.status ?? "created",
      observed: ingested.observed && workItemExists,
      trustLevel: ingested.observed && workItemExists ? ingested.trustLevel : "untrusted_claim",
      eventId,
      evidenceHash: receipt.evidenceHash,
      reasons: ingested.reasons,
      anchor: {
        auditEventId: anchored.event.id,
        auditEventHash: anchored.event.eventHash
      }
    });
  });

  app.get<{ Params: { id: string } }>("/coding-missions/:id/black-box", async (request, reply) => {
    const credential = gatewayCredentialForRequest(request, auth);
    if (!credential?.scopes.includes("acs:read")) return reply.code(401).send({ error: "unauthorized" });
    const missionId = request.params.id;
    const events = recorderStore.eventsFor(missionId);
    const chain = await recorderStore.verifyChain();
    const summary = events.length > 0 ? summarizeRun(missionId, events, recorderStore) : null;
    const findings = events.length > 0 ? recomputeFindings(recorderStore).filter((f) => f.runId === missionId) : [];
    return {
      missionId,
      enabled,
      chain,
      events,
      summary,
      findings
    };
  });
}
