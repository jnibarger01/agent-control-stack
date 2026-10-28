/**
 * OAuth for the `jace-commander` CLI against the managed /jc/mcp lane.
 *
 * Standard MCP authorization (RFC 9728 discovery, RFC 7591 dynamic client
 * registration, authorization code + PKCE S256, RFC 8707 resource binding,
 * RFC 8252 loopback redirect), exactly what ChatGPT does against the same
 * edge. The CLI gets a /jc/mcp-audience token; it gets no ACS or signing
 * authority. Tokens are stored 0600 in the JC state directory.
 *
 * JC_MCP_TOKEN overrides the stored token (services, CI, tests).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export interface StoredMcpToken {
  mcpUrl: string;
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  /** epoch ms */
  expiresAt: number;
  /** Set when the issuer permanently refused the refresh token. Cleared by the next successful `connect`. */
  reauthRequired?: { reason: 'no_refresh_token' | 'refresh_rejected' | 'invalid_client'; at: string };
}

export function mcpTokenPath(stateDir: string): string {
  return path.join(stateDir, 'mcp-token.json');
}

export function loadMcpToken(stateDir: string): StoredMcpToken | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(mcpTokenPath(stateDir), 'utf8')) as StoredMcpToken;
    return typeof parsed.accessToken === 'string' && typeof parsed.mcpUrl === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function saveMcpToken(stateDir: string, token: StoredMcpToken): void {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const target = mcpTokenPath(stateDir);
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(token, null, 2), { mode: 0o600 });
  fs.renameSync(temp, target);
}

export function forgetMcpToken(stateDir: string): void {
  fs.rmSync(mcpTokenPath(stateDir), { force: true });
}

const b64u = (buffer: Buffer) => buffer.toString('base64url');

/** OAuth discovery/registration/token fetches must never hang the login. */
const OAUTH_TIMEOUT_MS = 10_000;

async function json(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`expected JSON from ${response.url} (HTTP ${response.status})`);
  }
}

interface Discovery {
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
}

export async function discover(mcpUrl: string, fetchImpl: typeof fetch = fetch): Promise<Discovery> {
  const url = new URL(mcpUrl);
  const prm = await json(await fetchImpl(`${url.origin}/.well-known/oauth-protected-resource${url.pathname}`, { signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS) }));
  const resource = String(prm.resource ?? '');
  if (resource !== mcpUrl.replace(/\/$/, '')) throw new Error(`protected-resource metadata names ${resource}, not ${mcpUrl}`);
  const issuer = Array.isArray(prm.authorization_servers) ? String(prm.authorization_servers[0]) : url.origin;
  const as = await json(await fetchImpl(`${issuer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS) }));
  for (const key of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) {
    if (typeof as[key] !== 'string') throw new Error(`authorization server metadata is missing ${key}`);
  }
  return {
    resource,
    authorizationEndpoint: String(as.authorization_endpoint),
    tokenEndpoint: String(as.token_endpoint),
    registrationEndpoint: String(as.registration_endpoint),
  };
}

export interface ConnectOptions {
  mcpUrl: string;
  stateDir: string;
  /** Show the URL to open; the user approves with the edge's consent passphrase. */
  onAuthorizeUrl: (url: string) => void;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Interactive login: loopback redirect listener + PKCE. */
export async function connect(options: ConnectOptions): Promise<StoredMcpToken> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const found = await discover(options.mcpUrl, fetchImpl);
  const verifier = b64u(crypto.randomBytes(32));
  const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
  const state = b64u(crypto.randomBytes(16));

  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  try {
    const registration = await json(await fetchImpl(found.registrationEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
      body: JSON.stringify({
        client_name: 'jace-commander-cli',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'none',
      }),
    }));
    const clientId = String(registration.client_id ?? '');
    if (!clientId) throw new Error('client registration failed');

    const authorize = new URL(found.authorizationEndpoint);
    for (const [key, value] of Object.entries({
      response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: 'mcp',
      state, code_challenge: challenge, code_challenge_method: 'S256', resource: found.resource,
    })) authorize.searchParams.set(key, value);

    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('login timed out waiting for browser approval')), options.timeoutMs ?? 300_000);
      server.on('request', (req, res) => {
        const url = new URL(req.url ?? '/', redirectUri);
        if (url.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }
        const ok = url.searchParams.get('state') === state && url.searchParams.get('code');
        res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain' });
        res.end(ok ? 'Jace Commander CLI connected. You can close this tab.' : 'Login failed.');
        clearTimeout(timer);
        if (ok) resolve(String(url.searchParams.get('code')));
        else reject(new Error(url.searchParams.get('error') ?? 'state mismatch or missing code'));
      });
      options.onAuthorizeUrl(authorize.toString());
    });

    const token = await json(await fetchImpl(found.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri,
        client_id: clientId, resource: found.resource,
      }).toString(),
    }));
    if (typeof token.access_token !== 'string') throw new Error(`token exchange failed: ${String(token.error ?? 'unknown')}`);
    const stored: StoredMcpToken = {
      mcpUrl: found.resource,
      clientId,
      accessToken: token.access_token,
      ...(typeof token.refresh_token === 'string' ? { refreshToken: token.refresh_token } : {}),
      expiresAt: Date.now() + Number(token.expires_in ?? 3600) * 1000,
    };
    saveMcpToken(options.stateDir, stored);
    return stored;
  } finally {
    server.close();
  }
}

/**
 * What a caller can learn about its credential. The distinction matters: only `reauth_required` means the user has to
 * sign in again. `unavailable` (network down, edge down, 5xx, timeout) keeps the stored credential and can simply be
 * retried; treating it as expired would make every outage look like a revoked connection.
 */
export type McpTokenOutcome =
  | { kind: 'token'; accessToken: string }
  | { kind: 'not_connected' }
  | { kind: 'reauth_required'; reason: 'no_refresh_token' | 'refresh_rejected' | 'invalid_client' }
  | { kind: 'unavailable'; reason: string };

/** OAuth errors that mean the refresh token or client will never work again (RFC 6749 section 5.2). */
const PERMANENT_REFRESH_ERRORS = new Map<string, 'refresh_rejected' | 'invalid_client'>([
  ['invalid_grant', 'refresh_rejected'],
  ['invalid_client', 'invalid_client'],
  ['unauthorized_client', 'invalid_client'],
]);

/** In-flight refreshes keyed by `${stateDir}::${mcpUrl}`; single-flight dedupe. */
const refreshInFlight = new Map<string, Promise<McpTokenOutcome>>();

/**
 * The bearer token for `mcpUrl`: JC_MCP_TOKEN, else the stored token (refreshed when within 60 s of expiry).
 * A stored token for a different /jc/mcp URL is never sent (it is audience-bound to its own resource).
 */
export async function mcpAccessTokenOutcome(
  mcpUrl: string,
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<McpTokenOutcome> {
  if (env.JC_MCP_TOKEN) return { kind: 'token', accessToken: env.JC_MCP_TOKEN };
  const stored = loadMcpToken(stateDir);
  if (!stored || stored.mcpUrl !== mcpUrl.replace(/\/$/, '')) return { kind: 'not_connected' };
  if (stored.reauthRequired) return { kind: 'reauth_required', reason: stored.reauthRequired.reason };
  if (stored.expiresAt - Date.now() > 60_000) return { kind: 'token', accessToken: stored.accessToken };
  if (!stored.refreshToken) return { kind: 'reauth_required', reason: 'no_refresh_token' };
  const refreshToken = stored.refreshToken;
  // Single-flight: concurrent callers that all see an expired token share one
  // refresh. Otherwise each POSTs /token and the last write wins; if the issuer
  // rotates refresh tokens an earlier rotation is invalidated, forcing a full
  // re-login on the next call.
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
          grant_type: 'refresh_token', refresh_token: refreshToken, client_id: stored.clientId, resource: found.resource,
        }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
      token = await json(response);
    } catch (error) {
      // Network error, timeout, unparseable body: no verdict was reached. The credential is untouched.
      return { kind: 'unavailable', reason: error instanceof Error ? error.message : 'refresh failed' };
    }
    if (typeof token.access_token === 'string' && response.ok) {
      const refreshed: StoredMcpToken = {
        ...stored,
        accessToken: token.access_token,
        ...(typeof token.refresh_token === 'string' ? { refreshToken: token.refresh_token } : {}),
        expiresAt: Date.now() + Number(token.expires_in ?? 3600) * 1000,
      };
      saveMcpToken(stateDir, refreshed);
      return { kind: 'token', accessToken: refreshed.accessToken };
    }
    const permanent = response.status >= 400 && response.status < 500 && typeof token.error === 'string'
      ? PERMANENT_REFRESH_ERRORS.get(token.error)
      : undefined;
    if (permanent) {
      // Compare-and-swap: another process sharing this state directory may have refreshed (and rotated) in the meantime.
      // Its token is good and ours was rejected only because it was already spent, so do not overwrite its credential.
      const current = loadMcpToken(stateDir);
      if (current && current.refreshToken !== refreshToken) {
        return current.expiresAt - Date.now() > 60_000
          ? { kind: 'token', accessToken: current.accessToken }
          : { kind: 'unavailable', reason: 'credential was refreshed by another process; retry' };
      }
      // Remember the verdict so every later call (and a status check) says "reconnect" without another round trip.
      const { refreshToken: _dead, ...rest } = stored;
      saveMcpToken(stateDir, { ...rest, reauthRequired: { reason: permanent, at: new Date().toISOString() } });
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

/** The bearer token, or undefined when there is none to send. Prefer {@link mcpAccessTokenOutcome} to learn why. */
export async function mcpAccessToken(
  mcpUrl: string,
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  const outcome = await mcpAccessTokenOutcome(mcpUrl, stateDir, env, fetchImpl);
  return outcome.kind === 'token' ? outcome.accessToken : undefined;
}
