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
  const prm = await json(await fetchImpl(`${url.origin}/.well-known/oauth-protected-resource${url.pathname}`));
  const resource = String(prm.resource ?? '');
  if (resource !== mcpUrl.replace(/\/$/, '')) throw new Error(`protected-resource metadata names ${resource}, not ${mcpUrl}`);
  const issuer = Array.isArray(prm.authorization_servers) ? String(prm.authorization_servers[0]) : url.origin;
  const as = await json(await fetchImpl(`${issuer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`));
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
 * The bearer token for `mcpUrl`: JC_MCP_TOKEN, else the stored token
 * (refreshed when within 60 s of expiry). A stored token for a different
 * /jc/mcp URL is never sent (it is audience-bound to its own resource).
 */
export async function mcpAccessToken(
  mcpUrl: string,
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  if (env.JC_MCP_TOKEN) return env.JC_MCP_TOKEN;
  const stored = loadMcpToken(stateDir);
  if (!stored || stored.mcpUrl !== mcpUrl.replace(/\/$/, '')) return undefined;
  if (stored.expiresAt - Date.now() > 60_000) return stored.accessToken;
  if (!stored.refreshToken) return undefined;
  try {
    const found = await discover(mcpUrl, fetchImpl);
    const token = await json(await fetchImpl(found.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: stored.refreshToken, client_id: stored.clientId, resource: found.resource,
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    }));
    if (typeof token.access_token !== 'string') return undefined;
    const refreshed: StoredMcpToken = {
      ...stored,
      accessToken: token.access_token,
      ...(typeof token.refresh_token === 'string' ? { refreshToken: token.refresh_token } : {}),
      expiresAt: Date.now() + Number(token.expires_in ?? 3600) * 1000,
    };
    saveMcpToken(stateDir, refreshed);
    return refreshed.accessToken;
  } catch {
    return undefined;
  }
}
