/**
 * OAuth 2.1 + PKCE S256 + RFC 8252 loopback + RFC 8628 device flow + RFC 9449 DPoP
 * for the `jace-commander` / `jace` CLI against the managed `/jc/mcp` lane.
 *
 * Security properties:
 *  - Separate Ed25519 DPoP keypair (`jc-mcp` domain, never shared with ACS).
 *  - Secrets (accessToken, refreshToken, privateKeyPem) stored via SecretStore
 *    (OS keyring or AES-256-GCM headless fallback), never plaintext files.
 *  - Cross-process lock (`auth.lock`) + pre-send `pending-refresh.json` journal
 *    with `refresh_request_id` for crash-safe rotation recovery.
 *  - Never auto-downgrades a DPoP session to Bearer.
 *  - Preserves explicit `JC_MCP_TOKEN` env override (`legacy-bearer-env`) without persisting it.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  clearPendingRefresh,
  readPendingRefresh,
  sha256Hex,
  withAuthLock,
  writePendingRefresh,
  writePrivateFileAtomic,
} from './auth-lock.js';
import {
  createDpopProof,
  extractDpopNonceChallenge,
  generateDpopKeyPair,
  loadDpopKeyPairFromPem,
} from './dpop.js';
import { createSecretStore, type SecretStore } from './secret-store.js';
import { redactSecrets } from './secret-redaction.js';

export const JACE_CLI_CLIENT_ID = 'jace-commander-cli';
const OAUTH_TIMEOUT_MS = 10_000;
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export interface StoredMcpToken {
  mcpUrl: string;
  issuer?: string;
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  /** epoch ms */
  expiresAt: number;
  tokenType?: 'DPoP' | 'Bearer';
  deviceId?: string;
  jkt?: string;
  sub?: string;
  label?: string;
  storageBackend?: string;
  /** Set when the issuer permanently refused the refresh token. Cleared by the next successful login/connect. */
  reauthRequired?: { reason: 'no_refresh_token' | 'refresh_rejected' | 'invalid_client'; at: string };
}

interface StoredMcpMetadata {
  v: 2;
  mcpUrl: string;
  issuer: string;
  clientId: string;
  expiresAt: number;
  tokenType: 'DPoP';
  deviceId?: string;
  jkt: string;
  sub?: string;
  label?: string;
  storageBackend?: string;
  reauthRequired?: { reason: 'no_refresh_token' | 'refresh_rejected' | 'invalid_client'; at: string };
}

interface StoredMcpSecrets {
  accessToken: string;
  refreshToken?: string;
  privateKeyPem: string;
}

export interface McpAuthStatus {
  connected: boolean;
  authMode: 'dpop' | 'legacy-bearer-env' | 'not_connected';
  mcpUrl: string;
  issuer: string | null;
  audience: string;
  sub: string | null;
  deviceId: string | null;
  jkt: string | null;
  label: string | null;
  expiresAt: string | null;
  refreshable: boolean;
  storageBackend: string | null;
  reauthRequired: { reason: string; at: string } | null;
}

export function mcpTokenPath(stateDir: string): string {
  return path.join(stateDir, 'mcp-token.json');
}

export function mcpMetaPath(stateDir: string): string {
  return path.join(stateDir, 'auth-meta.json');
}

function secretKeyFor(mcpUrl: string): string {
  return `jc-mcp:${mcpUrl.replace(/\/$/, '')}:secrets`;
}

function readMcpMetadata(stateDir: string): StoredMcpMetadata | undefined {
  try {
    const file = mcpMetaPath(stateDir);
    if (!fs.existsSync(file)) return undefined;
    if (fs.lstatSync(file).isSymbolicLink()) return undefined;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<StoredMcpMetadata>;
    if (
      parsed &&
      parsed.v === 2 &&
      typeof parsed.mcpUrl === 'string' &&
      typeof parsed.issuer === 'string' &&
      typeof parsed.jkt === 'string' &&
      parsed.tokenType === 'DPoP'
    ) {
      return parsed as StoredMcpMetadata;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function writeMcpMetadata(stateDir: string, meta: StoredMcpMetadata): void {
  writePrivateFileAtomic(mcpMetaPath(stateDir), JSON.stringify(meta, null, 2));
}

/** Legacy synchronous reader for pre-v2 fixture tests (`mcp-token.json`). */
export function loadMcpToken(stateDir: string): StoredMcpToken | undefined {
  const meta = readMcpMetadata(stateDir);
  if (meta) {
    return {
      mcpUrl: meta.mcpUrl,
      issuer: meta.issuer,
      clientId: meta.clientId,
      accessToken: '',
      expiresAt: meta.expiresAt,
      tokenType: meta.tokenType,
      deviceId: meta.deviceId,
      jkt: meta.jkt,
      sub: meta.sub,
      label: meta.label,
      storageBackend: meta.storageBackend,
      reauthRequired: meta.reauthRequired,
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(mcpTokenPath(stateDir), 'utf8')) as StoredMcpToken;
    return typeof parsed.accessToken === 'string' && typeof parsed.mcpUrl === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function saveLegacyMcpToken(stateDir: string, token: StoredMcpToken): void {
  writePrivateFileAtomic(mcpTokenPath(stateDir), JSON.stringify(token, null, 2));
}

export async function forgetMcpToken(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
  mcpUrl?: string,
): Promise<void> {
  const meta = readMcpMetadata(stateDir);
  const targetUrl = (mcpUrl ?? meta?.mcpUrl)?.replace(/\/$/, '');
  if (targetUrl) {
    try {
      const store = await createSecretStore({ stateDir, env });
      await store.delete(secretKeyFor(targetUrl));
    } catch {
      // ignore secret store cleanup failure during logout
    }
  }
  fs.rmSync(mcpMetaPath(stateDir), { force: true });
  fs.rmSync(mcpTokenPath(stateDir), { force: true });
  clearPendingRefresh(stateDir, 'jc-mcp');
}

const b64u = (buffer: Buffer) => buffer.toString('base64url');

async function parseJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`expected JSON from ${response.url} (HTTP ${response.status})`);
  }
}

export interface Discovery {
  issuer: string;
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  deviceAuthorizationEndpoint?: string;
}

export async function discover(mcpUrl: string, fetchImpl: typeof fetch = fetch): Promise<Discovery> {
  const normalized = mcpUrl.replace(/\/$/, '');
  const url = new URL(normalized);
  const prm = await parseJsonResponse(
    await fetchImpl(`${url.origin}/.well-known/oauth-protected-resource${url.pathname}`, {
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    }),
  );
  const resource = String(prm.resource ?? '').replace(/\/$/, '');
  if (resource !== normalized) {
    throw new Error(`protected-resource metadata names ${resource}, not ${normalized}`);
  }
  const advertisedIssuer = Array.isArray(prm.authorization_servers) && prm.authorization_servers.length > 0
    ? String(prm.authorization_servers[0]).replace(/\/$/, '')
    : url.origin;
  const asUrl = new URL(advertisedIssuer);
  const asPath = asUrl.pathname === '/' ? '' : asUrl.pathname.replace(/\/$/, '');
  const as = await parseJsonResponse(
    await fetchImpl(`${asUrl.origin}${asPath}/.well-known/oauth-authorization-server`, {
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    }),
  );
  for (const key of ['authorization_endpoint', 'token_endpoint']) {
    if (typeof as[key] !== 'string') throw new Error(`authorization server metadata is missing ${key}`);
  }
  const issuer = typeof as.issuer === 'string' && as.issuer ? as.issuer.replace(/\/$/, '') : advertisedIssuer;
  return {
    issuer,
    resource,
    authorizationEndpoint: String(as.authorization_endpoint),
    tokenEndpoint: String(as.token_endpoint),
    registrationEndpoint: typeof as.registration_endpoint === 'string' ? as.registration_endpoint : undefined,
    deviceAuthorizationEndpoint:
      typeof as.device_authorization_endpoint === 'string' ? as.device_authorization_endpoint : undefined,
  };
}

async function postTokenWithDpopNonce(
  tokenEndpoint: string,
  params: URLSearchParams,
  keyPair: ReturnType<typeof generateDpopKeyPair>,
  fetchImpl: typeof fetch,
  cachedNonce?: string,
): Promise<{ response: Response; body: Record<string, unknown>; nonce?: string }> {
  let nonce = cachedNonce;
  for (let attempt = 0; attempt < 2; attempt++) {
    const proof = createDpopProof({
      privateKey: keyPair.privateKey,
      publicJwk: keyPair.publicJwk,
      htm: 'POST',
      htu: tokenEndpoint,
      nonce,
    });
    const response = await fetchImpl(tokenEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        DPoP: proof,
      },
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
      body: params.toString(),
    });
    const nextNonce = response.headers.get('DPoP-Nonce')?.trim() || undefined;
    const body = await parseJsonResponse(response);
    const challenge = extractDpopNonceChallenge(response, body);
    if (attempt === 0 && challenge.useDpopNonce && challenge.nonce) {
      nonce = challenge.nonce;
      continue;
    }
    return { response, body, nonce: nextNonce ?? nonce };
  }
  throw new Error('DPoP nonce challenge loop exceeded');
}

async function persistV2Session(
  stateDir: string,
  env: NodeJS.ProcessEnv,
  found: Discovery,
  clientId: string,
  keyPair: ReturnType<typeof generateDpopKeyPair>,
  tokenBody: Record<string, unknown>,
  label?: string,
): Promise<StoredMcpToken> {
  const accessToken = typeof tokenBody.access_token === 'string' ? tokenBody.access_token : '';
  if (!accessToken) {
    throw new Error(`token exchange failed: ${String(tokenBody.error ?? 'missing access_token')}`);
  }
  const tokenTypeRaw = typeof tokenBody.token_type === 'string' ? tokenBody.token_type : '';
  if (tokenTypeRaw.toLowerCase() !== 'dpop') {
    throw new Error(`server returned unsupported token_type ${JSON.stringify(tokenTypeRaw)}; DPoP is required`);
  }
  const refreshToken = typeof tokenBody.refresh_token === 'string' ? tokenBody.refresh_token : undefined;
  const expiresIn = Number(tokenBody.expires_in ?? 600);
  const expiresAt = Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 600) * 1000;
  const deviceId = typeof tokenBody.device_id === 'string' ? tokenBody.device_id : undefined;
  const sub = typeof tokenBody.sub === 'string' ? tokenBody.sub : undefined;

  const store = await createSecretStore({ stateDir, env });
  const secrets: StoredMcpSecrets = {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    privateKeyPem: keyPair.privateKeyPem,
  };
  await store.set(secretKeyFor(found.resource), JSON.stringify(secrets));
  const meta: StoredMcpMetadata = {
    v: 2,
    mcpUrl: found.resource,
    issuer: found.issuer,
    clientId,
    expiresAt,
    tokenType: 'DPoP',
    ...(deviceId ? { deviceId } : {}),
    jkt: keyPair.jkt,
    ...(sub ? { sub } : {}),
    ...(label ? { label } : {}),
    storageBackend: store.backendName(),
  };
  writeMcpMetadata(stateDir, meta);
  // Remove any legacy plaintext mcp-token.json so secrets never remain on disk in plaintext.
  fs.rmSync(mcpTokenPath(stateDir), { force: true });
  clearPendingRefresh(stateDir, 'jc-mcp');

  return {
    mcpUrl: found.resource,
    issuer: found.issuer,
    clientId,
    accessToken,
    refreshToken,
    expiresAt,
    tokenType: 'DPoP',
    deviceId,
    jkt: keyPair.jkt,
    sub,
    label,
    storageBackend: store.backendName(),
  };
}

export interface ConnectOptions {
  mcpUrl: string;
  stateDir: string;
  /** Show the URL to open; the user approves with the edge's consent passphrase. */
  onAuthorizeUrl: (url: string) => void;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  clientId?: string;
  scope?: string;
  label?: string;
}

/** Interactive OAuth 2.1 login: loopback redirect listener + PKCE S256 + iss check + DPoP. */
export async function connect(options: ConnectOptions): Promise<StoredMcpToken> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const env = options.env ?? process.env;
  const found = await discover(options.mcpUrl, fetchImpl);
  const verifier = b64u(crypto.randomBytes(32));
  const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
  const state = b64u(crypto.randomBytes(16));
  const keyPair = generateDpopKeyPair();
  const clientId = options.clientId ?? JACE_CLI_CLIENT_ID;

  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  try {
    const authorize = new URL(found.authorizationEndpoint);
    for (const [key, value] of Object.entries({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: options.scope ?? 'mcp',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: found.resource,
      dpop_jkt: keyPair.jkt,
    })) {
      authorize.searchParams.set(key, value);
    }

    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('login timed out waiting for browser approval')),
        options.timeoutMs ?? 300_000,
      );
      server.on('request', (req, res) => {
        const url = new URL(req.url ?? '/', redirectUri);
        if (url.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }
        const returnedState = url.searchParams.get('state');
        const returnedCode = url.searchParams.get('code');
        const returnedIss = url.searchParams.get('iss')?.replace(/\/$/, '') ?? null;
        const issOk = returnedIss === found.issuer;
        const stateOk = returnedState === state;
        const ok = Boolean(stateOk && issOk && returnedCode);
        res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain' });
        res.end(ok ? 'Jace Commander CLI connected. You can close this tab.' : 'Login failed.');
        clearTimeout(timer);
        if (ok) {
          resolve(String(returnedCode));
        } else if (!issOk) {
          reject(new Error(`issuer mismatch on callback (expected ${found.issuer}, got ${returnedIss ?? 'none'})`));
        } else {
          reject(new Error(url.searchParams.get('error') ?? 'state mismatch or missing code'));
        }
      });
      options.onAuthorizeUrl(authorize.toString());
    });

    const { response, body } = await postTokenWithDpopNonce(
      found.tokenEndpoint,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        client_id: clientId,
        resource: found.resource,
      }),
      keyPair,
      fetchImpl,
    );
    if (!response.ok) {
      throw new Error(`token exchange failed: ${String(body.error ?? `http_${response.status}`)}`);
    }
    return await persistV2Session(options.stateDir, env, found, clientId, keyPair, body, options.label);
  } finally {
    server.close();
  }
}

export interface ConnectDeviceOptions {
  mcpUrl: string;
  stateDir: string;
  onPrompt?: (prompt: { userCode: string; verificationUri: string; verificationUriComplete: string; expiresIn: number }) => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  clientId?: string;
  scope?: string;
  label?: string;
}

/** Headless RFC 8628 device authorization flow against `/jc` with DPoP key registration. */
export async function connectDevice(options: ConnectDeviceOptions): Promise<StoredMcpToken> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  const found = await discover(options.mcpUrl, fetchImpl);
  const deviceEndpoint = found.deviceAuthorizationEndpoint ?? `${found.issuer}/oauth/device/code`;
  const keyPair = generateDpopKeyPair();
  const clientId = options.clientId ?? JACE_CLI_CLIENT_ID;
  const deviceName = (options.label ?? `jace-cli@${os.hostname()}`).slice(0, 128);

  const deviceResponse = await fetchImpl(deviceEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    body: new URLSearchParams({
      client_id: clientId,
      scope: options.scope ?? 'mcp',
      dpop_jkt: keyPair.jkt,
      device_name: deviceName,
    }).toString(),
  });
  const deviceJson = await parseJsonResponse(deviceResponse);
  const deviceCode = deviceJson.device_code;
  const userCode = deviceJson.user_code;
  const verificationUri = deviceJson.verification_uri;
  if (
    !deviceResponse.ok ||
    typeof deviceCode !== 'string' ||
    typeof userCode !== 'string' ||
    typeof verificationUri !== 'string'
  ) {
    throw new Error(`device authorization failed: ${String(deviceJson.error ?? `http_${deviceResponse.status}`)}`);
  }
  const expiresIn = typeof deviceJson.expires_in === 'number' && deviceJson.expires_in > 0 ? deviceJson.expires_in : 600;
  let interval = typeof deviceJson.interval === 'number' && deviceJson.interval > 0 ? deviceJson.interval : 5;
  const verificationUriComplete =
    typeof deviceJson.verification_uri_complete === 'string' ? deviceJson.verification_uri_complete : verificationUri;
  options.onPrompt?.({ userCode, verificationUri, verificationUriComplete, expiresIn });

  const deadline = now() + expiresIn * 1000;
  let nonce: string | undefined;
  while (now() < deadline) {
    await sleep(interval * 1000);
    const res = await postTokenWithDpopNonce(
      found.tokenEndpoint,
      new URLSearchParams({
        grant_type: DEVICE_GRANT,
        device_code: deviceCode,
        client_id: clientId,
        resource: found.resource,
      }),
      keyPair,
      fetchImpl,
      nonce,
    );
    nonce = res.nonce;
    if (res.response.ok) {
      return await persistV2Session(options.stateDir, env, found, clientId, keyPair, res.body, options.label ?? deviceName);
    }
    const err = res.body.error;
    if (err === 'authorization_pending') continue;
    if (err === 'slow_down') {
      interval += 5;
      continue;
    }
    throw new Error(`device authorization ended: ${typeof err === 'string' ? err : `http_${res.response.status}`}`);
  }
  throw new Error('device authorization expired before approval');
}

export type McpTokenOutcome =
  | { kind: 'token'; accessToken: string; tokenType?: 'DPoP' | 'Bearer'; keyPair?: ReturnType<typeof loadDpopKeyPairFromPem> }
  | { kind: 'not_connected' }
  | { kind: 'reauth_required'; reason: 'no_refresh_token' | 'refresh_rejected' | 'invalid_client' }
  | { kind: 'unavailable'; reason: string };

const PERMANENT_REFRESH_ERRORS = new Map<string, 'refresh_rejected' | 'invalid_client'>([
  ['invalid_grant', 'refresh_rejected'],
  ['invalid_client', 'invalid_client'],
  ['unauthorized_client', 'invalid_client'],
]);

const refreshInFlight = new Map<string, Promise<McpTokenOutcome>>();

async function loadV2Secrets(
  store: SecretStore,
  mcpUrl: string,
): Promise<StoredMcpSecrets | undefined> {
  const raw = await store.get(secretKeyFor(mcpUrl));
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredMcpSecrets>;
    if (typeof parsed.accessToken === 'string' && typeof parsed.privateKeyPem === 'string') {
      return parsed as StoredMcpSecrets;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function refreshV2SessionLocked(
  mcpUrl: string,
  stateDir: string,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
  now: () => number,
  forceRefresh: boolean,
): Promise<McpTokenOutcome> {
  const normalized = mcpUrl.replace(/\/$/, '');
  const meta = readMcpMetadata(stateDir);
  if (!meta || meta.mcpUrl !== normalized) return { kind: 'not_connected' };
  if (meta.reauthRequired) return { kind: 'reauth_required', reason: meta.reauthRequired.reason };

  const store = await createSecretStore({ stateDir, env });
  const secrets = await loadV2Secrets(store, normalized);
  if (!secrets) return { kind: 'not_connected' };

  const keyPair = loadDpopKeyPairFromPem(secrets.privateKeyPem);
  if (!forceRefresh && meta.expiresAt - now() > 60_000) {
    return { kind: 'token', accessToken: secrets.accessToken, tokenType: 'DPoP', keyPair };
  }
  if (!secrets.refreshToken) {
    return { kind: 'reauth_required', reason: 'no_refresh_token' };
  }

  const refreshToken = secrets.refreshToken;
  const oldHash = sha256Hex(refreshToken);
  const existingPending = readPendingRefresh(stateDir, 'jc-mcp');
  const refreshRequestId =
    existingPending &&
    existingPending.url === normalized &&
    existingPending.clientId === meta.clientId &&
    existingPending.oldRefreshTokenHash === oldHash
      ? existingPending.refreshRequestId
      : crypto.randomUUID();

  // Persist pending rotation journal BEFORE sending POST /token so a crash before commit can recover.
  writePendingRefresh(stateDir, {
    domain: 'jc-mcp',
    url: normalized,
    clientId: meta.clientId,
    deviceId: meta.deviceId ?? null,
    refreshRequestId,
    oldRefreshTokenHash: oldHash,
    startedAt: new Date(now()).toISOString(),
  });

  let found: Discovery;
  let response: Response;
  let body: Record<string, unknown>;
  try {
    found = await discover(normalized, fetchImpl);
    const res = await postTokenWithDpopNonce(
      found.tokenEndpoint,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: meta.clientId,
        resource: found.resource,
        refresh_request_id: refreshRequestId,
      }),
      keyPair,
      fetchImpl,
    );
    response = res.response;
    body = res.body;
  } catch (error) {
    return {
      kind: 'unavailable',
      reason: redactSecrets(error instanceof Error ? error.message : 'refresh failed', [refreshToken, secrets.accessToken]),
    };
  }

  if (response.ok && typeof body.access_token === 'string') {
    const tokenTypeRaw = typeof body.token_type === 'string' ? body.token_type : 'DPoP';
    if (tokenTypeRaw.toLowerCase() !== 'dpop') {
      return { kind: 'unavailable', reason: 'token endpoint did not confirm DPoP token_type' };
    }
    const nextSecrets: StoredMcpSecrets = {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : refreshToken,
      privateKeyPem: secrets.privateKeyPem,
    };
    await store.set(secretKeyFor(normalized), JSON.stringify(nextSecrets));
    const expiresIn = Number(body.expires_in ?? 600);
    const nextMeta: StoredMcpMetadata = {
      ...meta,
      expiresAt: now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 600) * 1000,
      ...(typeof body.device_id === 'string' ? { deviceId: body.device_id } : {}),
      ...(typeof body.sub === 'string' ? { sub: body.sub } : {}),
      storageBackend: store.backendName(),
    };
    delete nextMeta.reauthRequired;
    writeMcpMetadata(stateDir, nextMeta);
    clearPendingRefresh(stateDir, 'jc-mcp');
    return { kind: 'token', accessToken: nextSecrets.accessToken, tokenType: 'DPoP', keyPair };
  }

  const permanent =
    response.status >= 400 && response.status < 500 && typeof body.error === 'string'
      ? PERMANENT_REFRESH_ERRORS.get(body.error)
      : undefined;
  if (permanent) {
    clearPendingRefresh(stateDir, 'jc-mcp');
    const { refreshToken: _dead, ...restSecrets } = secrets;
    await store.set(secretKeyFor(normalized), JSON.stringify(restSecrets));
    writeMcpMetadata(stateDir, {
      ...meta,
      reauthRequired: { reason: permanent, at: new Date(now()).toISOString() },
    });
    return { kind: 'reauth_required', reason: permanent };
  }

  return { kind: 'unavailable', reason: `token endpoint answered HTTP ${response.status}` };
}

/** Legacy pre-v2 refresh path kept ONLY for pre-existing plaintext mcp-token.json test fixtures. */
async function legacyMcpAccessTokenOutcome(
  mcpUrl: string,
  stateDir: string,
  fetchImpl: typeof fetch,
): Promise<McpTokenOutcome> {
  const normalized = mcpUrl.replace(/\/$/, '');
  const stored = loadMcpToken(stateDir);
  if (!stored || stored.mcpUrl !== normalized) return { kind: 'not_connected' };
  if (stored.reauthRequired) return { kind: 'reauth_required', reason: stored.reauthRequired.reason };
  if (stored.expiresAt - Date.now() > 60_000) {
    return { kind: 'token', accessToken: stored.accessToken };
  }
  if (!stored.refreshToken) return { kind: 'reauth_required', reason: 'no_refresh_token' };
  const refreshToken = stored.refreshToken;
  const key = `${stateDir}::${stored.mcpUrl}`;
  const inFlight = refreshInFlight.get(key);
  if (inFlight) return inFlight;

  const promise = (async (): Promise<McpTokenOutcome> => {
    let found: Discovery;
    let response: Response;
    let token: Record<string, unknown>;
    try {
      found = await discover(mcpUrl, fetchImpl);
      response = await fetchImpl(found.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: stored.clientId,
          resource: found.resource,
        }).toString(),
        signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
      });
      token = await parseJsonResponse(response);
    } catch (error) {
      return { kind: 'unavailable', reason: error instanceof Error ? error.message : 'refresh failed' };
    }
    if (typeof token.access_token === 'string' && response.ok) {
      const refreshed: StoredMcpToken = {
        ...stored,
        accessToken: token.access_token,
        ...(typeof token.refresh_token === 'string' ? { refreshToken: token.refresh_token } : {}),
        expiresAt: Date.now() + Number(token.expires_in ?? 3600) * 1000,
      };
      saveLegacyMcpToken(stateDir, refreshed);
      return { kind: 'token', accessToken: refreshed.accessToken };
    }
    const permanent =
      response.status >= 400 && response.status < 500 && typeof token.error === 'string'
        ? PERMANENT_REFRESH_ERRORS.get(token.error)
        : undefined;
    if (permanent) {
      const current = loadMcpToken(stateDir);
      if (current && current.refreshToken !== refreshToken) {
        return current.expiresAt - Date.now() > 60_000
          ? { kind: 'token', accessToken: current.accessToken }
          : { kind: 'unavailable', reason: 'credential was refreshed by another process; retry' };
      }
      const { refreshToken: _dead, ...rest } = stored;
      saveLegacyMcpToken(stateDir, {
        ...rest,
        reauthRequired: { reason: permanent, at: new Date().toISOString() },
      });
      return { kind: 'reauth_required', reason: permanent };
    }
    return { kind: 'unavailable', reason: `token endpoint answered HTTP ${response.status}` };
  })();

  refreshInFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    refreshInFlight.delete(key);
  }
}

export async function mcpAccessTokenOutcome(
  mcpUrl: string,
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
  forceRefresh = false,
): Promise<McpTokenOutcome> {
  if (env.JC_MCP_TOKEN) {
    return { kind: 'token', accessToken: env.JC_MCP_TOKEN, tokenType: 'Bearer' };
  }
  const normalized = mcpUrl.replace(/\/$/, '');
  const meta = readMcpMetadata(stateDir);
  if (!meta) {
    if (fs.existsSync(mcpTokenPath(stateDir))) {
      return legacyMcpAccessTokenOutcome(normalized, stateDir, fetchImpl);
    }
    return { kind: 'not_connected' };
  }
  if (meta.mcpUrl !== normalized) return { kind: 'not_connected' };
  if (meta.reauthRequired) return { kind: 'reauth_required', reason: meta.reauthRequired.reason };

  if (!forceRefresh && meta.expiresAt - now() > 60_000) {
    const store = await createSecretStore({ stateDir, env });
    const secrets = await loadV2Secrets(store, normalized);
    if (!secrets) return { kind: 'not_connected' };
    return {
      kind: 'token',
      accessToken: secrets.accessToken,
      tokenType: 'DPoP',
      keyPair: loadDpopKeyPairFromPem(secrets.privateKeyPem),
    };
  }

  return withAuthLock(stateDir, () => refreshV2SessionLocked(normalized, stateDir, env, fetchImpl, now, forceRefresh));
}

export async function mcpAccessToken(
  mcpUrl: string,
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  const outcome = await mcpAccessTokenOutcome(mcpUrl, stateDir, env, fetchImpl);
  return outcome.kind === 'token' ? outcome.accessToken : undefined;
}

export async function refreshMcpSession(
  mcpUrl: string,
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<McpTokenOutcome> {
  return mcpAccessTokenOutcome(mcpUrl, stateDir, env, fetchImpl, now, true);
}

export async function loadMcpAuthStatus(
  mcpUrl: string,
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<McpAuthStatus> {
  const normalized = mcpUrl.replace(/\/$/, '');
  if (env.JC_MCP_TOKEN) {
    return {
      connected: true,
      authMode: 'legacy-bearer-env',
      mcpUrl: normalized,
      issuer: null,
      audience: normalized,
      sub: null,
      deviceId: null,
      jkt: null,
      label: null,
      expiresAt: null,
      refreshable: false,
      storageBackend: 'env:JC_MCP_TOKEN',
      reauthRequired: null,
    };
  }
  const meta = readMcpMetadata(stateDir);
  if (!meta || meta.mcpUrl !== normalized) {
    return {
      connected: false,
      authMode: 'not_connected',
      mcpUrl: normalized,
      issuer: null,
      audience: normalized,
      sub: null,
      deviceId: null,
      jkt: null,
      label: null,
      expiresAt: null,
      refreshable: false,
      storageBackend: null,
      reauthRequired: null,
    };
  }
  const store = await createSecretStore({ stateDir, env });
  const secrets = await loadV2Secrets(store, normalized);
  return {
    connected: Boolean(secrets && !meta.reauthRequired),
    authMode: 'dpop',
    mcpUrl: meta.mcpUrl,
    issuer: meta.issuer,
    audience: meta.mcpUrl,
    sub: meta.sub ?? null,
    deviceId: meta.deviceId ?? null,
    jkt: meta.jkt,
    label: meta.label ?? null,
    expiresAt: new Date(meta.expiresAt).toISOString(),
    refreshable: Boolean(secrets?.refreshToken),
    storageBackend: meta.storageBackend ?? store.backendName(),
    reauthRequired: meta.reauthRequired ?? null,
  };
}

export interface AuthHeadersContext {
  method: string;
  url: string;
  nonce?: string;
  forceRefresh?: boolean;
}

export interface AuthChallenge {
  status: number;
  headers: Headers;
  method: string;
  url: string;
  sentAuthMode?: 'dpop' | 'bearer';
  idempotent?: boolean;
}

export interface AuthProvider {
  getAuthHeaders(
    ctx: AuthHeadersContext,
  ): Promise<
    | { ok: true; mode: 'dpop' | 'bearer'; headers: Record<string, string> }
    | { ok: false; kind: 'not_connected' | 'reauth_required' | 'unavailable'; code: string; message: string }
  >;
  handleAuthChallenge?(challenge: AuthChallenge): Promise<{ retry: boolean; nonce?: string }>;
}

/**
 * Typed DPoP/Bearer AuthProvider for `McpHttpClient` and `/jc/devices` management calls.
 * Never auto-downgrades DPoP sessions to Bearer.
 */
export function mcpAuthProvider(
  mcpUrl: string,
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): AuthProvider {
  let cachedNonce: string | undefined;

  return {
    async getAuthHeaders(ctx) {
      const outcome = await mcpAccessTokenOutcome(mcpUrl, stateDir, env, fetchImpl, now, Boolean(ctx.forceRefresh));
      if (outcome.kind === 'not_connected') {
        return {
          ok: false,
          kind: 'not_connected',
          code: 'not_connected',
          message: 'no /jc/mcp credential: run `jace auth login` (or set JC_MCP_TOKEN)',
        };
      }
      if (outcome.kind === 'reauth_required') {
        return {
          ok: false,
          kind: 'not_connected',
          code: outcome.reason,
          message: `session requires re-authentication (${outcome.reason}): run \`jace auth login\``,
        };
      }
      if (outcome.kind === 'unavailable') {
        return {
          ok: false,
          kind: 'unavailable',
          code: 'auth_unavailable',
          message: outcome.reason,
        };
      }
      if (outcome.tokenType !== 'DPoP') {
        const headers: Record<string, string> = { authorization: `Bearer ${outcome.accessToken}` };
        return {
          ok: true,
          mode: 'bearer',
          headers,
        };
      }
      if (!outcome.keyPair) {
        return {
          ok: false,
          kind: 'not_connected',
          code: 'missing_dpop_key',
          message: 'missing DPoP signing key; run `jace auth login`',
        };
      }
      const nonce = ctx.nonce ?? cachedNonce;
      const proof = createDpopProof({
        privateKey: outcome.keyPair.privateKey,
        publicJwk: outcome.keyPair.publicJwk,
        htm: ctx.method,
        htu: ctx.url,
        accessToken: outcome.accessToken,
        nonce,
        nowMs: now(),
      });
      return {
        ok: true,
        mode: 'dpop',
        headers: {
          authorization: `DPoP ${outcome.accessToken}`,
          DPoP: proof,
        },
      };
    },

    async handleAuthChallenge(challenge) {
      if (challenge.status !== 401) return { retry: false };
      const wwwAuth = challenge.headers.get('WWW-Authenticate') ?? '';
      const nonceHeader = challenge.headers.get('DPoP-Nonce')?.trim() || undefined;
      if (/\bDPoP\b/i.test(wwwAuth) && /\berror\s*=\s*"?use_dpop_nonce"?/i.test(wwwAuth) && nonceHeader) {
        cachedNonce = nonceHeader;
        return { retry: true, nonce: nonceHeader };
      }
      if (challenge.sentAuthMode === 'dpop' && challenge.idempotent !== false) {
        const refreshed = await mcpAccessTokenOutcome(mcpUrl, stateDir, env, fetchImpl, now, true);
        return { retry: refreshed.kind === 'token' };
      }
      return { retry: false };
    },
  };
}

async function dpopAuthorizedJson(
  mcpUrl: string,
  stateDir: string,
  method: 'GET' | 'POST' | 'DELETE',
  targetUrl: string,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const provider = mcpAuthProvider(mcpUrl, stateDir, env, fetchImpl);
  let nonce: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const auth = await provider.getAuthHeaders({ method, url: targetUrl, nonce, forceRefresh: attempt > 0 && !nonce });
    if (!auth.ok) throw new Error(auth.message);
    if (auth.mode !== 'dpop') {
      throw new Error('device management requires an interactive DPoP session (`jace auth login`), not legacy JC_MCP_TOKEN');
    }
    const response = await fetchImpl(targetUrl, {
      method,
      headers: { accept: 'application/json', ...auth.headers },
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    });
    if (response.status === 401 && attempt === 0 && provider.handleAuthChallenge) {
      const challenge = await provider.handleAuthChallenge({
        status: response.status,
        headers: response.headers,
        method,
        url: targetUrl,
        sentAuthMode: auth.mode,
      });
      if (challenge.retry) {
        nonce = challenge.nonce;
        continue;
      }
    }
    const body = await parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(`${method} ${new URL(targetUrl).pathname} failed (HTTP ${response.status}): ${String(body.error ?? 'error')}`);
    }
    return body;
  }
  throw new Error('request failed after auth retry');
}

function issuerForStoredOrUrl(mcpUrl: string, stateDir: string): string {
  const meta = readMcpMetadata(stateDir);
  if (meta?.issuer) return meta.issuer.replace(/\/$/, '');
  const u = new URL(mcpUrl);
  const basePath = u.pathname.replace(/\/mcp\/?$/, '').replace(/\/$/, '');
  return `${u.origin}${basePath}`;
}

export async function listJcDevices(
  mcpUrl: string,
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<Array<Record<string, unknown>>> {
  const issuer = issuerForStoredOrUrl(mcpUrl, stateDir);
  const body = await dpopAuthorizedJson(mcpUrl, stateDir, 'GET', `${issuer}/devices`, env, fetchImpl);
  return Array.isArray(body.devices) ? (body.devices as Array<Record<string, unknown>>) : [];
}

export async function revokeJcDevice(
  mcpUrl: string,
  stateDir: string,
  deviceId: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<{ revoked: boolean; device_id: string }> {
  const issuer = issuerForStoredOrUrl(mcpUrl, stateDir);
  const body = await dpopAuthorizedJson(
    mcpUrl,
    stateDir,
    'POST',
    `${issuer}/devices/${encodeURIComponent(deviceId)}/revoke`,
    env,
    fetchImpl,
  );
  const meta = readMcpMetadata(stateDir);
  if (meta?.deviceId && meta.deviceId === deviceId) {
    await forgetMcpToken(stateDir, env, mcpUrl);
  }
  return {
    revoked: body.revoked === true,
    device_id: typeof body.device_id === 'string' ? body.device_id : deviceId,
  };
}
