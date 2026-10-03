import { createClient } from '@supabase/supabase-js';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { ControlPlaneError, ControlPlaneService } from './service.js';
import { SupabaseControlPlaneStore } from './supabase-store.js';
import {
  createPairingResponse,
  DEFAULT_PAIRING_TTL_SECONDS,
  PAIRING_CODE_TTL_SECONDS,
  PairingSession,
  PairingStore,
  SupabasePairingStore,
} from './pairing-store.js';
import {
  decryptPairingCode,
  encryptPairingCode,
  newStateNonce,
  PairingKeys,
  pairingKeysFromEnv,
  pkceMatches,
  sha256Base64Url,
  signPairingState,
  verifyPairingState,
} from './pairing-crypto.js';
import { McpHandler, McpOptions } from './mcp.js';
import { sendConsentPage, sendMessagePage, supabaseBrowserBundle } from './pages.js';

const bodyLimit = 72 * 1024;
const registrationSchema = z.object({
  device_id: z.string().uuid().optional(),
  device_name: z.string().min(1).max(128),
  capabilities: z.record(z.string(), z.unknown()),
}).strict();
const updateSchema = z.object({
  device_name: z.string().min(1).max(128).optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
}).strict().refine((value) => Object.keys(value).length > 0);
const dispatchSchema = z.object({
  tool_name: z.string().min(1).max(128),
  arguments: z.record(z.string(), z.unknown()),
  metadata: z.record(z.string(), z.unknown()).optional(),
  idempotency_key: z.string().min(1).max(128),
}).strict();
const deviceStartSchema = z.object({
  client_id: z.literal('mcp-device'),
  scope: z.literal('mcp:tools'),
  device_name: z.string().min(1).max(128),
  device_type: z.literal('mcp'),
  device_id: z.string().uuid().optional(),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code_challenge_method: z.literal('S256'),
}).strict();
const devicePollSchema = z.object({
  session_id: z.string().min(32).max(512).optional(),
  device_code: z.string().min(32).max(512).optional(),
  client_id: z.literal('mcp-device'),
  code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
}).strict().refine((value) => Boolean(value.session_id || value.device_code), { message: 'session_id or device_code is required' });

export interface Environment {
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  SUPABASE_SECRET_KEY: string;
  DEVICE_OAUTH_CLIENT_ID: string;
  PAIRING_STATE_KEY: string;
  PAIRING_CODE_KEY: string;
  CONTROL_PLANE_URL: string;
  /** Optional comma-separated allowlist of OAuth client_ids that may use /mcp. Unset = any non-device OAuth client. */
  MCP_ALLOWED_CLIENT_IDS?: string;
  PORT?: string;
  HOST?: string;
}
interface AuthContext { userId: string; token: string; sessionId: string; clientId: string | null; }
type AuthenticateRequest = (req: IncomingMessage, config: Environment) => Promise<AuthContext>;

function env(): Environment {
  const required = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY', 'DEVICE_OAUTH_CLIENT_ID', 'PAIRING_STATE_KEY', 'PAIRING_CODE_KEY', 'CONTROL_PLANE_URL'] as const;
  for (const name of required) if (!process.env[name]) throw new Error(`Missing ${name}`);
  return process.env as unknown as Environment;
}
async function json(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const data = Buffer.from(chunk);
    total += data.length;
    if (total > bodyLimit) throw new ControlPlaneError('invalid_request', 'request body too large');
    chunks.push(data);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ControlPlaneError('invalid_request', 'invalid JSON'); }
}
function send(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}
/**
 * Path prefix of CONTROL_PLANE_URL (e.g. "/relay"), or "" at the origin root.
 * Tailscale Funnel path mounts strip the prefix before proxying, so requests
 * normally arrive un-prefixed; a prefixed path (direct or other proxy) is
 * accepted too. Only an exact segment match counts: "/relayx" is not "/relay".
 */
export function basePath(config: Pick<Environment, 'CONTROL_PLANE_URL'>): string {
  return new URL(config.CONTROL_PLANE_URL).pathname.replace(/\/+$/, '');
}
export function routePath(pathname: string, prefix: string): string {
  if (prefix && (pathname === prefix || pathname.startsWith(`${prefix}/`))) return pathname.slice(prefix.length) || '/';
  return pathname;
}
function pathParts(url: string, prefix: string): string[] { return routePath(new URL(url, 'http://localhost').pathname, prefix).split('/').filter(Boolean); }
function decodeClaims(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new ControlPlaneError('not_found', 'not found');
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid claims');
    return parsed as Record<string, unknown>;
  } catch { throw new ControlPlaneError('not_found', 'not found'); }
}
async function authenticate(req: IncomingMessage, config: Environment): Promise<AuthContext> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new ControlPlaneError('not_found', 'not found');
  const token = header.slice(7).trim();
  if (!token || token.length > 8192) throw new ControlPlaneError('not_found', 'not found');

  const publicClient = createClient(config.SUPABASE_URL, config.SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await publicClient.auth.getUser(token);
  if (error || !data.user) throw new ControlPlaneError('not_found', 'not found');

  // Decode only after Auth has cryptographically validated the token.
  const claims = decodeClaims(token);
  const sessionId = typeof claims.session_id === 'string' ? claims.session_id : null;
  const clientId = typeof claims.client_id === 'string' ? claims.client_id : null;
  if (!sessionId || claims.sub !== data.user.id) throw new ControlPlaneError('not_found', 'not found');

  const serverClient = createClient(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data: active, error: activeError } = await serverClient.rpc('control_plane_auth_session_active_server', {
    p_user_id: data.user.id,
    p_session_id: sessionId,
  });
  if (activeError || active !== true) throw new ControlPlaneError('not_found', 'not found');
  return { userId: data.user.id, token, sessionId, clientId };
}
function defaultServiceFor(config: Environment, auth: AuthContext): ControlPlaneService {
  const store = new SupabaseControlPlaneStore({
    supabaseUrl: config.SUPABASE_URL,
    publishableKey: config.SUPABASE_PUBLISHABLE_KEY,
    serverSecretKey: config.SUPABASE_SECRET_KEY,
    accessToken: auth.token,
  });
  return new ControlPlaneService(store);
}
function errorResponse(res: ServerResponse, error: unknown): void {
  if (error instanceof ControlPlaneError) {
    const status = error.code === 'not_found' ? 404 : error.code === 'device_unavailable' || error.code === 'conflict' ? 409 : 400;
    return send(res, status, { error: error.code });
  }
  if (error instanceof z.ZodError) return send(res, 400, { error: 'invalid_request' });
  console.error(JSON.stringify({ event: 'control_plane_request_failed', error_type: error instanceof Error ? error.name : 'unknown' }));
  send(res, 500, { error: 'internal_error' });
}

function controlPlaneUrl(config: Environment): string { return config.CONTROL_PLANE_URL.replace(/\/$/, ''); }
function deviceRedirectUri(config: Environment): string { return `${controlPlaneUrl(config)}/device/callback`; }
function protectedResourceMetadataUrl(config: Environment): string { return `${controlPlaneUrl(config)}/.well-known/oauth-protected-resource`; }

/** The fixed own-relay discovery contract. The device gates OAuth-relay mode on it. */
export function mcpInfo(config: Environment): Record<string, unknown> {
  return {
    supabaseUrl: config.SUPABASE_URL,
    supabasePublishableKey: config.SUPABASE_PUBLISHABLE_KEY,
    controlPlaneVersion: 1,
    deviceAuthMode: 'supabase_oauth_pkce',
    oauthClientId: config.DEVICE_OAUTH_CLIENT_ID,
    oauthRedirectUri: deviceRedirectUri(config),
    deviceRegistrationEndpoint: '/api/devices/register',
    deviceTopicFormat: 'user:{user_id}:device:{device_id}',
  };
}
export function protectedResourceMetadata(config: Environment): Record<string, unknown> {
  return {
    resource: `${controlPlaneUrl(config)}/mcp`,
    authorization_servers: [`${config.SUPABASE_URL.replace(/\/$/, '')}/auth/v1`],
    bearer_methods_supported: ['header'],
  };
}
/**
 * /mcp is for OAuth clients such as Claude. Plain Supabase session tokens (no
 * client_id claim) and the device pairing client's own tokens are refused, so
 * a leaked device token cannot drive other devices through /mcp.
 */
export function mcpClientAllowed(config: Pick<Environment, 'DEVICE_OAUTH_CLIENT_ID' | 'MCP_ALLOWED_CLIENT_IDS'>, clientId: string | null): boolean {
  if (!clientId) return false;
  if (clientId === config.DEVICE_OAUTH_CLIENT_ID) return false;
  const allowlist = (config.MCP_ALLOWED_CLIENT_IDS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  return allowlist.length === 0 || allowlist.includes(clientId);
}

export function authorizeUrl(config: Environment, session: PairingSession, state: string): string {
  const url = new URL(`${config.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/oauth/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.DEVICE_OAUTH_CLIENT_ID);
  url.searchParams.set('redirect_uri', deviceRedirectUri(config));
  url.searchParams.set('code_challenge', session.code_challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  return url.toString();
}

export interface AccessLogEntry {
  event: 'http';
  method: string;
  /** Pathname only. Query strings (OAuth code/state, session_id) are never logged. */
  path: string;
  status: number;
  duration_ms: number;
  user_agent: string;
}
function defaultAccessLog(entry: AccessLogEntry): void { console.log(JSON.stringify(entry)); }

export interface ControlPlaneServerOptions {
  /** Access log sink; defaults to one JSON line per request on stdout (journal). */
  accessLog?: (entry: AccessLogEntry) => void;
  pairingStore?: PairingStore;
  authenticate?: AuthenticateRequest;
  serviceFor?: (config: Environment, auth: AuthContext) => ControlPlaneService;
  mcp?: McpOptions;
}

export function createControlPlaneServer(config = env(), options: ControlPlaneServerOptions = {}) {
  const keys: PairingKeys = pairingKeysFromEnv(config);
  const pairingStore = options.pairingStore ?? new SupabasePairingStore({ supabaseUrl: config.SUPABASE_URL, serverSecretKey: config.SUPABASE_SECRET_KEY });
  const authenticateRequest = options.authenticate ?? authenticate;
  const serviceFor = options.serviceFor ?? defaultServiceFor;
  const mcp = new McpHandler(options.mcp);

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
    let auth: AuthContext;
    try { auth = await authenticateRequest(req, config); }
    catch (error) {
      if (!(error instanceof ControlPlaneError)) throw error;
      const tokenPresent = Boolean(req.headers.authorization);
      const challenge = `Bearer resource_metadata="${protectedResourceMetadataUrl(config)}"${tokenPresent ? ', error="invalid_token"' : ''}`;
      return send(res, 401, { error: 'unauthorized' }, { 'www-authenticate': challenge });
    }
    if (!mcpClientAllowed(config, auth.clientId)) {
      return send(res, 403, { error: 'client_not_permitted' }, {
        'www-authenticate': `Bearer resource_metadata="${protectedResourceMetadataUrl(config)}", error="insufficient_scope", error_description="this OAuth client may not use /mcp"`,
      });
    }
    const message = await json(req);
    if (Array.isArray(message)) return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batching is not supported' } });
    const response = await mcp.handle(message, auth.userId, serviceFor(config, auth));
    if (!response) { res.writeHead(202, { 'cache-control': 'no-store' }); res.end(); return; }
    send(res, 200, response);
  }

  const accessLog = options.accessLog ?? defaultAccessLog;
  const prefix = basePath(config);
  return createServer(async (req, res) => {
    const started = process.hrtime.bigint();
    res.once('finish', () => {
      let path: string;
      try { path = new URL(req.url ?? '/', 'http://localhost').pathname; } catch { path = '<unparseable>'; }
      try {
        accessLog({
          event: 'http',
          method: req.method ?? '-',
          path: path.slice(0, 256),
          status: res.statusCode,
          duration_ms: Math.round(Number(process.hrtime.bigint() - started) / 1e5) / 10,
          user_agent: String(req.headers['user-agent'] ?? '-').slice(0, 200),
        });
      } catch { /* logging must never affect the response */ }
    });
    try {
      const parts = pathParts(req.url ?? '/', prefix);
      const joined = parts.join('/');
      const requestUrl = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && joined === 'api/mcp-info') return send(res, 200, mcpInfo(config));
      if (req.method === 'GET' && (joined === '.well-known/oauth-protected-resource' || joined === '.well-known/oauth-protected-resource/mcp')) {
        return send(res, 200, protectedResourceMetadata(config));
      }
      if (joined === 'mcp') return await handleMcp(req, res);
      if (req.method === 'GET' && joined === 'static/supabase.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff' });
        res.end(supabaseBrowserBundle());
        return;
      }
      if (req.method === 'GET' && joined === 'oauth/consent') return sendConsentPage(res, config.SUPABASE_URL, config.SUPABASE_PUBLISHABLE_KEY, prefix);

      if (req.method === 'POST' && joined === 'device/start') {
        const input = deviceStartSchema.parse(await json(req));
        const session = await pairingStore.create({ device_name: input.device_name, device_id: input.device_id, code_challenge: input.code_challenge, expires_in: DEFAULT_PAIRING_TTL_SECONDS });
        return send(res, 200, createPairingResponse(controlPlaneUrl(config), session));
      }
      if (req.method === 'GET' && joined === 'add-device') {
        const sessionId = requestUrl.searchParams.get('session_id');
        const session = sessionId && sessionId.length <= 512 ? await pairingStore.get(sessionId) : null;
        if (!session) return sendMessagePage(res, 404, 'Pairing not found', 'Start pairing again from your device.');
        const nonce = newStateNonce();
        if (session.state !== 'PENDING' || !(await pairingStore.setStateNonce(session.session_id, sha256Base64Url(nonce)))) {
          return sendMessagePage(res, 410, 'Pairing expired', 'This pairing link is no longer valid. Start pairing again from your device.');
        }
        res.writeHead(302, { location: authorizeUrl(config, session, signPairingState(keys.stateKey, session.session_id, nonce)), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
        res.end();
        return;
      }
      if (req.method === 'GET' && joined === 'device/callback') {
        const state = verifyPairingState(keys.stateKey, requestUrl.searchParams.get('state'));
        if (!state) return sendMessagePage(res, 400, 'Pairing failed', 'This authorization response is not valid.');
        const nonceHash = sha256Base64Url(state.nonce);
        if (requestUrl.searchParams.has('error')) {
          await pairingStore.reject(state.sessionId, nonceHash);
          return sendMessagePage(res, 200, 'Pairing cancelled', 'Access was not granted. You can close this window.');
        }
        const code = requestUrl.searchParams.get('code');
        if (!code || code.length > 2048) return sendMessagePage(res, 400, 'Pairing failed', 'The authorization response did not include a code.');
        const outcome = await pairingStore.storeCode(state.sessionId, nonceHash, encryptPairingCode(keys.codeKey, state.sessionId, code), PAIRING_CODE_TTL_SECONDS);
        if (outcome === 'verified') return sendMessagePage(res, 200, 'Device authorized', 'Return to your device; it will finish pairing automatically. You can close this window.');
        if (outcome === 'rejected') return sendMessagePage(res, 409, 'Pairing cancelled', 'This authorization was already used, so pairing was cancelled for safety. Start again from your device.');
        if (outcome === 'expired') return sendMessagePage(res, 410, 'Pairing expired', 'Start pairing again from your device.');
        return sendMessagePage(res, 400, 'Pairing failed', 'This authorization response is not valid.');
      }
      if (req.method === 'POST' && joined === 'device/poll') {
        const input = devicePollSchema.parse(await json(req));
        const session = input.session_id ? await pairingStore.get(input.session_id) : await pairingStore.findByDeviceCode(input.device_code!);
        if (!session || (input.session_id && input.device_code && session.device_code !== input.device_code)) return send(res, 404, { error: 'invalid_grant' });
        // PKCE (S256) is checked before any state is read or changed.
        if (!pkceMatches(input.code_verifier, session.code_challenge)) return send(res, 400, { error: 'invalid_grant' });
        const result = await pairingStore.consume(session.session_id);
        if (result.kind === 'code') {
          const authorizationCode = decryptPairingCode(keys.codeKey, session.session_id, result.sealed_code);
          if (!authorizationCode) return send(res, 400, { error: 'invalid_grant' });
          return send(res, 200, { authorization_code: authorizationCode, redirect_uri: deviceRedirectUri(config), ...(result.device_id ? { device_id: result.device_id } : {}) });
        }
        if (result.kind === 'pending') return send(res, 400, { error: 'authorization_pending' });
        if (result.kind === 'expired') return send(res, 400, { error: 'expired_token' });
        if (result.kind === 'rejected') return send(res, 400, { error: 'access_denied' });
        return send(res, 400, { error: 'invalid_grant' });
      }

      const auth = await authenticateRequest(req, config);
      const service = serviceFor(config, auth);

      if (req.method === 'POST' && joined === 'api/devices/register') {
        if (auth.clientId !== config.DEVICE_OAUTH_CLIENT_ID) throw new ControlPlaneError('not_found', 'not found');
        const input = registrationSchema.parse(await json(req));
        // Idempotent per auth session: a session owns at most one live device
        // binding, so a retry (e.g. after a failed first register that never
        // returned the id) gets that device back instead of a second row.
        let deviceId = (await service.deviceBoundToSession(auth.userId, auth.sessionId)) ?? input.device_id;
        if (deviceId) {
          const existing = await service.getDevice(auth.userId, deviceId);
          if (existing.revoked) throw new ControlPlaneError('device_unavailable', 'revoked device requires a new authorization');
          await service.updateDevice(auth.userId, deviceId, { device_name: input.device_name, capabilities: input.capabilities });
        } else {
          const created = await service.registerDevice(auth.userId, { device_name: input.device_name, capabilities: input.capabilities });
          deviceId = created.id;
        }
        await service.bindDeviceSession(auth.userId, deviceId, auth.sessionId);
        return send(res, 200, await service.getDevice(auth.userId, deviceId));
      }
      if (req.method === 'GET' && joined === 'api/devices') return send(res, 200, { devices: await service.listDevices(auth.userId) });
      if (parts[0] === 'api' && parts[1] === 'devices' && parts.length >= 3) {
        const id = parts[2];
        if (req.method === 'GET' && parts.length === 3) return send(res, 200, await service.getDevice(auth.userId, id));
        if (req.method === 'PATCH' && parts.length === 3) return send(res, 200, await service.updateDevice(auth.userId, id, updateSchema.parse(await json(req))));
        if (req.method === 'POST' && parts.length === 4 && parts[3] === 'revoke') return send(res, 200, await service.revokeDevice(auth.userId, id));
        if (req.method === 'POST' && parts.length === 4 && parts[3] === 'dispatch') return send(res, 202, await service.dispatch(auth.userId, id, dispatchSchema.parse(await json(req))));
        if (req.method === 'GET' && parts.length === 5 && parts[3] === 'calls') return send(res, 200, await service.getCall(auth.userId, id, parts[4]));
      }
      send(res, 404, { error: 'not_found' });
    } catch (error) { errorResponse(res, error); }
  });
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const config = env();
  const port = Number(config.PORT ?? 3100);
  if (port === 3000) throw new Error('Port 3000 belongs to acs-gateway; use PORT=3100');
  createControlPlaneServer(config).listen(port, config.HOST ?? '127.0.0.1', () => console.log(`control-plane listening on ${config.HOST ?? '127.0.0.1'}:${port}`));
}
