import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { strictCanonicalJsonV1 } from "@agent-control-stack/shared";
import { defaultExecutionPlanForWorkItem, SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { SqliteDesktopCommanderRuntimeRegistry, type DesktopCommanderCapability } from "@agent-control-stack/desktop-commander-adapter";
import { buildGateway, type GatewayAuthOptions } from "./server.js";

/**
 * End-to-end proof of the full ACS issuer -> managed Desktop Commander
 * verifier path for one innocuous read-only tool call.
 *
 * The ACS side is entirely real: the actual Fastify gateway (`buildGateway`),
 * the real `SqliteWorkItemStore` work-item/attempt/lease lifecycle, the real
 * `SqliteDesktopCommanderRuntimeRegistry` issuance gate, and the real signing
 * path in `@agent-control-stack/desktop-commander-adapter`. Nothing on the
 * ACS side is mocked or bypassed.
 *
 * The Desktop Commander side is out of ACS's ownership (a separate project,
 * dfec865 bridge in a separate worktree) and is never spawned or imported
 * here. This file implements only a minimal, self-contained, test-only
 * verifier that mirrors the normative rules in
 * docs/protocol/acs-dc-v1-capability-contract.md section 6 and 8 (signature,
 * canonicalization, claim binding, time window, single-use nonce). It exists
 * purely to prove the ACS-issued envelope is independently verifiable and
 * single-use - it does not stand in for, weaken, or duplicate the issuer or
 * policy implementation being tested. No network call is made and no
 * production credential is used.
 */

const IDENTITY_FINGERPRINT = "c".repeat(64);
const CAPABILITY_TTL_MS = 30_000;
const CLOCK_SKEW_MS = 5_000;

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

interface DcVerifierConfig {
  keyId: string;
  publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"];
}

interface DcVerifyResult {
  ok: boolean;
  reason?: string;
}

/** Reconstructs the ACS_DC_V1 nonce hash rule (sha256 of the raw nonce bytes). */
function nonceHash(nonce: string): string {
  return createHash("sha256").update(Buffer.from(nonce, "base64url")).digest("hex");
}

/**
 * A minimal, independent `acs.dc.v1` verifier. Deliberately reimplements the
 * check list from the contract doc rather than importing any ACS-side
 * verification helper, so this test proves interoperability against the
 * *documented wire contract*, not against ACS's own internal agreement with
 * itself.
 */
function verifyDesktopCommanderCapability(
  envelope: unknown,
  expected: { toolName: string; normalizedArguments: Record<string, unknown> },
  config: DcVerifierConfig,
  nonceReservations: Set<string>,
  now: Date
): DcVerifyResult {
  if (typeof envelope !== "object" || envelope === null) return { ok: false, reason: "malformed envelope" };
  const keys = Object.keys(envelope as Record<string, unknown>).sort();
  if (keys.join(",") !== "keyId,payload,signature") return { ok: false, reason: "unexpected envelope shape" };
  const { payload, signature, keyId } = envelope as DesktopCommanderCapability;

  if (keyId !== config.keyId) return { ok: false, reason: "unknown key id" };
  if (typeof signature !== "string") return { ok: false, reason: "malformed signature" };

  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(signature, "base64url");
  } catch {
    return { ok: false, reason: "malformed signature encoding" };
  }
  const verified = verify(null, Buffer.from(strictCanonicalJsonV1(payload), "utf8"), config.publicKey, signatureBytes);
  if (!verified) return { ok: false, reason: "signature verification failed" };

  if (payload.version !== "acs.dc.v1") return { ok: false, reason: "version mismatch" };
  if (payload.issuer !== "acs") return { ok: false, reason: "issuer mismatch" };
  if (payload.audience !== "desktop-commander") return { ok: false, reason: "audience mismatch" };
  if (payload.toolName !== expected.toolName) return { ok: false, reason: "tool mismatch" };
  if (JSON.stringify(payload.normalizedArguments) !== JSON.stringify(expected.normalizedArguments)) {
    return { ok: false, reason: "argument mismatch" };
  }

  const issuedAtMs = Date.parse(payload.issuedAt);
  const expiresAtMs = Date.parse(payload.expiresAt);
  const nowMs = now.getTime();
  if (!Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs)) return { ok: false, reason: "malformed time" };
  if (issuedAtMs > nowMs + CLOCK_SKEW_MS) return { ok: false, reason: "not yet valid" };
  if (expiresAtMs <= nowMs - CLOCK_SKEW_MS) return { ok: false, reason: "expired" };
  if (expiresAtMs <= issuedAtMs) return { ok: false, reason: "non-monotonic time window" };
  if (expiresAtMs - issuedAtMs > CAPABILITY_TTL_MS) return { ok: false, reason: "lifetime too long" };

  const reservation = `${keyId}:${nonceHash(payload.nonce)}`;
  if (nonceReservations.has(reservation)) return { ok: false, reason: "nonce replay" };
  nonceReservations.add(reservation);

  return { ok: true };
}

const bridgeAuth: GatewayAuthOptions = {
  token: "bridge-token",
  actor: "agent",
  actorId: "worker_e2e",
  credentials: [
    {
      id: "bridge",
      token: "bridge-token",
      actor: "agent",
      actorId: "worker_e2e",
      roles: ["worker"],
      scopes: ["acs:worker", "acs:desktop-commander:issue", "acs:read"]
    }
  ]
};

describe("end-to-end: ACS HTTP issuer -> independent acs.dc.v1 verifier", () => {
  it("issues, verifies, and single-shot-consumes a capability for an innocuous read-only Desktop Commander call", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-dc-e2e-"));
    directories.push(directory);
    const dbPath = join(directory, "control.db");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "acs-dc-e2e-root-")));
    directories.push(root);
    const readablePath = join(root, "readme.txt");
    writeFileSync(readablePath, "hello from an innocuous read-only Desktop Commander call\n");

    // --- Real ACS-side work-item lifecycle: create, approve, admit a
    // desktop_commander plan, and claim with real attempt/lease authority.
    const store = new SqliteWorkItemStore(dbPath);
    const workItem = store.create({
      title: "read a file via desktop commander (e2e)",
      requester: "agent",
      intent: "read an innocuous file",
      target: {},
      requestedActions: [{ kind: "read_file", description: "read", params: { tool: "read_file", arguments: { path: readablePath } } }],
      risk: "low"
    });
    store.approveWorkItem(workItem.id, { via: "domain_service" });
    const plan = store.createExecutionPlan({
      workItemId: workItem.id,
      definition: defaultExecutionPlanForWorkItem(workItem, { executionMode: "desktop_commander" }),
      createdByActorId: "actor-operator"
    });
    const admission = store.admitExecutionPlan(
      {
        workItemId: workItem.id,
        planHash: plan.planHash,
        policyVersion: "acs.policy.v1",
        policyDecisionHash: "b".repeat(64),
        requiresApproval: false,
        admittedByActorId: "policy-gate"
      },
      { via: "policy_gate" }
    );
    const claimed = store.claimNextApprovedWorkItem("worker_e2e", {
      attemptAuthority: {
        planHash: plan.planHash,
        admissionId: admission.admissionId,
        policyVersion: admission.policyVersion,
        policyDecisionHash: admission.policyDecisionHash
      }
    });
    if (!claimed) throw new Error("expected a claimed work item");
    store.close();

    // --- Real ACS-side runtime bootstrap: a Desktop Commander runtime
    // attests before ACS will ever issue a capability for it.
    const acsKeyPair = generateKeyPairSync("ed25519");
    const runtimeRegistry = new SqliteDesktopCommanderRuntimeRegistry(dbPath);
    const bootstrap = runtimeRegistry.issueBootstrap({ runtimeId: "runtime_e2e", identityConfigFingerprint: IDENTITY_FINGERPRINT, scopes: ["fs.read"] });
    runtimeRegistry.completeBootstrap(bootstrap);
    runtimeRegistry.close();

    // --- Real ACS gateway process, holding the private key only in its own
    // process memory. The DC side below never receives it.
    const app = buildGateway({
      dbPath,
      logger: false,
      auth: bridgeAuth,
      desktopCommanderCapabilityIssuer: {
        allowedRoots: [root],
        deniedRoots: [],
        capability: {
          runtimeId: "runtime_e2e",
          runtimeIdentityConfigFingerprint: IDENTITY_FINGERPRINT,
          runtimeScopes: ["fs.read"],
          keyId: "e2e-key-1",
          privateKey: acsKeyPair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
          databasePath: dbPath
        }
      }
    });

    try {
      // --- The bridge asks ACS, over real HTTP, for one capability.
      const issued = await app.inject({
        method: "POST",
        url: `/work-items/${workItem.id}/desktop-commander/capability`,
        headers: { authorization: "Bearer bridge-token" },
        payload: { attemptId: claimed.attemptId }
      });
      expect(issued.statusCode).toBe(201);
      const { capability } = issued.json() as { capability: DesktopCommanderCapability };

      // --- The bridge separately discovers the current public key/keyId
      // (as it would from static configuration or the discovery route).
      const keyResponse = await app.inject({ method: "GET", url: "/desktop-commander/capability-key", headers: { authorization: "Bearer bridge-token" } });
      expect(keyResponse.statusCode).toBe(200);
      const { keyId: discoveredKeyId, publicKey: discoveredPublicKeyB64 } = keyResponse.json() as { keyId: string; publicKey: string };
      const dcConfig: DcVerifierConfig = {
        keyId: discoveredKeyId,
        publicKey: createPublicKey({ key: Buffer.from(discoveredPublicKeyB64, "base64url"), format: "der", type: "spki" })
      };

      // --- Independent Desktop Commander verifier: `tools/call` arrives
      // with the capability attached at `params._meta.acsCapability`, and DC
      // decides purely from the signed payload and its own configuration.
      const toolCallRequest = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: capability.payload.toolName,
          arguments: capability.payload.normalizedArguments,
          _meta: { acsCapability: capability }
        }
      };
      const nonceReservations = new Set<string>();
      const firstVerification = verifyDesktopCommanderCapability(
        toolCallRequest.params._meta.acsCapability,
        { toolName: "read_file", normalizedArguments: { path: readablePath } },
        dcConfig,
        nonceReservations,
        new Date()
      );
      expect(firstVerification).toEqual({ ok: true });

      // Only after verification does DC "execute" the innocuous read.
      const contents = readFileSync(readablePath, "utf8");
      expect(contents).toContain("innocuous read-only");

      // --- Replay: the exact same envelope must never verify twice.
      const replayVerification = verifyDesktopCommanderCapability(
        toolCallRequest.params._meta.acsCapability,
        { toolName: "read_file", normalizedArguments: { path: readablePath } },
        dcConfig,
        nonceReservations,
        new Date()
      );
      expect(replayVerification.ok).toBe(false);
      expect(replayVerification.reason).toBe("nonce replay");

      // --- ACS itself also refuses to issue a second capability for the
      // same attempt lease, independent of DC's own replay defense.
      const secondIssuance = await app.inject({
        method: "POST",
        url: `/work-items/${workItem.id}/desktop-commander/capability`,
        headers: { authorization: "Bearer bridge-token" },
        payload: { attemptId: claimed.attemptId }
      });
      expect(secondIssuance.statusCode).toBe(409);

      // --- Wrong child public key: DC configured with an unrelated key
      // never accepts a genuinely ACS-signed capability.
      const wrongKeyPair = generateKeyPairSync("ed25519");
      const wrongKeyVerification = verifyDesktopCommanderCapability(
        toolCallRequest.params._meta.acsCapability,
        { toolName: "read_file", normalizedArguments: { path: readablePath } },
        { keyId: discoveredKeyId, publicKey: wrongKeyPair.publicKey },
        new Set(),
        new Date()
      );
      expect(wrongKeyVerification).toEqual({ ok: false, reason: "signature verification failed" });

      // --- Unknown key id: DC configured for a different key id rejects
      // outright, without ever touching the signature.
      const unknownKeyIdVerification = verifyDesktopCommanderCapability(
        toolCallRequest.params._meta.acsCapability,
        { toolName: "read_file", normalizedArguments: { path: readablePath } },
        { keyId: "some-other-key", publicKey: dcConfig.publicKey },
        new Set(),
        new Date()
      );
      expect(unknownKeyIdVerification).toEqual({ ok: false, reason: "unknown key id" });

      // --- Client-injected/forged meta: a raw, self-asserted capability
      // never sent by ACS must not verify, proving there is no bypass of
      // the issuer for a locally-fabricated envelope.
      const forged: DesktopCommanderCapability = {
        payload: { ...capability.payload, nonce: `${capability.payload.nonce.slice(0, -1)}A` },
        signature: capability.signature,
        keyId: capability.keyId
      };
      const forgedVerification = verifyDesktopCommanderCapability(
        forged,
        { toolName: "read_file", normalizedArguments: { path: readablePath } },
        dcConfig,
        new Set(),
        new Date()
      );
      expect(forgedVerification).toEqual({ ok: false, reason: "signature verification failed" });
    } finally {
      await app.close();
    }
  });
});
