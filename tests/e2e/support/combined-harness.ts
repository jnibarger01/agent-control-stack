/**
 * Combined harness: ONE ACS gateway governing BOTH Desktop Commander and
 * Jace Commander runtimes, one shared edge serving /mcp and /jc/mcp, and
 * the mission runner configured with both runtimes. Used by the mixed
 * full-system acceptance test.
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { ExecutionAdmissionController } from "@agent-control-stack/execution-admission";
import { buildGateway, type GatewayCredential } from "../../../apps/gateway/src/server.js";
import {
  DC_ENTRY,
  EXECUTION_TOKEN,
  KEY_ID,
  OAUTH_SIGNING_KEY,
  RUNTIME_SCOPES,
  freePort,
  signingKeys,
  startNodeService,
  type Sandbox,
  type ServiceProcess
} from "./chain-harness.js";
import { JC_KEY_ID, JC_RUNTIME_ID } from "./jc-harness.js";

export const COMBINED_DC_SERVICE_TOKEN = "e2e-combined-dc-service-token";
export const COMBINED_JC_BRIDGE_TOKEN = "e2e-combined-jc-bridge-token";
export const COMBINED_OPERATOR_TOKEN = "e2e-combined-operator-token";
export const COMBINED_PLANNER_TOKEN = "e2e-combined-planner-token";
export const COMBINED_REVIEWER_TOKEN = "e2e-combined-independent-reviewer-token";
export const COMBINED_DB = "acs.db";

export interface CombinedAcsHandle {
  url: string;
  app: FastifyInstance;
  /** DC signing pair (ed25519, DER base64url). */
  dcKeys: ReturnType<typeof signingKeys>;
  /** JC signing pair. */
  jcPair: { privateKey: string; publicKey: string };
  dcRuntimeId: string;
  jcPublicKey: string;
  workItem(workItemId: string): Promise<{ workItem: { status: string }; events: Array<{ name: string }> }>;
  close(): Promise<void>;
}

export async function startCombinedAcs(
  box: Sandbox,
  dcRuntimeId: string,
  options: {
    ttlMs?: number;
    executionAdmission?: ExecutionAdmissionController;
    additionalCredentials?: GatewayCredential[];
  } = {}
): Promise<CombinedAcsHandle> {
  const dcKeys = signingKeys();
  const jcPair = generateKeyPairSync("ed25519");
  const jcPrivateKey = jcPair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url");
  const jcPublicKey = jcPair.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const fingerprint = createHash("sha256").update(readFileSync(DC_ENTRY)).digest("hex");
  const credentials: GatewayCredential[] = [
    ...(options.additionalCredentials ?? []),
    {
      id: "operator",
      token: COMBINED_OPERATOR_TOKEN,
      actor: "user",
      actorId: "e2e-operator",
      roles: ["operator"],
      scopes: ["acs:read", "acs:write", "acs:approve"]
    },
    {
      id: "dc-gateway",
      token: COMBINED_DC_SERVICE_TOKEN,
      actor: "agent",
      actorId: "acs-dc-bridge",
      roles: ["service", "worker"],
      scopes: ["acs:read", "acs:write", "acs:worker"]
    },
    {
      id: "jc-bridge",
      token: COMBINED_JC_BRIDGE_TOKEN,
      actor: "agent",
      actorId: "acs-jc-bridge",
      roles: ["service", "worker"],
      scopes: ["acs:read", "acs:write", "acs:worker"]
    },
    {
      id: "planner",
      token: COMBINED_PLANNER_TOKEN,
      actor: "agent",
      actorId: "chatgpt:jacen",
      roles: ["service"],
      scopes: ["acs:read", "acs:write"]
    }
  ];
  const app = buildGateway({
    dbPath: join(box.root, COMBINED_DB),
    logger: false,
    auth: { token: "", actor: "user", actorId: "e2e-operator", credentials },
    desktopCommanderCapability: {
      runtimeId: dcRuntimeId,
      keyId: KEY_ID,
      privateKey: dcKeys.privateKey,
      ttlMs: options.ttlMs ?? 29_000,
      identityConfigFingerprint: fingerprint,
      runtimeScopes: [...RUNTIME_SCOPES]
    },
    desktopCommanderContainment: { allowedRoots: [box.workspace], deniedRoots: [] },
    jaceCommanderCapability: { runtimeId: JC_RUNTIME_ID, keyId: JC_KEY_ID, privateKey: jcPrivateKey, ttlMs: 29_000 },
    jaceCommanderContainment: { allowedRoots: [box.workspace], deniedRoots: [] },
    ...(options.executionAdmission ? { executionAdmission: options.executionAdmission } : {})
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return {
    url,
    app,
    dcKeys,
    jcPair: { privateKey: jcPrivateKey, publicKey: jcPublicKey },
    dcRuntimeId,
    jcPublicKey,
    workItem: async (workItemId) => {
      const response = await fetch(`${url}/work-items/${workItemId}`, {
        headers: { authorization: `Bearer ${COMBINED_OPERATOR_TOKEN}` }
      });
      return (await response.json()) as any;
    },
    close: () => app.close()
  };
}

/** DC bridge with the combined DC service token. */
export async function startCombinedDcBridge(box: Sandbox, acs: CombinedAcsHandle): Promise<ServiceProcess> {
  const port = await freePort();
  return startNodeService(
    "bridge.js",
    {
      HOME: box.home,
      BRIDGE_PORT: String(port),
      ACS_MANAGED_MODE: "1",
      DC_CMD: process.execPath,
      DC_ARGS: `${DC_ENTRY} --no-onboarding`,
      DC_CWD: box.workspace,
      ACS_DC_PUBLIC_KEY: acs.dcKeys.publicKey,
      ACS_DC_KEY_ID: KEY_ID,
      ACS_DC_RUNTIME_SCOPES: RUNTIME_SCOPES.join(","),
      DESKTOP_COMMANDER_STATE_DIR: box.dcState,
      DESKTOP_COMMANDER_EXECUTOR_LOCK_DIR: box.lockDir,
      DC_GATEWAY_EXECUTION_TOKEN: EXECUTION_TOKEN,
      ACS_GATEWAY_URL: acs.url,
      ACS_WORKER_TOKEN: COMBINED_DC_SERVICE_TOKEN,
      DESKTOP_COMMANDER_DISABLE_TELEMETRY: "1"
    },
    port,
    "/ready"
  );
}

/** JC bridge with the combined JC bridge token. */
export async function startCombinedJcBridge(box: Sandbox, acs: CombinedAcsHandle): Promise<ServiceProcess> {
  const port = await freePort();
  return startNodeService(
    "bridge.js",
    {
      HOME: box.home,
      BRIDGE_PORT: String(port),
      BRIDGE_PROFILE: "jace-commander",
      ACS_MANAGED_MODE: "1",
      DC_CMD: process.execPath,
      JC_ACS_PUBLIC_KEY: acs.jcPublicKey,
      JC_ACS_KEY_ID: JC_KEY_ID,
      JC_RUNTIME_ID,
      JC_STATE_DIR: join(box.home, ".jace-commander"),
      JC_ACS_URL: acs.url,
      JC_TRACE_ROOTS: join(box.root, "traces"),
      JC_MISSION_ROUTER_DIR: join(box.root, "mission-router"),
      JC_FS_ROOTS: box.workspace,
      DC_GATEWAY_EXECUTION_TOKEN: EXECUTION_TOKEN,
      ACS_GATEWAY_URL: acs.url,
      ACS_WORKER_TOKEN: COMBINED_JC_BRIDGE_TOKEN
    },
    port,
    "/healthz"
  );
}

/** One edge serving both /mcp (DC) and /jc/mcp (JC) against the combined gateway. */
export async function startCombinedEdge(
  box: Sandbox,
  acs: CombinedAcsHandle,
  dcBridge: ServiceProcess,
  jcBridge: ServiceProcess
): Promise<ServiceProcess & { origin: string; jcUrl: string }> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const service = await startNodeService(
    "server.js",
    {
      HOME: box.home,
      GATEWAY_PORT: String(port),
      PUBLIC_ORIGIN: origin,
      CONSENT_PASSPHRASE: "e2e-consent",
      SIGNING_KEY: OAUTH_SIGNING_KEY,
      DATA_DIR: box.gatewayData,
      UPSTREAM: `http://127.0.0.1:${dcBridge.port}`,
      JC_ENABLED: "1",
      JC_UPSTREAM: `http://127.0.0.1:${jcBridge.port}`,
      GATEWAY_EXECUTION_TOKEN: EXECUTION_TOKEN,
      ACS_MANAGED_MODE: "1",
      ACS_GATEWAY_URL: acs.url,
      ACS_GATEWAY_TOKEN: COMBINED_DC_SERVICE_TOKEN,
      ACS_JC_GATEWAY_TOKEN: COMBINED_JC_BRIDGE_TOKEN,
      ACS_NATIVE_RUNTIME_BOOTSTRAP: "1",
      ACS_DC_ENTRYPOINT: DC_ENTRY,
      ACS_DC_RUNTIME_SCOPES: RUNTIME_SCOPES.join(","),
      DESKTOP_COMMANDER_STATE_DIR: box.dcState
    },
    port,
    "/.well-known/oauth-protected-resource"
  );
  return { ...service, origin, jcUrl: `${origin}/jc/mcp` };
}
