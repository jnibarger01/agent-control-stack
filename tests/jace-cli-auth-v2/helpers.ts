import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  type JsonWebKey,
  type KeyObject
} from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import type { FastifyInstance } from "fastify";
import { buildGateway } from "../../apps/gateway/src/server.js";

export const REPO_ROOT = resolve(process.cwd());
export const DC_GATEWAY_ENTRY = resolve(REPO_ROOT, "apps/dc-mcp-gateway/server.js");
export const JC_CLI_DIST_ENTRY = resolve(REPO_ROOT, "apps/jace-commander/dist/cli.js");
export const JC_CLI_SRC_ENTRY = resolve(REPO_ROOT, "apps/jace-commander/src/cli.ts");

export const DEFAULT_OPERATOR_TOKEN = "operator-token-0123456789abcdef";
export const DEFAULT_OPERATOR_ACTOR_ID = "operator-1";

export function b64u(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function sha256B64u(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("base64url");
}

export function sha256Hex(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

export interface DpopKeyPair {
  alg: "EdDSA" | "ES256";
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicJwk: JsonWebKey;
  privateJwk: JsonWebKey;
  publicKeyPem: string;
  jkt: string;
}

/**
 * RFC 7638 JWK SHA-256 thumbprint for OKP (Ed25519) and EC (P-256) public keys.
 */
export function computeJwkThumbprint(jwk: JsonWebKey): string {
  if (jwk.kty === "OKP" && jwk.crv && jwk.x) {
    const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
    return sha256B64u(canonical);
  }
  if (jwk.kty === "EC" && jwk.crv && jwk.x && jwk.y) {
    const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
    return sha256B64u(canonical);
  }
  throw new Error(`Unsupported JWK for thumbprint: ${String(jwk.kty)}`);
}

export function generateEd25519DpopKey(): DpopKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicJwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
  const privateJwk = privateKey.export({ format: "jwk" }) as JsonWebKey;
  return {
    alg: "EdDSA",
    privateKey,
    publicKey,
    publicJwk,
    privateJwk,
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    jkt: computeJwkThumbprint(publicJwk)
  };
}

export function generateEs256DpopKey(): DpopKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicJwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
  const privateJwk = privateKey.export({ format: "jwk" }) as JsonWebKey;
  return {
    alg: "ES256",
    privateKey,
    publicKey,
    publicJwk,
    privateJwk,
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    jkt: computeJwkThumbprint(publicJwk)
  };
}

export interface DpopProofOptions {
  key: DpopKeyPair;
  htm: string;
  htu: string;
  accessToken?: string;
  ath?: string;
  nonce?: string;
  jti?: string;
  iat?: number;
  typ?: string;
  alg?: string;
  jwkOverride?: Record<string, unknown> | null;
  extraHeader?: Record<string, unknown>;
  extraPayload?: Record<string, unknown>;
}

/**
 * Independent RFC 9449 DPoP compact JWS generator for positive and adversarial tests.
 */
export function signDpopProof(opts: DpopProofOptions): string {
  const alg = opts.alg ?? opts.key.alg;
  const header: Record<string, unknown> = {
    typ: opts.typ ?? "dpop+jwt",
    alg,
    ...(opts.jwkOverride === null ? {} : { jwk: opts.jwkOverride ?? opts.key.publicJwk }),
    ...(opts.extraHeader ?? {})
  };
  const payload: Record<string, unknown> = {
    jti: opts.jti ?? randomBytes(16).toString("base64url"),
    htm: opts.htm,
    htu: opts.htu,
    iat: opts.iat ?? Math.floor(Date.now() / 1000),
    ...(opts.ath !== undefined
      ? { ath: opts.ath }
      : opts.accessToken !== undefined
        ? { ath: sha256B64u(opts.accessToken) }
        : {}),
    ...(opts.nonce !== undefined ? { nonce: opts.nonce } : {}),
    ...(opts.extraPayload ?? {})
  };
  const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  if (alg === "none") {
    return `${signingInput}.`;
  }
  if (alg === "HS256") {
    const hmac = createHash("sha256").update(signingInput).digest("base64url");
    return `${signingInput}.${hmac}`;
  }
  const sig =
    opts.key.alg === "EdDSA"
      ? sign(null, Buffer.from(signingInput, "utf8"), opts.key.privateKey)
      : sign("sha256", Buffer.from(signingInput, "utf8"), {
          key: opts.key.privateKey,
          dsaEncoding: "ieee-p1363"
        });
  return `${signingInput}.${sig.toString("base64url")}`;
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: sha256B64u(verifier) };
}

export function decodeJwtUnverified(token: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
} {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Token is not a 3-part JWT");
  return {
    header: JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>
  };
}

export interface JcGatewayConfig {
  publicOrigin?: string;
  consentPassphrase?: string;
  signingKey?: string;
  recoveryKey?: string;
  dpopNonceRequired?: boolean;
  accessTtlSeconds?: number;
  refreshTtlSeconds?: number;
  extraClients?: Record<string, unknown>;
  extraEnv?: Record<string, string>;
}

export interface StubMcpUpstream {
  port: number;
  receivedCalls: Array<{ method: string; path: string; headers: http.IncomingHttpHeaders; body: string }>;
  close: () => Promise<void>;
}

export async function startStubMcpUpstream(variant: "dc" | "jc"): Promise<StubMcpUpstream> {
  const receivedCalls: StubMcpUpstream["receivedCalls"] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const bodyStr = Buffer.concat(chunks).toString("utf8");
      receivedCalls.push({
        method: req.method ?? "GET",
        path: req.url ?? "/",
        headers: req.headers,
        body: bodyStr
      });
      if (req.url === "/authority") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            variant,
            authoritative: true,
            bridge: { hasUpstreamPair: true }
          })
        );
        return;
      }
      let msg: { id?: unknown; method?: string; params?: { protocolVersion?: string } } = {};
      try {
        msg = JSON.parse(bodyStr || "{}") as typeof msg;
      } catch {
        // leave empty
      }
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const result =
        msg.method === "initialize"
          ? {
              protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: `stub-${variant}`, version: "1.0.0" }
            }
          : msg.method === "tools/list"
            ? {
                tools: [
                  {
                    name: `${variant}_ping`,
                    description: "Ping",
                    inputSchema: { type: "object", properties: {} }
                  }
                ]
              }
            : { content: [{ type: "text", text: "ok" }] };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    receivedCalls,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  };
}

export async function startStubAcsUpstream(): Promise<{
  port: number;
  requests: Array<{ url: string; body: string }>;
  close: () => Promise<void>;
}> {
  const requests: Array<{ url: string; body: string }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ url: req.url ?? "/", body });
      if (req.url === "/readyz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === "/mcp-clients/auth-event" || req.url === "/mcp-clients/observe") {
        res.writeHead(204).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ decision: "allow" }));
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    requests,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  };
}

export interface BootedJcGateway {
  port: number;
  baseUrl: string;
  publicOrigin: string;
  jcIssuer: string;
  jcResource: string;
  dcResource: string;
  consentPassphrase: string;
  dataDir: string;
  acsStub: Awaited<ReturnType<typeof startStubAcsUpstream>>;
  dcStub: StubMcpUpstream;
  jcStub: StubMcpUpstream;
  output: () => string;
  restart: () => Promise<void>;
  close: () => Promise<void>;
  authorizeUrl: (params: Record<string, string>) => string;
  postTokenWithDpop: (
    fields: Record<string, string>,
    key: DpopKeyPair,
    options?: { url?: string; nonce?: string; autoRetryNonce?: boolean }
  ) => Promise<Response>;
  callMcpWithDpop: (
    accessToken: string,
    key: DpopKeyPair,
    options?: {
      path?: string;
      method?: string;
      body?: string;
      nonce?: string;
      autoRetryNonce?: boolean;
      extraHeaders?: Record<string, string>;
    }
  ) => Promise<Response>;
}

async function reserveEphemeralPort(): Promise<number> {
  return new Promise<number>((resolvePort, rejectPort) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", rejectPort);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close((err) => (err ? rejectPort(err) : resolvePort(port)));
    });
  });
}

export async function bootJcGateway(config: JcGatewayConfig = {}): Promise<BootedJcGateway> {
  const dir = mkdtempSync(join(tmpdir(), "jca2-gw-"));
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const port = await reserveEphemeralPort();
  const publicOrigin = (config.publicOrigin ?? `http://127.0.0.1:${port}`).replace(/\/$/, "");
  const jcIssuer = `${publicOrigin}/jc`;
  const jcResource = `${publicOrigin}/jc/mcp`;
  const dcResource = `${publicOrigin}/mcp`;
  const consentPassphrase = config.consentPassphrase ?? `consent-${randomBytes(8).toString("hex")}`;
  const signingKey = config.signingKey ?? randomBytes(32).toString("hex");
  const recoveryKey = config.recoveryKey ?? randomBytes(32).toString("base64");

  if (config.extraClients) {
    writeFileSync(join(dataDir, "clients.json"), JSON.stringify(config.extraClients), { mode: 0o600 });
  } else {
    writeFileSync(join(dataDir, "clients.json"), "{}", { mode: 0o600 });
  }
  writeFileSync(join(dataDir, "tokens.json"), "{}", { mode: 0o600 });

  const [acsStub, dcStub, jcStub] = await Promise.all([
    startStubAcsUpstream(),
    startStubMcpUpstream("dc"),
    startStubMcpUpstream("jc")
  ]);

  let child: ChildProcess | undefined;
  let logs = "";

  const startChild = async (): Promise<void> => {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      GATEWAY_PORT: String(port),
      PUBLIC_ORIGIN: publicOrigin,
      RESOURCE: dcResource,
      ISSUER: publicOrigin,
      JC_ENABLED: "1",
      JC_ISSUER: jcIssuer,
      JC_RESOURCE: jcResource,
      UPSTREAM: `http://127.0.0.1:${dcStub.port}`,
      JC_UPSTREAM: `http://127.0.0.1:${jcStub.port}`,
      ACS_GATEWAY_URL: `http://127.0.0.1:${acsStub.port}`,
      ACS_JC_GATEWAY_TOKEN: "jc-bridge-test-token",
      ACS_MANAGED_MODE: "0",
      JC_PRESET: "local",
      GATEWAY_EXECUTION_TOKEN: "gw-exec-test-token",
      CONSENT_PASSPHRASE: consentPassphrase,
      SIGNING_KEY: signingKey,
      JC_REFRESH_RECOVERY_KEY: recoveryKey,
      DATA_DIR: dataDir,
      DPOP_NONCE_REQUIRED: config.dpopNonceRequired === false ? "0" : "1",
      EDGE_TEST_MODE: "1",
      EDGE_TEST_ACCESS_TTL_S: String(config.accessTtlSeconds ?? 600),
      EDGE_TEST_REFRESH_TTL_S: String(config.refreshTtlSeconds ?? 86400),
      ...(config.extraEnv ?? {})
    };
    const proc = spawn(process.execPath, [DC_GATEWAY_ENTRY], {
      cwd: resolve(REPO_ROOT, "apps/dc-mcp-gateway"),
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child = proc;
    proc.stdout?.on("data", (d: Buffer) => {
      logs += d.toString("utf8");
    });
    proc.stderr?.on("data", (d: Buffer) => {
      logs += d.toString("utf8");
    });
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      if (proc.exitCode !== null) break;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`);
        ready = res.ok;
      } catch {
        await new Promise((r) => setTimeout(r, 75));
      }
    }
    if (!ready) {
      throw new Error(`dc-mcp-gateway failed to start on port ${port}: ${logs}`);
    }
  };

  const stopChild = async (): Promise<void> => {
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolveStop) => {
      const timer = setTimeout(() => {
        child?.kill("SIGKILL");
        resolveStop();
      }, 3000);
      child?.once("exit", () => {
        clearTimeout(timer);
        resolveStop();
      });
      child?.kill("SIGTERM");
    });
    child = undefined;
  };

  await startChild();
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    port,
    baseUrl,
    publicOrigin,
    jcIssuer,
    jcResource,
    dcResource,
    consentPassphrase,
    dataDir,
    acsStub,
    dcStub,
    jcStub,
    output: () => logs,
    restart: async () => {
      await stopChild();
      await startChild();
    },
    close: async () => {
      await stopChild();
      await Promise.all([acsStub.close(), dcStub.close(), jcStub.close()]);
      rmSync(dir, { recursive: true, force: true });
    },
    authorizeUrl: (params: Record<string, string>) =>
      `${baseUrl}/authorize?${new URLSearchParams({
        oauth_lane: "jc",
        resource: jcResource,
        response_type: "code",
        scope: "mcp",
        state: "test-state-0123456789",
        ...params
      }).toString()}`,
    postTokenWithDpop: async (fields, key, opts = {}) => {
      const targetUrl = opts.url ?? `${baseUrl}/token?oauth_lane=jc&resource=${encodeURIComponent(jcResource)}`;
      const parsed = new URL(targetUrl);
      const htu = `${publicOrigin}${parsed.pathname}`;
      const doPost = (nonce?: string) => {
        const proof = signDpopProof({ key, htm: "POST", htu, nonce });
        return fetch(targetUrl, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            DPoP: proof
          },
          body: new URLSearchParams({ resource: jcResource, ...fields }).toString()
        });
      };
      let res = await doPost(opts.nonce);
      if (opts.autoRetryNonce !== false && res.status === 400) {
        const cloned = res.clone();
        const body = (await cloned.json().catch(() => ({}))) as { error?: string };
        const freshNonce = res.headers.get("dpop-nonce");
        if (body.error === "use_dpop_nonce" && freshNonce) {
          res = await doPost(freshNonce);
        }
      }
      return res;
    },
    callMcpWithDpop: async (accessToken, key, opts = {}) => {
      const reqPath = opts.path ?? "/jc/mcp";
      const method = opts.method ?? "POST";
      const htu = `${publicOrigin}${reqPath}`;
      const body =
        opts.body ??
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {}
        });
      const doReq = (nonce?: string) => {
        const proof = signDpopProof({ key, htm: method, htu, accessToken, nonce });
        return fetch(`${baseUrl}${reqPath}`, {
          method,
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `DPoP ${accessToken}`,
            DPoP: proof,
            ...(opts.extraHeaders ?? {})
          },
          ...(method === "GET" || method === "DELETE" ? {} : { body })
        });
      };
      let res = await doReq(opts.nonce);
      if (opts.autoRetryNonce !== false && res.status === 401) {
        const freshNonce = res.headers.get("dpop-nonce");
        const wwwAuth = res.headers.get("www-authenticate") ?? "";
        if (freshNonce && wwwAuth.includes("use_dpop_nonce")) {
          res = await doReq(freshNonce);
        }
      }
      return res;
    }
  };
}

export async function issueBrowserDpopTokens(
  gw: BootedJcGateway,
  key: DpopKeyPair,
  options: {
    clientId?: string;
    redirectUri?: string;
    scope?: string;
    state?: string;
    bindDpopJktOnAuthorize?: boolean;
  } = {}
): Promise<{
  accessToken: string;
  refreshToken: string;
  deviceId?: string;
  clientId: string;
  redirectUri: string;
}> {
  const clientId = options.clientId ?? "jace-commander-cli";
  const redirectUri = options.redirectUri ?? "http://127.0.0.1:41234/callback";
  const scope = options.scope ?? "mcp";
  const state = options.state ?? randomBytes(16).toString("base64url");
  const { verifier, challenge } = generatePkce();

  const consentRes = await fetch(`${gw.baseUrl}/authorize/consent?oauth_lane=jc`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    redirect: "manual",
    body: new URLSearchParams({
      oauth_lane: "jc",
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: gw.jcResource,
      passphrase: gw.consentPassphrase,
      ...(options.bindDpopJktOnAuthorize ? { dpop_jkt: key.jkt } : {})
    }).toString()
  });
  if (consentRes.status !== 302) {
    throw new Error(`Expected 302 from consent, got ${consentRes.status}: ${await consentRes.text()}`);
  }
  const loc = new URL(consentRes.headers.get("location") ?? "");
  const code = loc.searchParams.get("code");
  if (!code) throw new Error("Consent redirect missing authorization code");

  const tokenRes = await gw.postTokenWithDpop(
    {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: clientId
    },
    key
  );
  if (tokenRes.status !== 200) {
    throw new Error(`Token exchange failed (${tokenRes.status}): ${await tokenRes.text()}`);
  }
  const body = (await tokenRes.json()) as {
    access_token: string;
    refresh_token: string;
    device_id?: string;
  };
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    deviceId: body.device_id,
    clientId,
    redirectUri
  };
}

export interface BootedAcsGateway {
  app: FastifyInstance;
  url: string;
  dbPath: string;
  publicOrigin: string;
  operatorToken: string;
  recoveryKey: string;
  restart: () => Promise<void>;
  close: () => Promise<void>;
}

export async function bootAcsGateway(options: {
  publicOrigin?: string;
  recoveryKey?: string;
  operatorToken?: string;
} = {}): Promise<BootedAcsGateway> {
  const dir = mkdtempSync(join(tmpdir(), "jca2-acs-"));
  const dbPath = join(dir, "control.db");
  const operatorToken = options.operatorToken ?? DEFAULT_OPERATOR_TOKEN;
  const recoveryKey = options.recoveryKey ?? randomBytes(32).toString("base64");

  const seed = new SqliteWorkItemStore(dbPath);
  try {
    seed.registerActor({ id: DEFAULT_OPERATOR_ACTOR_ID, actorType: "HUMAN", displayName: "Operator One" });
  } finally {
    seed.close();
  }

  let app: FastifyInstance;
  let url = "";
  let publicOrigin = options.publicOrigin ?? "";

  const prevOrigin = process.env.ACS_PUBLIC_ORIGIN;
  const prevRecovery = process.env.ACS_DEVICE_REFRESH_RECOVERY_KEY;

  const startApp = async (): Promise<void> => {
    process.env.ACS_DEVICE_REFRESH_RECOVERY_KEY = recoveryKey;
    if (options.publicOrigin) {
      process.env.ACS_PUBLIC_ORIGIN = options.publicOrigin;
    }
    app = buildGateway({
      dbPath,
      logger: false,
      auth: {
        token: operatorToken,
        actor: "user",
        actorId: DEFAULT_OPERATOR_ACTOR_ID
      }
    });
    url = await app.listen({ port: 0, host: "127.0.0.1" });
    if (!publicOrigin) {
      publicOrigin = url;
      process.env.ACS_PUBLIC_ORIGIN = publicOrigin;
    }
  };

  await startApp();

  return {
    get app() {
      return app;
    },
    get url() {
      return url;
    },
    dbPath,
    get publicOrigin() {
      return publicOrigin;
    },
    operatorToken,
    recoveryKey,
    restart: async () => {
      await app.close();
      await startApp();
    },
    close: async () => {
      await app.close();
      if (prevOrigin === undefined) delete process.env.ACS_PUBLIC_ORIGIN;
      else process.env.ACS_PUBLIC_ORIGIN = prevOrigin;
      if (prevRecovery === undefined) delete process.env.ACS_DEVICE_REFRESH_RECOVERY_KEY;
      else process.env.ACS_DEVICE_REFRESH_RECOVERY_KEY = prevRecovery;
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

export function signAcsDeviceCodeProof(privateKey: KeyObject, deviceCode: string): string {
  return sign(null, Buffer.from(`acs-device-code-proof-v1\n${deviceCode}`, "utf8"), privateKey).toString("base64url");
}

export function signAcsRefreshProof(
  privateKey: KeyObject,
  clientId: string,
  deviceId: string,
  refreshToken: string,
  issuedAtSeconds: number
): string {
  const refreshTokenSha256 = sha256Hex(refreshToken);
  const message = [
    "acs-device-refresh-proof-v1",
    `client_id=${clientId}`,
    `device_id=${deviceId}`,
    `refresh_token_sha256=${refreshTokenSha256}`,
    "operation=refresh_token",
    `issued_at=${issuedAtSeconds}`
  ].join("\n");
  return sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64url");
}

export async function authenticateAcsDevice(
  gw: BootedAcsGateway,
  key: DpopKeyPair,
  options: { clientId?: string; scope?: string; deviceName?: string } = {}
): Promise<{
  deviceId: string;
  principal: string;
  accessToken: string;
  refreshToken: string;
  scope: string;
}> {
  const clientId = options.clientId ?? "acs-cli";
  const codeRes = await fetch(`${gw.url}/oauth/device/code`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      device_public_key: key.publicKeyPem,
      device_name: options.deviceName ?? "scout-test-device",
      scope: options.scope ?? "acs:device acs:work:read"
    })
  });
  if (codeRes.status !== 200) {
    throw new Error(`ACS device/code failed (${codeRes.status}): ${await codeRes.text()}`);
  }
  const codeBody = (await codeRes.json()) as { device_code: string; user_code: string };
  const approveRes = await fetch(`${gw.url}/device/verify`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${gw.operatorToken}`
    },
    body: JSON.stringify({ user_code: codeBody.user_code, action: "approve" })
  });
  if (approveRes.status !== 200) {
    throw new Error(`ACS device/verify failed (${approveRes.status}): ${await approveRes.text()}`);
  }
  const proof = signAcsDeviceCodeProof(key.privateKey, codeBody.device_code);
  const tokenHtu = `${gw.publicOrigin}/oauth/token`;
  const dpop = signDpopProof({ key, htm: "POST", htu: tokenHtu });
  const tokenRes = await fetch(`${gw.url}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json", DPoP: dpop },
    body: JSON.stringify({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: clientId,
      device_code: codeBody.device_code,
      device_signature: proof
    })
  });
  if (tokenRes.status !== 200) {
    throw new Error(`ACS /oauth/token failed (${tokenRes.status}): ${await tokenRes.text()}`);
  }
  const tokenBody = (await tokenRes.json()) as {
    device_id: string;
    principal: string;
    access_token: string;
    refresh_token: string;
    scope: string;
  };
  return {
    deviceId: tokenBody.device_id,
    principal: tokenBody.principal,
    accessToken: tokenBody.access_token,
    refreshToken: tokenBody.refresh_token,
    scope: tokenBody.scope
  };
}

export function runJcCli(
  args: string[],
  envOverrides: Record<string, string | undefined> = {}
): { status: number | null; stdout: string; stderr: string } {
  const entrypoint = existsSync(JC_CLI_DIST_ENTRY) ? JC_CLI_DIST_ENTRY : JC_CLI_SRC_ENTRY;
  const nodeArgs = entrypoint.endsWith(".ts") ? ["--import", "tsx", entrypoint, ...args] : [entrypoint, ...args];
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    ...envOverrides
  };
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete env[k];
  }
  const res = spawnSync(process.execPath, nodeArgs, {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
    timeout: 20_000
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

export function assertNoSecretsInText(text: string, secrets: readonly string[], label = "output"): void {
  for (const secret of secrets) {
    if (!secret || secret.length < 8) continue;
    if (text.includes(secret)) {
      throw new Error(`Secret leaked in ${label}: matched prefix "${secret.slice(0, 8)}..."`);
    }
  }
  if (/BEGIN (?:EC |RSA |OPENSSH )?PRIVATE KEY/.test(text)) {
    throw new Error(`PEM private key material leaked in ${label}`);
  }
}

export function createKeyObjectFromPrivateJwk(jwk: JsonWebKey): KeyObject {
  return createPrivateKey({ key: jwk, format: "jwk" });
}
