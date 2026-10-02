/**
 * Shared harness for the root ACS <-> Desktop Commander execution-chain E2E
 * tests (ADR 0019). Every component is the real implementation from this
 * repository, started on loopback:
 *
 *   ACS gateway            apps/gateway (buildGateway, in-process, real SQLite)
 *   OAuth/ACS edge         apps/dc-mcp-gateway/server.js   (child process)
 *   stdio multiplexer      apps/dc-mcp-gateway/bridge.js   (child process)
 *   Desktop Commander      vendor/desktop-commander/dist/index.js (managed child)
 *
 * The tests need the Desktop Commander build (`npm ci && npm run build` in
 * vendor/desktop-commander) and run only when ACS_DC_E2E=1; with the flag set,
 * a missing build is a failure, never a silent skip.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FastifyInstance } from "fastify";
import {
  ExecutionAdmissionScheduler,
  type ExecutionAdmissionController
} from "@agent-control-stack/execution-admission";
import { buildGateway, type GatewayCredential } from "../../../apps/gateway/src/server.js";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const DC_ROOT = join(REPO_ROOT, "vendor/desktop-commander");
export const DC_ENTRY = join(DC_ROOT, "dist/index.js");
export const GATEWAY_ROOT = join(REPO_ROOT, "apps/dc-mcp-gateway");
export const E2E_ENABLED = process.env.ACS_DC_E2E === "1";

export function requireDesktopCommanderBuild(): void {
  if (!existsSync(DC_ENTRY)) {
    throw new Error(
      `ACS_DC_E2E=1 but ${DC_ENTRY} is missing; run \`npm ci && npm run build\` in vendor/desktop-commander`
    );
  }
}

export const RUNTIME_SCOPES = ["fs.read", "fs.write", "process.exec", "process.spawn"] as const;
export const KEY_ID = "e2e-capability-key";
const OPERATOR_TOKEN = "e2e-operator-token";
const SERVICE_TOKEN = "e2e-dc-gateway-service-token";

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

export function sandbox(prefix: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const dirs = {
    root,
    workspace: join(root, "workspace"),
    dcState: join(root, "dc-state"),
    lockDir: join(root, "dc-lock"),
    home: join(root, "home"),
    gatewayData: join(root, "gateway-data")
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { ...dirs, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export type Sandbox = ReturnType<typeof sandbox>;

/** Create (or read) Desktop Commander's persisted runtime identity exactly as DC does. */
export async function desktopCommanderRuntimeId(box: Sandbox): Promise<string> {
  const module = (await import(pathToFileURL(join(DC_ROOT, "dist/runtime-identity.js")).href)) as {
    getRuntimeIdentityState(options: {
      stateDirectory: string;
      homeDirectory: string;
    }): Promise<{ runtime_id: string }>;
  };
  const state = await module.getRuntimeIdentityState({ stateDirectory: box.dcState, homeDirectory: box.home });
  return state.runtime_id;
}

export function signingKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64url")
  };
}

export interface AcsHandle {
  url: string;
  app: FastifyInstance;
  keys: ReturnType<typeof signingKeys>;
  serviceToken: string;
  runtimeId: string;
  fingerprint: string;
  approve(workItemId: string, actionHash: string): Promise<number>;
  workItem(workItemId: string): Promise<{ workItem: { status: string }; events: Array<{ name: string }> }>;
  issue(tool: string, args: Record<string, unknown>): Promise<{ status: number; body: any }>;
  bootstrap(): Promise<{ status: number; body: any }>;
  completeBootstrap(challenge: string, runtimeIdentity: unknown): Promise<number>;
  close(): Promise<void>;
}

/**
 * Admission controller for suites that mint capabilities straight from ACS and
 * deliver them to a runtime with no bridge in between. Those flows never submit
 * canonical terminal results to ACS, so no result callback ever releases a
 * permit; keep that enforcement-only characteristic from tying up
 * production-sized limits for the whole lease.
 */
export function directCapabilityAdmission(): ExecutionAdmissionController {
  return new ExecutionAdmissionScheduler({
    config: {
      executionMaxInflight: 64,
      executorMaxInflight: 64,
      queueMax: 64,
      queueTimeoutMs: 30_000,
      waitMaxInflight: 16
    }
  });
}

/** The real ACS gateway with DC capability signing, bound to this sandbox's DC runtime. */
export async function startAcs(
  box: Sandbox,
  runtimeId: string,
  options: {
    ttlMs?: number;
    executionAdmission?: ExecutionAdmissionController;
    additionalCredentials?: GatewayCredential[];
    /** Test-only lifecycle hook for deterministic result-delivery barriers. */
    beforeListen?: (app: FastifyInstance) => void;
  } = {}
): Promise<AcsHandle> {
  const keys = signingKeys();
  const fingerprint = createHash("sha256").update(readFileSync(DC_ENTRY)).digest("hex");
  const credentials: GatewayCredential[] = [
    ...(options.additionalCredentials ?? []),
    {
      id: "operator",
      token: OPERATOR_TOKEN,
      actor: "user",
      actorId: "e2e-operator",
      roles: ["operator"],
      scopes: ["acs:read", "acs:write", "acs:approve"]
    },
    {
      id: "dc-gateway",
      token: SERVICE_TOKEN,
      actor: "agent",
      actorId: "acs-dc-bridge",
      roles: ["service", "worker"],
      scopes: ["acs:read", "acs:write", "acs:worker"]
    }
  ];
  const app = buildGateway({
    dbPath: join(box.root, "acs.db"),
    logger: false,
    auth: { token: "", actor: "user", actorId: "e2e-operator", credentials },
    desktopCommanderCapability: {
      runtimeId,
      keyId: KEY_ID,
      privateKey: keys.privateKey,
      ttlMs: options.ttlMs ?? 29_000,
      identityConfigFingerprint: fingerprint,
      runtimeScopes: [...RUNTIME_SCOPES]
    },
    desktopCommanderContainment: { allowedRoots: [box.workspace], deniedRoots: [] },
    ...(options.executionAdmission ? { executionAdmission: options.executionAdmission } : {})
  });
  options.beforeListen?.(app);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const post = async (path: string, token: string, payload: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      body: JSON.stringify(payload)
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return {
    url,
    app,
    keys,
    serviceToken: SERVICE_TOKEN,
    runtimeId,
    fingerprint,
    approve: async (workItemId, actionHash) =>
      (await post(`/work-items/${workItemId}/approve`, OPERATOR_TOKEN, { actionHash, reason: "e2e operator approval" }))
        .status,
    workItem: async (workItemId) => {
      const response = await fetch(`${url}/work-items/${workItemId}`, {
        headers: { authorization: `Bearer ${OPERATOR_TOKEN}` }
      });
      return (await response.json()) as any;
    },
    issue: (tool, args) =>
      post(
        "/dc/capability/issue",
        SERVICE_TOKEN,
        { client_id: "e2e-client", tool, argsSummary: JSON.stringify(args) },
        { "x-dc-actor": "chatgpt:e2e-user" }
      ),
    bootstrap: () =>
      post("/dc/runtime/bootstrap", SERVICE_TOKEN, {
        runtimeId,
        identityConfigFingerprint: fingerprint,
        scopes: [...RUNTIME_SCOPES]
      }),
    completeBootstrap: async (challenge, runtimeIdentity) =>
      (
        await post("/dc/runtime/bootstrap/complete", SERVICE_TOKEN, {
          runtimeId,
          identityConfigFingerprint: fingerprint,
          scopes: [...RUNTIME_SCOPES],
          challenge,
          runtimeIdentity
        })
      ).status,
    close: () => app.close()
  };
}

export interface ServiceProcess {
  child: ChildProcess;
  port: number;
  output(): string;
  stop(): Promise<void>;
}

export function startNodeService(
  script: string,
  env: Record<string, string>,
  port: number,
  readyPath: string
): Promise<ServiceProcess> {
  const child = spawn(process.execPath, [script], {
    cwd: GATEWAY_ROOT,
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout?.on("data", (chunk) => (output += chunk));
  child.stderr?.on("data", (chunk) => (output += chunk));
  const handle: ServiceProcess = {
    child,
    port,
    output: () => output,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(3_000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  };
  return (async () => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`${script} exited early:\n${output}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}${readyPath}`);
        if (response.status < 500) return handle;
      } catch {
        // not listening yet
      }
      await sleep(100);
    }
    await handle.stop();
    throw new Error(`${script} did not become ready:\n${output}`);
  })();
}

export const EXECUTION_TOKEN = "e2e-gateway-execution-token-0123456789";
export const OAUTH_SIGNING_KEY = "e2e-oauth-signing-key-".padEnd(64, "0");

/** bridge.js in ACS managed mode, spawning the real managed Desktop Commander. */
export async function startBridge(box: Sandbox, acs: AcsHandle): Promise<ServiceProcess> {
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
      ACS_DC_PUBLIC_KEY: acs.keys.publicKey,
      ACS_DC_KEY_ID: KEY_ID,
      ACS_DC_RUNTIME_SCOPES: RUNTIME_SCOPES.join(","),
      DESKTOP_COMMANDER_STATE_DIR: box.dcState,
      DESKTOP_COMMANDER_EXECUTOR_LOCK_DIR: box.lockDir,
      DC_GATEWAY_EXECUTION_TOKEN: EXECUTION_TOKEN,
      ACS_GATEWAY_URL: acs.url,
      ACS_WORKER_TOKEN: acs.serviceToken,
      DESKTOP_COMMANDER_DISABLE_TELEMETRY: "1"
    },
    port,
    "/healthz"
  );
}

/** server.js: the OAuth edge with ACS managed mode and native runtime bootstrap. */
export async function startEdge(
  box: Sandbox,
  acs: AcsHandle,
  bridge: ServiceProcess
): Promise<ServiceProcess & { origin: string }> {
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
      UPSTREAM: `http://127.0.0.1:${bridge.port}`,
      GATEWAY_EXECUTION_TOKEN: EXECUTION_TOKEN,
      ACS_MANAGED_MODE: "1",
      ACS_GATEWAY_URL: acs.url,
      ACS_GATEWAY_TOKEN: acs.serviceToken,
      ACS_NATIVE_RUNTIME_BOOTSTRAP: "1",
      ACS_DC_ENTRYPOINT: DC_ENTRY,
      ACS_DC_RUNTIME_SCOPES: RUNTIME_SCOPES.join(","),
      DESKTOP_COMMANDER_STATE_DIR: box.dcState
    },
    port,
    "/.well-known/oauth-protected-resource"
  );
  return { ...service, origin };
}

/** An access token exactly as the edge's own authorization server mints them (HS256). */
export function accessToken(origin: string, sub = "e2e-user", clientId = "e2e-client"): string {
  const now = Math.floor(Date.now() / 1000);
  const b64u = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = b64u({ alg: "HS256", typ: "JWT" });
  const payload = b64u({
    iss: origin,
    sub,
    client_id: clientId,
    aud: `${origin}/mcp`,
    scope: "mcp",
    iat: now,
    exp: now + 600,
    jti: randomBytes(12).toString("base64url")
  });
  const signature = createHmac("sha256", OAUTH_SIGNING_KEY).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

export interface McpResponse {
  status: number;
  body: any;
}

/** Minimal Streamable-HTTP MCP client (JSON or SSE responses). */
export class McpHttpClient {
  private sessionId: string | undefined;
  private nextId = 1;

  constructor(
    private readonly url: string,
    private readonly headers: () => Record<string, string>
  ) {}

  get session(): string | undefined {
    return this.sessionId;
  }

  async post(message: Record<string, unknown>): Promise<McpResponse> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
        ...this.headers()
      },
      body: JSON.stringify(message)
    });
    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    const text = await response.text();
    return { status: response.status, body: parseMcpBody(text) };
  }

  async initialize(): Promise<McpResponse> {
    const response = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "acs-dc-e2e", version: "1.0.0" } }
    });
    if (response.status === 200) await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    return response;
  }

  call(name: string, args: Record<string, unknown>, meta?: Record<string, unknown>): Promise<McpResponse> {
    return this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) }
    });
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    await fetch(this.url, {
      method: "DELETE",
      headers: { "mcp-session-id": this.sessionId, ...this.headers() }
    }).catch(() => undefined);
    this.sessionId = undefined;
  }
}

export function parseMcpBody(text: string): any {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const events = trimmed
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5).trim()));
  return events.find((event) => event && (event.result !== undefined || event.error !== undefined)) ?? events.at(-1);
}

/** Read the bridge's executor lease: which DC child pid currently holds authority. */
export function executorPid(box: Sandbox): number | undefined {
  try {
    const lease = JSON.parse(readFileSync(join(box.lockDir, "executor.lock"), "utf8")) as { pid?: number };
    return typeof lease.pid === "number" ? lease.pid : undefined;
  } catch {
    return undefined;
  }
}

export async function waitFor<T>(probe: () => Promise<T | undefined> | T | undefined, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined && value !== null && value !== false) return value;
    await sleep(100);
  }
  throw new Error("condition not met in time");
}

/**
 * A Desktop Commander child driven directly over stdio - i.e. with NO gateway
 * in front. Used to prove DC's own enforcement holds when the transport is
 * buggy or compromised (ADR 0019 invariant 7).
 */
export class DesktopCommanderStdio {
  readonly child: ChildProcess;
  private buffer = "";
  private stderr = "";
  private nextId = 1;
  private readonly pending = new Map<number, (message: any) => void>();

  constructor(box: Sandbox, publicKey: string) {
    this.child = spawn(process.execPath, [DC_ENTRY, "--no-onboarding"], {
      cwd: box.workspace,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: box.home,
        DESKTOP_COMMANDER_DISABLE_TELEMETRY: "1",
        DESKTOP_COMMANDER_STATE_DIR: box.dcState,
        DESKTOP_COMMANDER_EXECUTOR_LOCK_DIR: box.lockDir,
        DESKTOP_COMMANDER_ACS_PUBLIC_KEY: publicKey,
        DESKTOP_COMMANDER_ACS_KEY_ID: KEY_ID,
        DESKTOP_COMMANDER_ACS_SCOPES: RUNTIME_SCOPES.join(",")
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => (this.stderr += chunk));
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf("\n");
      while (newline !== -1) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line) {
          const message = JSON.parse(line);
          this.pending.get(message.id)?.(message);
          this.pending.delete(message.id);
        }
        newline = this.buffer.indexOf("\n");
      }
    });
  }

  request(method: string, params: Record<string, unknown>): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}; stderr=${this.stderr}`));
      }, 15_000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async initialize(meta?: Record<string, unknown>): Promise<any> {
    const response = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "acs-dc-e2e-direct", version: "1.0.0" },
      ...(meta ? { _meta: meta } : {})
    });
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    return response;
  }

  /** Deliver a tools/call exactly as a (possibly compromised) transport would. */
  call(name: string, args: Record<string, unknown>, meta?: Record<string, unknown>): Promise<any> {
    return this.request("tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
  }

  async close(): Promise<void> {
    this.child.stdin?.end();
    await Promise.race([new Promise((resolve) => this.child.once("exit", resolve)), sleep(3_000)]);
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
  }
}

/** Attest a directly driven DC child with ACS, exactly as the edge does. */
export async function attestDirect(acs: AcsHandle, dc: DesktopCommanderStdio): Promise<void> {
  const bootstrap = await acs.bootstrap();
  if (bootstrap.status !== 201) throw new Error(`ACS bootstrap failed: ${JSON.stringify(bootstrap)}`);
  const initialized = await dc.initialize({
    acsRuntimeBootstrap: {
      schemaVersion: 1,
      runtimeId: acs.runtimeId,
      challenge: bootstrap.body.challenge,
      scopes: bootstrap.body.scopes
    }
  });
  const proof = initialized.result?._meta?.acsRuntimeIdentity;
  if (!proof) throw new Error(`DC did not return a runtime identity proof: ${JSON.stringify(initialized)}`);
  const completed = await acs.completeBootstrap(bootstrap.body.challenge, proof);
  if (completed !== 204) throw new Error(`ACS bootstrap completion failed: ${completed}`);
}

/** The DC-side rejection code from a tools/call result, if any. */
export function dcRejection(response: any): string | undefined {
  return response?.result?._meta?.acsAuthorization?.decision === "denied"
    ? response.result._meta.acsAuthorization.code
    : undefined;
}

export interface BridgeAuthority {
  bridge: { hasUpstreamPair: boolean; initialized: boolean; spawnCount: number; sessionCount: number };
}

/** Non-secret bridge introspection (spawn count, live downstream sessions). */
export async function bridgeAuthority(bridge: ServiceProcess): Promise<BridgeAuthority> {
  const response = await fetch(`http://127.0.0.1:${bridge.port}/authority`);
  return (await response.json()) as BridgeAuthority;
}

/** Count of managed initializes the edge completed (each one is an ACS-attested session attach). */
export function attestedInitializes(edge: ServiceProcess): number {
  return (edge.output().match(/initialize attested \+ proxied/gu) ?? []).length;
}
