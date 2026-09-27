/**
 * Harness for the Jace Commander (/jc/mcp) execution-chain E2E tests. Every
 * component is the real implementation from this repository:
 *
 *   ACS gateway          apps/gateway (buildGateway, in-process, real SQLite, acs.jc.v1 signing)
 *   OAuth/ACS edge       apps/dc-mcp-gateway/server.js  (JC_ENABLED=1)
 *   jc stdio bridge      apps/dc-mcp-gateway/bridge.js  (BRIDGE_PROFILE=jace-commander)
 *   Jace Commander       vendor/desktop-commander/dist/jace-commander/cli.js serve
 *   jace-commander CLI   vendor/desktop-commander/dist/jace-commander/cli.js (MCP client of /jc/mcp)
 */
import { spawn } from "node:child_process";
import { createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildGateway, type GatewayCredential } from "../../../apps/gateway/src/server.js";
import {
  DC_ROOT,
  EXECUTION_TOKEN,
  OAUTH_SIGNING_KEY,
  freePort,
  startNodeService,
  type Sandbox,
  type ServiceProcess
} from "./chain-harness.js";

export const JC_CLI = join(DC_ROOT, "dist/jace-commander/cli.js");
export const JC_RUNTIME_ID = "jc-e2e-runtime";
const JC_KEY_ID = "e2e-jc-key";
const OPERATOR_TOKEN = "e2e-jc-operator-token";
const JC_BRIDGE_TOKEN = "e2e-jc-bridge-token";
const DC_BRIDGE_TOKEN = "e2e-jc-unused-dc-bridge-token";

export function requireJaceCommanderBuild(): void {
  if (!existsSync(JC_CLI)) {
    throw new Error(`ACS_DC_E2E=1 but ${JC_CLI} is missing; run \`npm run build\` in vendor/desktop-commander`);
  }
}

export interface JcAcsHandle {
  url: string;
  app: FastifyInstance;
  publicKey: string;
  approve(workItemId: string, actionHash: string): Promise<number>;
  close(): Promise<void>;
}

/** The real ACS gateway with acs.jc.v1 signing and filesystem containment to `allowedRoots`. */
export async function startJcAcs(box: Sandbox, allowedRoots: string[]): Promise<JcAcsHandle> {
  const pair = generateKeyPairSync("ed25519");
  const privateKey = pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url");
  const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const credentials: GatewayCredential[] = [
    {
      id: "operator",
      token: OPERATOR_TOKEN,
      actor: "user",
      actorId: "e2e-operator",
      roles: ["operator"],
      scopes: ["acs:read", "acs:write", "acs:approve"]
    },
    {
      id: "jc-bridge",
      token: JC_BRIDGE_TOKEN,
      actor: "agent",
      actorId: "acs-jc-bridge",
      roles: ["service", "worker"],
      scopes: ["acs:read", "acs:write", "acs:worker"]
    },
    {
      id: "dc-bridge",
      token: DC_BRIDGE_TOKEN,
      actor: "agent",
      actorId: "acs-dc-bridge",
      roles: ["service", "worker"],
      scopes: ["acs:read", "acs:write", "acs:worker"]
    }
  ];
  const app = buildGateway({
    dbPath: join(box.root, "acs-jc.db"),
    logger: false,
    auth: { token: "", actor: "user", actorId: "e2e-operator", credentials },
    jaceCommanderCapability: { runtimeId: JC_RUNTIME_ID, keyId: JC_KEY_ID, privateKey, ttlMs: 29_000 },
    jaceCommanderContainment: { allowedRoots, deniedRoots: [] }
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return {
    url,
    app,
    publicKey,
    approve: async (workItemId, actionHash) =>
      (
        await fetch(`${url}/work-items/${workItemId}/approve`, {
          method: "POST",
          headers: { authorization: `Bearer ${OPERATOR_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ actionHash, reason: "e2e operator approval" })
        })
      ).status,
    close: () => app.close()
  };
}

/** bridge.js in the jace-commander profile, spawning the real `jace-commander serve`. */
export async function startJcBridge(
  box: Sandbox,
  acs: JcAcsHandle,
  fsRoots: string[],
  options: { jcDir?: string } = {}
): Promise<ServiceProcess> {
  const port = await freePort();
  return startNodeService(
    "bridge.js",
    {
      HOME: box.home,
      BRIDGE_PORT: String(port),
      BRIDGE_PROFILE: "jace-commander",
      ACS_MANAGED_MODE: "1",
      DC_CMD: process.execPath,
      ...(options.jcDir ? { JC_DC_DIR: options.jcDir } : {}),
      JC_ACS_PUBLIC_KEY: acs.publicKey,
      JC_ACS_KEY_ID: JC_KEY_ID,
      JC_RUNTIME_ID,
      JC_STATE_DIR: join(box.home, ".jace-commander"),
      JC_ACS_URL: acs.url,
      JC_TRACE_ROOTS: join(box.root, "traces"),
      JC_MISSION_ROUTER_DIR: join(box.root, "mission-router"),
      JC_FS_ROOTS: fsRoots.join(":"),
      DC_GATEWAY_EXECUTION_TOKEN: EXECUTION_TOKEN
    },
    port,
    "/healthz"
  );
}

/** server.js with the /jc/mcp lane on, wired to the jc bridge and ACS. */
export async function startJcEdge(
  box: Sandbox,
  acs: JcAcsHandle,
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
      // The /mcp (Desktop Commander) lane is not exercised here.
      UPSTREAM: "http://127.0.0.1:9",
      JC_ENABLED: "1",
      JC_UPSTREAM: `http://127.0.0.1:${jcBridge.port}`,
      GATEWAY_EXECUTION_TOKEN: EXECUTION_TOKEN,
      ACS_MANAGED_MODE: "1",
      ACS_GATEWAY_URL: acs.url,
      ACS_GATEWAY_TOKEN: DC_BRIDGE_TOKEN,
      ACS_JC_GATEWAY_TOKEN: JC_BRIDGE_TOKEN
    },
    port,
    "/.well-known/oauth-protected-resource/jc/mcp"
  );
  return { ...service, origin, jcUrl: `${origin}/jc/mcp` };
}

/** A /jc/mcp-audience access token exactly as the edge's authorization server mints them. */
export function jcAccessToken(origin: string, audience = `${origin}/jc/mcp`): string {
  const now = Math.floor(Date.now() / 1000);
  const b64u = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = b64u({ alg: "HS256", typ: "JWT" });
  const payload = b64u({
    iss: origin,
    sub: "jacen",
    client_id: "jc-e2e-cli",
    aud: audience,
    scope: "mcp",
    iat: now,
    exp: now + 600,
    jti: randomBytes(12).toString("base64url")
  });
  const signature = createHmac("sha256", OAUTH_SIGNING_KEY).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
  json(): any;
}

/** Run the real `jace-commander` CLI as a subprocess. */
export function runJc(args: string[], env: Record<string, string>, cwd?: string): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [JC_CLI, ...args], {
      cwd,
      env: { PATH: process.env.PATH ?? "", ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, json: () => JSON.parse(stdout) });
    });
  });
}
