import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { strictCanonicalJsonV1 } from "@agent-control-stack/shared";
import { defaultExecutionPlanForWorkItem, SqliteWorkItemStore, type ClaimedWorkItem, type WorkItem } from "@agent-control-stack/work-items";
import type { DesktopCommanderCapabilityIssuerConfig } from "@agent-control-stack/desktop-commander-adapter";
import { buildGateway, type GatewayAuthOptions } from "./server.js";

const WORKER_ID = "worker_dc_1";
const IDENTITY_FINGERPRINT = "c".repeat(64);

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const bridgeAuth: GatewayAuthOptions = {
  token: "bridge-token",
  actor: "agent",
  actorId: WORKER_ID,
  credentials: [
    {
      id: "bridge",
      token: "bridge-token",
      actor: "agent",
      actorId: WORKER_ID,
      roles: ["worker"],
      scopes: ["acs:worker", "acs:desktop-commander:issue", "acs:read"]
    },
    {
      id: "worker-only",
      token: "worker-only-token",
      actor: "agent",
      actorId: "worker_no_issue_scope",
      roles: ["worker"],
      scopes: ["acs:worker"]
    },
    {
      id: "operator",
      token: "operator-token",
      actor: "user",
      actorId: "operator-a",
      roles: ["operator"],
      scopes: ["acs:read", "acs:write", "acs:approve"]
    }
  ]
};

function seedClaim(dbPath: string): { workItem: WorkItem; claimed: ClaimedWorkItem; root: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gateway-dc-root-")));
  directories.push(root);
  const store = new SqliteWorkItemStore(dbPath);
  try {
    const workItem = store.create({
      title: "read a file via desktop commander",
      requester: "agent",
      intent: "inspect a file",
      target: {},
      requestedActions: [
        { kind: "read_file", description: "read", params: { tool: "read_file", arguments: { path: join(root, "a.txt") } } }
      ],
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
    const claimed = store.claimNextApprovedWorkItem(WORKER_ID, {
      attemptAuthority: {
        planHash: plan.planHash,
        admissionId: admission.admissionId,
        policyVersion: admission.policyVersion,
        policyDecisionHash: admission.policyDecisionHash
      }
    });
    if (!claimed) throw new Error("expected a claimed work item");
    return { workItem, claimed, root };
  } finally {
    store.close();
  }
}

function issuerConfig(dbPath: string, privateKeyDer: Buffer): DesktopCommanderCapabilityIssuerConfig {
  return {
    allowedRoots: directories.filter((d) => d.includes("gateway-dc-root-")),
    deniedRoots: [],
    capability: {
      runtimeId: "runtime_1",
      runtimeIdentityConfigFingerprint: IDENTITY_FINGERPRINT,
      runtimeScopes: ["fs.read"],
      keyId: "test-key-1",
      privateKey: privateKeyDer.toString("base64url"),
      databasePath: dbPath
    }
  };
}

async function bootstrapRuntime(dbPath: string, scopes: string[] = ["fs.read"]) {
  const { SqliteDesktopCommanderRuntimeRegistry } = await import("@agent-control-stack/desktop-commander-adapter");
  const registry = new SqliteDesktopCommanderRuntimeRegistry(dbPath);
  const bootstrap = registry.issueBootstrap({ runtimeId: "runtime_1", identityConfigFingerprint: IDENTITY_FINGERPRINT, scopes });
  registry.completeBootstrap(bootstrap);
  registry.close();
}

describe("POST /work-items/:id/desktop-commander/capability", () => {
  it("fails closed for anonymous, wrong-scope, and non-worker credentials", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-gateway-dc-auth-"));
    directories.push(directory);
    const dbPath = join(directory, "control.db");
    const { workItem, claimed, root } = seedClaim(dbPath);
    directories.push(root);
    const pair = generateKeyPairSync("ed25519");
    await bootstrapRuntime(dbPath);
    const app = buildGateway({
      dbPath,
      logger: false,
      auth: bridgeAuth,
      desktopCommanderCapabilityIssuer: issuerConfig(dbPath, pair.privateKey.export({ format: "der", type: "pkcs8" }))
    });
    try {
      const anonymous = await app.inject({
        method: "POST",
        url: `/work-items/${workItem.id}/desktop-commander/capability`,
        payload: { attemptId: claimed.attemptId }
      });
      const wrongToken = await app.inject({
        method: "POST",
        url: `/work-items/${workItem.id}/desktop-commander/capability`,
        headers: { authorization: "Bearer nonsense" },
        payload: { attemptId: claimed.attemptId }
      });
      const insufficientScope = await app.inject({
        method: "POST",
        url: `/work-items/${workItem.id}/desktop-commander/capability`,
        headers: { authorization: "Bearer worker-only-token" },
        payload: { attemptId: claimed.attemptId }
      });
      const operatorCredential = await app.inject({
        method: "POST",
        url: `/work-items/${workItem.id}/desktop-commander/capability`,
        headers: { authorization: "Bearer operator-token" },
        payload: { attemptId: claimed.attemptId }
      });

      expect(anonymous.statusCode).toBe(401);
      expect(wrongToken.statusCode).toBe(401);
      expect(insufficientScope.statusCode).toBe(403);
      expect(insufficientScope.json().code).toBe("insufficient_desktop_commander_issuer_authority");
      expect(operatorCredential.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("rejects malformed requests and client-injected meta/capability/tool fields (strict schema)", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-gateway-dc-malformed-"));
    directories.push(directory);
    const dbPath = join(directory, "control.db");
    const { workItem, claimed, root } = seedClaim(dbPath);
    directories.push(root);
    const pair = generateKeyPairSync("ed25519");
    await bootstrapRuntime(dbPath);
    const app = buildGateway({
      dbPath,
      logger: false,
      auth: bridgeAuth,
      desktopCommanderCapabilityIssuer: issuerConfig(dbPath, pair.privateKey.export({ format: "der", type: "pkcs8" }))
    });
    try {
      const missingAttempt = await app.inject({
        method: "POST",
        url: `/work-items/${workItem.id}/desktop-commander/capability`,
        headers: { authorization: "Bearer bridge-token" },
        payload: {}
      });
      const injectedMeta = await app.inject({
        method: "POST",
        url: `/work-items/${workItem.id}/desktop-commander/capability`,
        headers: { authorization: "Bearer bridge-token" },
        payload: {
          attemptId: claimed.attemptId,
          toolName: "start_process",
          arguments: { command: "rm -rf /" },
          runtimeId: "attacker-runtime",
          capability: { payload: {}, signature: "x", keyId: "y" },
          _meta: { acsCapability: { payload: {}, signature: "x", keyId: "y" } }
        }
      });
      const wrongType = await app.inject({
        method: "POST",
        url: `/work-items/${workItem.id}/desktop-commander/capability`,
        headers: { authorization: "Bearer bridge-token" },
        payload: { attemptId: 12345 }
      });

      expect(missingAttempt.statusCode).toBe(400);
      expect(injectedMeta.statusCode).toBe(400);
      expect(wrongType.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("issues a valid capability for an authorized, managed invocation and rejects a replay", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-gateway-dc-issue-"));
    directories.push(directory);
    const dbPath = join(directory, "control.db");
    const { workItem, claimed, root } = seedClaim(dbPath);
    directories.push(root);
    const pair = generateKeyPairSync("ed25519");
    await bootstrapRuntime(dbPath);
    const app = buildGateway({
      dbPath,
      logger: false,
      auth: bridgeAuth,
      desktopCommanderCapabilityIssuer: issuerConfig(dbPath, pair.privateKey.export({ format: "der", type: "pkcs8" }))
    });
    try {
      const issued = await app.inject({
        method: "POST",
        url: `/work-items/${workItem.id}/desktop-commander/capability`,
        headers: { authorization: "Bearer bridge-token" },
        payload: { attemptId: claimed.attemptId }
      });
      expect(issued.statusCode).toBe(201);
      const body = issued.json();
      expect(body.capability.payload.toolName).toBe("read_file");
      expect(body.capability.payload.workItemId).toBe(workItem.id);
      expect(
        verify(
          null,
          Buffer.from(strictCanonicalJsonV1(body.capability.payload), "utf8"),
          pair.publicKey,
          Buffer.from(body.capability.signature, "base64url")
        )
      ).toBe(true);
      // Private key material never appears anywhere in the response.
      expect(issued.body).not.toContain(pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"));

      const replay = await app.inject({
        method: "POST",
        url: `/work-items/${workItem.id}/desktop-commander/capability`,
        headers: { authorization: "Bearer bridge-token" },
        payload: { attemptId: claimed.attemptId }
      });
      expect(replay.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });

  it("returns 503 when the issuer is not configured, rather than a policy bypass", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-gateway-dc-unconfigured-"));
    directories.push(directory);
    const dbPath = join(directory, "control.db");
    const { workItem, claimed, root } = seedClaim(dbPath);
    directories.push(root);
    const app = buildGateway({ dbPath, logger: false, auth: bridgeAuth, desktopCommanderCapabilityIssuer: false });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/work-items/${workItem.id}/desktop-commander/capability`,
        headers: { authorization: "Bearer bridge-token" },
        payload: { attemptId: claimed.attemptId }
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().code).toBe("desktop_commander_issuer_unconfigured");

      const keyResponse = await app.inject({
        method: "GET",
        url: "/desktop-commander/capability-key",
        headers: { authorization: "Bearer bridge-token" }
      });
      expect(keyResponse.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });
});

describe("GET /desktop-commander/capability-key", () => {
  it("publishes only the key id and public key, never private material, and requires read access", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-gateway-dc-key-"));
    directories.push(directory);
    const dbPath = join(directory, "control.db");
    seedClaim(dbPath);
    const pair = generateKeyPairSync("ed25519");
    const privateKeyDer = pair.privateKey.export({ format: "der", type: "pkcs8" });
    await bootstrapRuntime(dbPath);
    const app = buildGateway({
      dbPath,
      logger: false,
      auth: bridgeAuth,
      desktopCommanderCapabilityIssuer: issuerConfig(dbPath, privateKeyDer)
    });
    try {
      const unauthenticated = await app.inject({ method: "GET", url: "/desktop-commander/capability-key" });
      expect(unauthenticated.statusCode).toBe(401);

      const response = await app.inject({
        method: "GET",
        url: "/desktop-commander/capability-key",
        headers: { authorization: "Bearer bridge-token" }
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.keyId).toBe("test-key-1");
      expect(body.publicKey).toBe(pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url"));
      expect(response.body).not.toContain(privateKeyDer.toString("base64url"));
    } finally {
      await app.close();
    }
  });
});
