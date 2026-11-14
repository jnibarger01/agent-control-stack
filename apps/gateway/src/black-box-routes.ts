import {
  ImmutableFsWormSink,
  ObserverKeyRegistry,
  RecorderStore,
  S3ObjectLockWormSink,
  recomputeFindings,
  recorderFeatureEnabled,
  summarizeRun,
  toWitnessRecorderDraft,
  verifyJcWitnessReceipt,
  type JcWitnessCategory,
  type WormEvidenceSink
} from "@agent-control-stack/black-box-recorder";
import type { CodingMissionController } from "@agent-control-stack/coding-mission";
import type { SqliteWorkItemStore, StoredAuditEvent } from "@agent-control-stack/work-items";
import type { FastifyInstance } from "fastify";
import {
  SqliteBlackBoxPersistence,
  type FaultInjector
} from "./black-box-durable.js";
import {
  firstHeader,
  gatewayCredentialForRequest,
  requireMutationActor,
  requireObserverKeyAdminActor,
  type GatewayAuthOptions
} from "./credentials.js";

export interface GatewayBlackBoxOptions {
  enabled?: boolean;
  trustedWitnessKeys?: Record<string, string>;
  requireLiveMode?: boolean;
  allowRotatedHistorical?: boolean;
  strictExecutionBinding?: boolean;
  requiredCategories?: readonly JcWitnessCategory[];
  wormSink?: WormEvidenceSink;
  wormRootDir?: string;
  faultInjector?: FaultInjector;
}

function loadWitnessKeysFromEnv(
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const raw = env.ACS_KERNEL_WITNESS_PUBLIC_KEYS;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && v.length > 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function resolveWormSinkFromConfig(
  options?: GatewayBlackBoxOptions,
  env: NodeJS.ProcessEnv = process.env
): WormEvidenceSink | undefined {
  if (options?.wormSink) return options.wormSink;
  if (options?.wormRootDir) {
    return new ImmutableFsWormSink({ rootDir: options.wormRootDir });
  }
  const s3Endpoint = env.ACS_BLACK_BOX_WORM_S3_ENDPOINT?.trim();
  const s3Bucket = env.ACS_BLACK_BOX_WORM_S3_BUCKET?.trim();
  if (s3Endpoint && s3Bucket) {
    const retentionMode =
      env.ACS_BLACK_BOX_WORM_S3_MODE === "GOVERNANCE"
        ? "GOVERNANCE"
        : "COMPLIANCE";
    const parsedDays = Number(env.ACS_BLACK_BOX_WORM_RETENTION_DAYS);
    const retentionDays =
      Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : undefined;
    const authToken = env.ACS_BLACK_BOX_WORM_S3_AUTH_TOKEN?.trim();
    return new S3ObjectLockWormSink({
      endpointUrl: s3Endpoint,
      bucket: s3Bucket,
      prefix: env.ACS_BLACK_BOX_WORM_S3_PREFIX?.trim() || undefined,
      retentionMode,
      retentionDays,
      headers: authToken ? { authorization: `Bearer ${authToken}` } : undefined
    });
  }
  if (env.ACS_BLACK_BOX_WORM_DIR) {
    return new ImmutableFsWormSink({
      rootDir: env.ACS_BLACK_BOX_WORM_DIR
    });
  }
  return undefined;
}

export function registerBlackBoxRoutes(params: {
  app: FastifyInstance;
  dbPath: string;
  auth: GatewayAuthOptions | undefined;
  workItems: SqliteWorkItemStore;
  codingMissions: CodingMissionController | undefined;
  broadcast: (event: StoredAuditEvent) => void;
  options?: GatewayBlackBoxOptions;
}): void {
  const { app, dbPath, auth, workItems, codingMissions, broadcast, options } =
    params;
  const enabled = options?.enabled ?? recorderFeatureEnabled();
  const seedKeys = options?.trustedWitnessKeys ?? loadWitnessKeysFromEnv();
  const seenEvidenceHashes = new Set<string>();
  const recorderStore = new RecorderStore({ enabled });
  const persistence =
    dbPath !== ":memory:" ? new SqliteBlackBoxPersistence(dbPath) : null;
  let keyRegistry = new ObserverKeyRegistry();
  const wormSink: WormEvidenceSink | undefined = resolveWormSinkFromConfig(options);

  const readyPromise = (async () => {
    if (persistence) {
      await persistence.verifyAndHydrateStore(
        recorderStore,
        seenEvidenceHashes
      );
      const persistedKeys = persistence.loadObserverKeys();
      keyRegistry = new ObserverKeyRegistry(persistedKeys);
    }
    for (const [keyId, publicKeyPem] of Object.entries(seedKeys)) {
      if (!keyRegistry.get(keyId)) {
        const rec = await keyRegistry.registerKey({
          keyId,
          observerId: `seed:${keyId}`,
          publicKeyPem,
          registeredAt: "1970-01-01T00:00:00.000Z",
          registeredBy: "gateway-config"
        });
        persistence?.upsertObserverKey(rec);
      }
    }
    if (persistence && wormSink) {
      try {
        await persistence.flushWormOutbox(wormSink, keyRegistry);
      } catch {
        // Outbox remains pending/failed for retry if sink is temporarily unreachable at boot.
      }
    }
  })();

  if (persistence) {
    app.addHook("onClose", async () => {
      persistence.close();
    });
  }

  app.post("/black-box/kernel-witness/receipts", async (request, reply) => {
    await readyPromise;
    const actor = requireMutationActor(request, reply, auth, "acs:write");
    if (!actor) return;
    if (!enabled) {
      return reply
        .code(503)
        .send({
          error: "black box recorder is disabled",
          code: "black_box_disabled"
        });
    }
    const body = request.body as
      | {
          receipt?: unknown;
          idempotencyKey?: unknown;
          skipImmediateWormFlush?: boolean;
        }
      | null
      | undefined;
    if (!body || typeof body !== "object" || !("receipt" in body)) {
      return reply
        .code(400)
        .send({
          error: "request body must include receipt",
          code: "invalid_request"
        });
    }

    const idempotencyKey =
      firstHeader(request.headers["idempotency-key"]) ??
      (typeof body.idempotencyKey === "string" && body.idempotencyKey.length > 0
        ? body.idempotencyKey
        : null);

    const faultInjector = options?.faultInjector;
    const requireLiveMode = options?.requireLiveMode ?? true;

    await faultInjector?.("B1_BEFORE_VERIFY");

    const precheck = await verifyJcWitnessReceipt(body.receipt, {
      keyRegistry,
      allowRotatedHistorical: options?.allowRotatedHistorical ?? false,
      seenEvidenceHashes: persistence ? undefined : seenEvidenceHashes,
      requireAcsAnchor: false,
      requireLiveMode,
      requiredCategories: options?.requiredCategories
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
    const workItemExistsInController = Boolean(
      workItems.get(receipt.workItemId) ||
        codingMissions?.store.exists(receipt.workItemId)
    );
    const binding = persistence
      ? persistence.verifyExecutionBinding(receipt, {
          workItemExistsInController,
          strictExecutionBinding: options?.strictExecutionBinding
        })
      : {
          workItemExists: workItemExistsInController,
          anchorVerified:
            workItemExistsInController &&
            typeof receipt.acsAnchorRef === "string" &&
            (receipt.acsAnchorRef === `acs:work_item:${receipt.workItemId}` ||
              receipt.acsAnchorRef === `acs:mission:${receipt.workItemId}` ||
              receipt.acsAnchorRef.startsWith(
                `acs:work_item:${receipt.workItemId}:`
              )),
          reasons: []
        };

    const fullVerification = await verifyJcWitnessReceipt(receipt, {
      keyRegistry,
      allowRotatedHistorical: options?.allowRotatedHistorical ?? false,
      seenEvidenceHashes: persistence ? undefined : seenEvidenceHashes,
      requireAcsAnchor: true,
      acsAnchorVerified: binding.anchorVerified,
      requireLiveMode,
      requiredCategories: options?.requiredCategories
    });
    if (!fullVerification.valid) {
      const isReplay = fullVerification.reasons.some((r) =>
        r.includes("replayed")
      );
      return reply.code(isReplay ? 409 : 422).send({
        error: fullVerification.reasons.join("; "),
        code: isReplay ? "witness_receipt_replay" : "invalid_witness_receipt",
        reasons: fullVerification.reasons
      });
    }

    const observed = fullVerification.observed && binding.anchorVerified;
    const allReasons = [...fullVerification.reasons, ...binding.reasons];
    const ingestedAt = new Date().toISOString();

    await faultInjector?.("B2_AFTER_VERIFY_BEFORE_TX");

    if (persistence) {
      const draft = toWitnessRecorderDraft(
        receipt,
        fullVerification,
        ingestedAt
      );
      const prep = await recorderStore.prepareDraft(draft, observed);
      if (!prep.ok) {
        return reply.code(422).send({
          error: prep.reason,
          code: "invalid_witness_receipt",
          reasons: [prep.reason]
        });
      }

      const wasAlreadyInMemory = seenEvidenceHashes.has(receipt.evidenceHash);
      const txResult = persistence.ingestWitnessReceiptTransactional({
        receipt,
        prepared: prep.prepared,
        observed,
        actor,
        idempotencyKey,
        allowUnkeyedIdempotentRecovery: !wasAlreadyInMemory,
        faultInjector
      });

      if (!("event" in txResult)) {
        if (txResult.status === "conflict") {
          recorderStore.recordConflict({
            producerKey: prep.prepared.producerKey,
            existingEventId: txResult.existingEvent.eventId,
            rejectedSha256: txResult.rejectedSha256,
            ingestedAt
          });
        }
        return reply.code(409).send({
          error: txResult.reason,
          code:
            txResult.status === "replay"
              ? "witness_receipt_replay"
              : "witness_receipt_conflict",
          reasons: [txResult.reason]
        });
      }

      await faultInjector?.("B7_AFTER_COMMIT_BEFORE_MEMORY_SYNC");

      recorderStore.syncCommittedEvent({
        event: txResult.event,
        producerKey: txResult.producerKey,
        fingerprint: txResult.fingerprint,
        evidenceHash: receipt.evidenceHash
      });
      seenEvidenceHashes.add(receipt.evidenceHash);

      if (txResult.recordedAudit) {
        broadcast(txResult.auditEvent);
      }

      let wormAnchored = false;
      let wormStatus: "anchored" | "pending" | "unconfigured" = wormSink
        ? "pending"
        : "unconfigured";
      if (wormSink && !body.skipImmediateWormFlush) {
        try {
          const flushRes = await persistence.flushWormOutbox(
            wormSink,
            keyRegistry,
            faultInjector
          );
          wormAnchored =
            flushRes.anchoredCount > 0 || txResult.status === "duplicate";
          wormStatus = wormAnchored ? "anchored" : "pending";
        } catch {
          wormAnchored = false;
          wormStatus = "pending";
        }
      }

      const statusCode = txResult.status === "duplicate" ? 200 : 201;
      return reply.code(statusCode).send({
        status: txResult.status,
        observed:
          observed &&
          txResult.event.trustLevel === "independently_verified",
        trustLevel: txResult.event.trustLevel,
        eventId: txResult.event.eventId,
        seq: txResult.event.evidence.seq,
        evidenceHash: receipt.evidenceHash,
        reasons: allReasons,
        wormAnchored,
        worm: {
          status: wormStatus,
          anchored: wormAnchored
        },
        anchor: {
          auditEventId: txResult.auditEvent.id,
          auditEventHash: txResult.auditEvent.eventHash
        }
      });
    }

    // Fallback for in-memory (:memory:) DB
    const anchored = workItems.recordSystemEventOnce({
      name: observed
        ? "black_box.witness_observed"
        : "black_box.witness_incomplete",
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
      keyRegistry,
      allowRotatedHistorical: options?.allowRotatedHistorical ?? false,
      seenEvidenceHashes,
      requireAcsAnchor: true,
      acsAnchorVerified: binding.anchorVerified,
      requireLiveMode,
      requiredCategories: options?.requiredCategories,
      ingestedAt
    });
    if (!ingested.accepted) {
      const isReplay = ingested.reasons.some((r) => r.includes("replayed"));
      return reply.code(isReplay ? 409 : 422).send({
        error: ingested.reason ?? "witness receipt rejected",
        code: isReplay ? "witness_receipt_replay" : "invalid_witness_receipt",
        reasons: ingested.reasons
      });
    }

    const statusCode =
      ingested.ingestResult?.status === "duplicate" ? 200 : 201;
    const eventId =
      ingested.ingestResult && "event" in ingested.ingestResult
        ? ingested.ingestResult.event.eventId
        : null;
    return reply.code(statusCode).send({
      status: ingested.ingestResult?.status ?? "created",
      observed: ingested.observed && binding.anchorVerified,
      trustLevel:
        ingested.observed && binding.anchorVerified
          ? ingested.trustLevel
          : "untrusted_claim",
      eventId,
      evidenceHash: receipt.evidenceHash,
      reasons: allReasons,
      anchor: {
        auditEventId: anchored.event.id,
        auditEventHash: anchored.event.eventHash
      }
    });
  });

  app.post("/black-box/observers/register", async (request, reply) => {
    await readyPromise;
    const actor = requireObserverKeyAdminActor(request, reply, auth);
    if (!actor) return;
    const body = request.body as
      | {
          keyId?: unknown;
          observerId?: unknown;
          publicKeyPem?: unknown;
          expectedFingerprintSha256?: unknown;
        }
      | null
      | undefined;
    if (
      !body ||
      typeof body.keyId !== "string" ||
      typeof body.observerId !== "string" ||
      typeof body.publicKeyPem !== "string"
    ) {
      return reply.code(400).send({
        error: "keyId, observerId, and publicKeyPem are required",
        code: "invalid_request"
      });
    }
    try {
      const record = await keyRegistry.registerKey({
        keyId: body.keyId,
        observerId: body.observerId,
        publicKeyPem: body.publicKeyPem,
        expectedFingerprintSha256:
          typeof body.expectedFingerprintSha256 === "string"
            ? body.expectedFingerprintSha256
            : undefined,
        registeredBy: actor
      });
      if (persistence) {
        const committed = persistence.registerObserverKeyTransactional({
          record,
          actor
        });
        broadcast(committed.auditEvent);
        return reply
          .code(201)
          .send({ key: committed.record, auditEventId: committed.auditEvent.id });
      }
      const audit = workItems.recordSystemEvent({
        name: "black_box.observer_key_registered",
        attributes: {
          "observer.id": body.observerId,
          "observer.key_id": body.keyId,
          "black_box.actor": actor
        },
        body: { keyId: body.keyId, observerId: body.observerId }
      });
      broadcast(audit);
      return reply.code(201).send({ key: record, auditEventId: audit.id });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "failed to register observer key";
      const code = message.includes("already registered") ? 409 : 422;
      return reply
        .code(code)
        .send({ error: message, code: "observer_key_registration_failed" });
    }
  });

  app.post("/black-box/observers/rotate", async (request, reply) => {
    await readyPromise;
    const actor = requireObserverKeyAdminActor(request, reply, auth);
    if (!actor) return;
    const body = request.body as
      | {
          oldKeyId?: unknown;
          newKeyId?: unknown;
          newPublicKeyPem?: unknown;
          observerId?: unknown;
          expectedFingerprintSha256?: unknown;
        }
      | null
      | undefined;
    if (
      !body ||
      typeof body.oldKeyId !== "string" ||
      typeof body.newKeyId !== "string" ||
      typeof body.newPublicKeyPem !== "string"
    ) {
      return reply.code(400).send({
        error: "oldKeyId, newKeyId, and newPublicKeyPem are required",
        code: "invalid_request"
      });
    }
    try {
      const { oldRecord, newRecord } = await keyRegistry.rotateKey({
        oldKeyId: body.oldKeyId,
        newKeyId: body.newKeyId,
        newPublicKeyPem: body.newPublicKeyPem,
        observerId:
          typeof body.observerId === "string" ? body.observerId : undefined,
        expectedNewFingerprintSha256:
          typeof body.expectedFingerprintSha256 === "string"
            ? body.expectedFingerprintSha256
            : undefined,
        rotatedBy: actor
      });
      if (persistence) {
        const committed = persistence.rotateObserverKeyTransactional({
          oldRecord,
          newRecord,
          actor
        });
        broadcast(committed.auditEvent);
        return reply.code(200).send({
          oldKey: committed.oldRecord,
          newKey: committed.newRecord,
          auditEventId: committed.auditEvent.id
        });
      }
      const audit = workItems.recordSystemEvent({
        name: "black_box.observer_key_rotated",
        attributes: {
          "observer.old_key_id": body.oldKeyId,
          "observer.new_key_id": body.newKeyId,
          "black_box.actor": actor
        },
        body: { oldKeyId: body.oldKeyId, newKeyId: body.newKeyId }
      });
      broadcast(audit);
      return reply
        .code(200)
        .send({ oldKey: oldRecord, newKey: newRecord, auditEventId: audit.id });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "failed to rotate observer key";
      const code = message.includes("does not exist")
        ? 404
        : message.includes("already registered")
          ? 409
          : 422;
      return reply
        .code(code)
        .send({ error: message, code: "observer_key_rotation_failed" });
    }
  });

  app.post("/black-box/observers/retire", async (request, reply) => {
    await readyPromise;
    const actor = requireObserverKeyAdminActor(request, reply, auth);
    if (!actor) return;
    const body = request.body as { keyId?: unknown } | null | undefined;
    if (!body || typeof body.keyId !== "string") {
      return reply.code(400).send({
        error: "keyId is required",
        code: "invalid_request"
      });
    }
    try {
      const record = keyRegistry.retireKey({
        keyId: body.keyId,
        retiredBy: actor
      });
      if (persistence) {
        const committed = persistence.retireObserverKeyTransactional({
          record,
          actor
        });
        broadcast(committed.auditEvent);
        return reply
          .code(200)
          .send({ key: committed.record, auditEventId: committed.auditEvent.id });
      }
      const audit = workItems.recordSystemEvent({
        name: "black_box.observer_key_retired",
        attributes: {
          "observer.key_id": body.keyId,
          "black_box.actor": actor
        },
        body: { keyId: body.keyId }
      });
      broadcast(audit);
      return reply.code(200).send({ key: record, auditEventId: audit.id });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "failed to retire observer key";
      const code = message.includes("does not exist") ? 404 : 422;
      return reply
        .code(code)
        .send({ error: message, code: "observer_key_retirement_failed" });
    }
  });

  app.post("/black-box/observers/revoke", async (request, reply) => {
    await readyPromise;
    const actor = requireObserverKeyAdminActor(request, reply, auth);
    if (!actor) return;
    const body = request.body as
      | { keyId?: unknown; reason?: unknown }
      | null
      | undefined;
    if (
      !body ||
      typeof body.keyId !== "string" ||
      typeof body.reason !== "string"
    ) {
      return reply.code(400).send({
        error: "keyId and reason are required",
        code: "invalid_request"
      });
    }
    try {
      const record = keyRegistry.revokeKey({
        keyId: body.keyId,
        reason: body.reason,
        revokedBy: actor
      });
      if (persistence) {
        const committed = persistence.revokeObserverKeyTransactional({
          record,
          reason: body.reason,
          actor
        });
        broadcast(committed.auditEvent);
        return reply
          .code(200)
          .send({ key: committed.record, auditEventId: committed.auditEvent.id });
      }
      const audit = workItems.recordSystemEvent({
        name: "black_box.observer_key_revoked",
        attributes: {
          "observer.key_id": body.keyId,
          "black_box.actor": actor
        },
        body: { keyId: body.keyId, reason: body.reason }
      });
      broadcast(audit);
      return reply.code(200).send({ key: record, auditEventId: audit.id });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "failed to revoke observer key";
      const code = message.includes("does not exist") ? 404 : 422;
      return reply
        .code(code)
        .send({ error: message, code: "observer_key_revocation_failed" });
    }
  });

  app.get("/black-box/observers", async (request, reply) => {
    await readyPromise;
    const credential = gatewayCredentialForRequest(request, auth);
    if (!credential?.scopes.includes("acs:read"))
      return reply.code(401).send({ error: "unauthorized" });
    return { keys: keyRegistry.list() };
  });

  app.get("/black-box/kernel-witness/worm-status", async (request, reply) => {
    await readyPromise;
    const credential = gatewayCredentialForRequest(request, auth);
    if (!credential?.scopes.includes("acs:read"))
      return reply.code(401).send({ error: "unauthorized" });
    const rows = persistence?.listWormOutbox() ?? [];
    const anchored = rows.filter((r) => r.status === "anchored").length;
    const pending = rows.filter((r) => r.status !== "anchored").length;
    const sinkIntegrity = wormSink
      ? await wormSink.verifySinkIntegrity(keyRegistry)
      : null;
    return {
      wormConfigured: Boolean(wormSink),
      providerId: wormSink?.providerId ?? null,
      outbox: {
        anchored,
        pending,
        rows
      },
      sinkIntegrity,
      sinkReport: sinkIntegrity
    };
  });

  app.post("/black-box/kernel-witness/worm-flush", async (request, reply) => {
    await readyPromise;
    const actor = requireMutationActor(request, reply, auth, "acs:write");
    if (!actor) return;
    if (!persistence || !wormSink) {
      return reply.code(503).send({
        error: "WORM sink or durable persistence is not configured",
        code: "worm_not_configured"
      });
    }
    const result = await persistence.flushWormOutbox(
      wormSink,
      keyRegistry,
      options?.faultInjector
    );
    const outbox = persistence.listWormOutbox();
    const pending = outbox.filter((r) => r.status !== "anchored").length;
    return {
      ...result,
      anchored: result.anchoredCount,
      pending,
      outbox
    };
  });

  app.post("/black-box/kernel-witness/reconstruct", async (request, reply) => {
    await readyPromise;
    const actor = requireObserverKeyAdminActor(request, reply, auth);
    if (!actor) return;
    if (!persistence || !wormSink) {
      return reply.code(503).send({
        error: "WORM sink or durable persistence is not configured",
        code: "worm_not_configured"
      });
    }
    try {
      const reconstructed = await persistence.reconstructFromWormSink(
        wormSink,
        keyRegistry,
        recorderStore,
        seenEvidenceHashes
      );
      return reply.code(200).send(reconstructed);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "failed to reconstruct from WORM sink";
      return reply.code(422).send({
        error: message,
        code: "worm_reconstruction_failed"
      });
    }
  });

  app.get<{ Params: { id: string } }>(
    "/coding-missions/:id/black-box",
    async (request, reply) => {
      await readyPromise;
      const credential = gatewayCredentialForRequest(request, auth);
      if (!credential?.scopes.includes("acs:read"))
        return reply.code(401).send({ error: "unauthorized" });
      if (persistence) {
        persistence.syncPendingFromDatabase(recorderStore, seenEvidenceHashes);
      }
      const missionId = request.params.id;
      const events = recorderStore.eventsFor(missionId);
      const chain = await recorderStore.verifyChain();
      const summary =
        events.length > 0
          ? summarizeRun(missionId, events, recorderStore)
          : null;
      const findings =
        events.length > 0
          ? recomputeFindings(recorderStore).filter(
              (f) => f.runId === missionId
            )
          : [];
      const outbox =
        persistence
          ?.listWormOutbox()
          .filter((o) => events.some((ev) => ev.eventId === o.eventId)) ?? [];
      return {
        missionId,
        enabled,
        chain,
        events,
        summary,
        findings,
        wormOutbox: outbox
      };
    }
  );
}
