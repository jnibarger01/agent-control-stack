#!/usr/bin/env node
/**
 * desktop-commander-mcp-gateway
 *
 * Single-purpose production edge for the Desktop Commander MCP server:
 *   - OAuth 2.1 authorization server (PKCE S256, DCR + CIMD, RFC 8707 resource binding)
 *   - OAuth 2.0 Protected Resource Metadata (RFC 9728) + AS metadata (RFC 8414)
 *   - Authenticating reverse proxy:  /mcp  ->  http://127.0.0.1:8002/mcp
 *
 * Zero runtime dependencies (node:http / node:crypto only). Fails closed.
 * Never logs bearer tokens, codes, or MCP tool arguments.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClientInfoCache, createClientObserver, extractClientInfo } from './client-attribution.js';
import { managedModeFromEnv, jcModeFromEnv, identityAttribution, capabilityTransport, acsPost, isToolsCall, dcRuntimeIdentityFromState, issueRuntimeBootstrap, completeRuntimeBootstrap, injectRuntimeBootstrap } from './managed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Configuration (from protected env file; no secrets inline)
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.GATEWAY_PORT || '8010', 10);
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || ''; // e.g. https://jacen-ubuntu.tailaa6d41.ts.net
const RESOURCE = process.env.RESOURCE || `${PUBLIC_ORIGIN}/mcp`;
const ISSUER = process.env.ISSUER || PUBLIC_ORIGIN;
const UPSTREAM = process.env.UPSTREAM || 'http://127.0.0.1:8002';
// Jace Commander lane (/jc/mcp): its own OAuth audience and its own bridge.
const JC_RESOURCE = process.env.JC_RESOURCE || `${PUBLIC_ORIGIN}/jc/mcp`;
const JC_ISSUER = process.env.JC_ISSUER || `${PUBLIC_ORIGIN}/jc`;
const JC_UPSTREAM = process.env.JC_UPSTREAM || 'http://127.0.0.1:8003';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CONSENT_PASSPHRASE = process.env.CONSENT_PASSPHRASE || '';
const SIGNING_KEY = process.env.SIGNING_KEY || ''; // hex
const GATEWAY_EXECUTION_TOKEN = process.env.GATEWAY_EXECUTION_TOKEN || ''; // optional; enables executor identity attestation
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 30 * 24 * 3600;
const CODE_TTL_S = 300;
const MAX_BODY = 2 * 1024 * 1024; // 2 MB
const rawInitializeAcsTimeout = Number.parseInt(process.env.MCP_INITIALIZE_ACS_TIMEOUT_MS || "400", 10);
const MCP_INITIALIZE_ACS_TIMEOUT_MS = Number.isFinite(rawInitializeAcsTimeout)
  ? Math.max(100, Math.min(rawInitializeAcsTimeout, 750))
  : 400;
const rawInitializeUpstreamTimeout = Number.parseInt(process.env.MCP_INITIALIZE_UPSTREAM_TIMEOUT_MS || "1200", 10);
const MCP_INITIALIZE_UPSTREAM_TIMEOUT_MS = Number.isFinite(rawInitializeUpstreamTimeout)
  ? Math.max(250, Math.min(rawInitializeUpstreamTimeout, 1900))
  : 1200;

for (const [k, v] of Object.entries({ PUBLIC_ORIGIN, CONSENT_PASSPHRASE, SIGNING_KEY })) {
  if (!v) { console.error(`gateway: missing required env ${k}; refusing to start`); process.exit(1); }
}
const NATIVE_RUNTIME_BOOTSTRAP = process.env.ACS_NATIVE_RUNTIME_BOOTSTRAP === '1';
let MANAGED = { enabled: false };
try {
  MANAGED = managedModeFromEnv();
  if (MANAGED.enabled) console.log('gateway: ACS MANAGED MODE enabled (capabilities issued by ACS only; no standalone fallback)');
} catch (e) {
  console.error(`gateway: ${e.message}`);
  process.exit(1);
}
let JC = { enabled: false };
try {
  JC = jcModeFromEnv();
  // Equal resources would make /mcp and /jc/mcp accept each other's tokens.
  if (JC.enabled && JC_RESOURCE === RESOURCE) throw new Error('JC_RESOURCE must differ from RESOURCE; refusing to start');
  if (JC.enabled && JC_ISSUER === ISSUER) throw new Error('JC_ISSUER must differ from ISSUER; refusing to start');
  if (JC.enabled) console.log(`gateway: Jace Commander lane enabled at /jc/mcp (resource=${JC_RESOURCE}; ACS-managed only)`);
} catch (e) {
  console.error(`gateway: ${e.message}`);
  process.exit(1);
}
// RFC 8707: each OAuth surface is bound to exactly one protected resource.
// The JC issuer advertises root physical endpoints with an explicit lane hint
// so hosted clients do not need path-specific DCR support.
if (!GATEWAY_EXECUTION_TOKEN) console.log('gateway: GATEWAY_EXECUTION_TOKEN not set; executor identity attestation disabled (log-once)');
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

const META = {
  resource: RESOURCE,
  authorization_servers: [ISSUER],
  scopes_supported: ['mcp'],
};
const JC_META = {
  resource: JC_RESOURCE,
  authorization_servers: [JC_ISSUER],
  scopes_supported: ['mcp'],
};

const DC_OAUTH_LANE = Object.freeze({
  name: 'dc', issuer: ISSUER, resource: RESOURCE, consentPath: '/authorize/consent',
});
const JC_OAUTH_LANE = Object.freeze({
  name: 'jc', issuer: JC_ISSUER, resource: JC_RESOURCE, consentPath: '/authorize/consent',
});

const oauthEndpoint = (pathname, lane) => {
  const u = new URL(pathname, ISSUER);
  if (lane.name === 'jc') {
    u.searchParams.set('oauth_lane', 'jc');
    u.searchParams.set('resource', lane.resource);
  }
  return u.toString();
};

const oauthMeta = (lane) => ({
  issuer: lane.issuer,
  authorization_endpoint: oauthEndpoint('/authorize', lane),
  token_endpoint: oauthEndpoint('/token', lane),
  registration_endpoint: oauthEndpoint('/register', lane),
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
  scopes_supported: ['mcp'],
  client_id_metadata_document_supported: true,
  authorization_response_iss_parameter_supported: true,
  resource: lane.resource,
  service_documentation: `${PUBLIC_ORIGIN}/`,
});
const AS_META = () => oauthMeta(DC_OAUTH_LANE);
const JC_AS_META = () => oauthMeta(JC_OAUTH_LANE);

function laneForGrant(grant) {
  if (!grant) return null;
  if (grant.resource === RESOURCE && grant.issuer === ISSUER) return DC_OAUTH_LANE;
  if (grant.resource === JC_RESOURCE && grant.issuer === JC_ISSUER) return JC_OAUTH_LANE;
  return null;
}

function laneForClientResource(client, resource) {
  if (resource === JC_RESOURCE) return JC_OAUTH_LANE;
  if (resource === RESOURCE) return DC_OAUTH_LANE;
  if (resource) return null;
  return client?.oauth_lane === 'jc' ? JC_OAUTH_LANE : DC_OAUTH_LANE;
}

// ---------------------------------------------------------------------------
// Persistence: registered clients + refresh tokens (rotated). 0600 files.
// ---------------------------------------------------------------------------
const clientsFile = path.join(DATA_DIR, 'clients.json');
const tokensFile = path.join(DATA_DIR, 'tokens.json');
const loadJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const saveJson = (f, o) => { fs.writeFileSync(f, JSON.stringify(o, null, 2), { mode: 0o600 }); };
const clients = loadJson(clientsFile, {});   // client_id -> {redirect_uris, scope, token_endpoint_auth_method, client_secret?}
const refreshTokens = loadJson(tokensFile, {}); // jti -> {client_id, exp, active}
const cimdCache = new Map();                  // client_id URL -> metadata doc

// ---------------------------------------------------------------------------
// JWT (HS256) helpers
// ---------------------------------------------------------------------------
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const signJwt = (payload) => {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SIGNING_KEY).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
};
const verifyJwt = (token) => {
  try {
    const [h, p, sig] = token.split('.');
    if (!h || !p || !sig) return null;
    const expect = crypto.createHmac('sha256', SIGNING_KEY).update(`${h}.${p}`).digest('base64url');
    const a = Buffer.from(sig); const b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
};
const randId = () => crypto.randomBytes(24).toString('base64url');

// ---- Client attribution (visibility only; never authority) ----
// clientInfo from a client's `initialize` is cached so its later tools/call can carry it to ACS, and each
// verified client connection is reported to ACS so Mission Control can show who is on the lane.
const clientInfoCache = new ClientInfoCache();
const observers = new Map();
function observerFor(lane, managed) {
  if (!managed || !managed.enabled) return null;
  let observer = observers.get(lane);
  if (!observer) {
    const reporting = { ...managed, timeoutMs: Math.min(managed.timeoutMs || 1500, 1500) };
    observer = createClientObserver({
      post: (route, payload) => acsPost(reporting, route, payload),
      onError: (error) => console.warn(`gateway: client observation (${lane}) failed: ${error && error.message ? error.message : 'error'}`),
    });
    observers.set(lane, observer);
  }
  return observer;
}
/**
 * Record what this request tells us about the caller and return the claims to forward on a tools/call.
 * Fire-and-forget: it can never delay, alter or fail the request.
 */
function noteClient(lane, managed, auth, req, parsed) {
  try {
    const identity = identityAttribution(auth);
    if (!identity || !identity.clientId || !identity.subject) return undefined;
    const key = `${lane}|${identity.clientId}|${identity.subject}`;
    const method = parsed && !Array.isArray(parsed) && typeof parsed.method === 'string' ? parsed.method : '';
    if (method === 'initialize') clientInfoCache.set(key, extractClientInfo(parsed));
    const info = clientInfoCache.get(key);
    const ua = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined;
    const claims = { ...(info || {}), ...(ua ? { userAgent: ua } : {}) };
    const observer = observerFor(lane, managed);
    if (observer && req.method === 'POST') void observer.observe({ lane, identity, method, claims });
    return claims;
  } catch {
    return undefined;
  }
}
const now = () => Math.floor(Date.now() / 1000);

// Per-request identity attestation for the executor (bridge): base64url(JSON
// payload) + '.' + HMAC-SHA256(GATEWAY_EXECUTION_TOKEN, base64url-part).
// Short-lived (60s), minted fresh on every authorized /mcp request.
function mintAttestation(payload) {
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', GATEWAY_EXECUTION_TOKEN).update(body).digest('base64url');
  return `${body}.${sig}`;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Cache-Control': 'no-store',
};

function send(res, status, body, headers = {}) {
  const h = { ...SECURITY_HEADERS, ...headers };
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    h['Content-Length'] = Buffer.byteLength(body);
    res.writeHead(status, h); res.end(body);
  } else {
    const b = JSON.stringify(body);
    h['Content-Type'] = 'application/json; charset=utf-8';
    h['Content-Length'] = Buffer.byteLength(b);
    res.writeHead(status, h); res.end(b);
  }
}
const redirect = (res, url) => send(res, 302, '', { Location: url });
const jsonError = (res, status, code, desc, extraHeaders = {}) =>
  send(res, status, { error: code, error_description: desc }, extraHeaders);

const MANAGED_TOOL_ERRORS = Object.freeze({
  denied: Object.freeze({ code: -32001, kind: 'managed_authorization_denied', retryable: false }),
  required: Object.freeze({ code: -32002, kind: 'managed_authorization_required', retryable: true }),
  unavailable: Object.freeze({ code: -32003, kind: 'managed_authorization_unavailable', retryable: true }),
});

function managedToolErrorResponse(parsed, failure) {
  const acsCode = failure && typeof failure.acsCode === 'string' ? failure.acsCode : 'managed_fail_closed';
  const acsDecision = failure && typeof failure.acsDecision === 'string' ? failure.acsDecision : null;
  // ACS `decision` is authoritative per docs/protocol/dc-authorization-arguments.md:
  // a deny stays a denial (-32001) even if the body carries a conflicting code,
  // and a stray 'require_approval' code without a require_approval decision is
  // malformed (-32003), not an approval challenge.
  const shape = acsDecision === 'require_approval'
    ? MANAGED_TOOL_ERRORS.required
    : acsDecision === 'deny'
      ? MANAGED_TOOL_ERRORS.denied
      : MANAGED_TOOL_ERRORS.unavailable;
  const details = {
    kind: shape.kind,
    acsCode,
    retryable: shape.retryable,
  };
  const sources = [failure?.acsDetails, failure?.acsApproval];
  for (const key of ['reason', 'detail', 'workItemId', 'actionHash', 'approvalInstructions']) {
    for (const source of sources) {
      if (source && typeof source[key] === 'string') {
        details[key] = source[key];
        break;
      }
    }
  }
  const message = shape === MANAGED_TOOL_ERRORS.required
    ? details.workItemId
      ? `ACS approval required: work item ${details.workItemId}. Approve it in ACS, then retry the identical call.`
      : 'ACS approval required. Approve the work item in ACS, then retry the identical call.'
    : shape === MANAGED_TOOL_ERRORS.denied
      ? details.reason
        ? `ACS denied this tool call: ${details.reason}`
        : 'ACS denied this tool call.'
      : 'ACS authorization unavailable; retry after ACS recovers.';
  const id = parsed && Object.prototype.hasOwnProperty.call(parsed, 'id') ? parsed.id : null;
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: shape.code,
      message,
      data: details,
    },
  };
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Never log query strings (codes/state/passphrases) or tokens.
function log(method, path, status, note = '') {
  console.log(`${new Date().toISOString()} ${method} ${path} -> ${status}${note ? ' ' + note : ''}`);
}

// ---------------------------------------------------------------------------
// CIMD: fetch + validate a client's metadata document
// ---------------------------------------------------------------------------
async function resolveClient(clientId) {
  if (clients[clientId]) return clients[clientId];
  if (!/^https:\/\//.test(clientId)) return null; // CIMD ids must be https URLs
  const cached = cimdCache.get(clientId);
  if (cached && cached._fetched + 3600_000 > Date.now()) return cached;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(clientId, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    clearTimeout(t);
    if (!r.ok) return null;
    const doc = await r.json();
    if (!Array.isArray(doc.redirect_uris) || doc.redirect_uris.length === 0) return null;
    const meta = {
      redirect_uris: doc.redirect_uris,
      token_endpoint_auth_method: doc.token_endpoint_auth_method || 'none',
      grant_types: doc.grant_types || ['authorization_code'],
      _fetched: Date.now(),
    };
    cimdCache.set(clientId, meta);
    return meta;
  } catch { return null; }
}

function validRedirect(client, redirectUri) {
  try {
    const u = new URL(redirectUri);
    if (client.redirect_uris.includes(redirectUri)) return true;
    // loopback redirect allowed per RFC 8252 for native-ish clients
    if ((u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.protocol === 'http:') return true;
  } catch { /* noop */ }
  return false;
}

// ---------------------------------------------------------------------------
// Consent page (single-owner deployment: passphrase-gated approval)
// ---------------------------------------------------------------------------
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function consentPage(q, lane = DC_OAUTH_LANE) {
  const hidden = Object.entries(q)
    .filter(([k]) => ['client_id', 'redirect_uri', 'response_type', 'scope', 'state', 'code_challenge', 'code_challenge_method', 'resource'].includes(k))
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('\n');
  const requested = q.resource || lane.resource;
  const warning = requested === JC_RESOURCE
    ? 'Jace Commander access: ACS/codex-swarm/visualizer reads, mission submission, and ROOT commands (each root command still needs a separate human approval in ACS). Only approve clients you trust.'
    : 'Full Desktop Commander access (shell, filesystem). Only approve clients you trust.';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Desktop Commander MCP - Authorization</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui,sans-serif;background:#111;color:#eee;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#1c1c1c;padding:2rem;border-radius:12px;max-width:420px;width:90%}h1{font-size:1.1rem}
code{background:#333;padding:2px 6px;border-radius:4px;font-size:.85em}
input{width:100%;padding:.6rem;margin:.5rem 0 1rem;border-radius:6px;border:1px solid #444;background:#252525;color:#eee;box-sizing:border-box}
button{width:100%;padding:.7rem;border:0;border-radius:6px;background:#4f8cff;color:#fff;font-size:1rem;cursor:pointer}
.warn{color:#ffb454;font-size:.85rem}</style></head>
<body><div class="card"><h1>Authorize MCP client?</h1>
<p>Client <code>${esc(q.client_id || '?')}</code> requests scope <code>${esc(q.scope || 'mcp')}</code> for
<code>${esc(requested)}</code>.</p>
<p class="warn">${esc(warning)}</p>
<form method="POST" action="/authorize/consent">
${hidden}
<label>Consent passphrase<input type="password" name="passphrase" autocomplete="off" required></label>
<button type="submit">Authorize</button></form></div></body></html>`;
}

function denyPage(msg) {
  return `<!doctype html><html><body style="font-family:system-ui;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh"><p>${esc(msg)}</p></body></html>`;
}

function parseQuery(url) { return Object.fromEntries(new URL(url, 'http://localhost').searchParams.entries()); }

async function handleAuthorize(req, res, q, laneHint = null) {
  const { client_id, redirect_uri, response_type, code_challenge, code_challenge_method, scope, state } = q;
  if (!client_id || !redirect_uri) return jsonError(res, 400, 'invalid_request', 'client_id and redirect_uri required');
  const client = await resolveClient(client_id);
  if (!client) return send(res, 400, denyPage('Unknown client.'), { 'Content-Type': 'text/html; charset=utf-8' });
  if (!validRedirect(client, redirect_uri)) return send(res, 400, denyPage('redirect_uri not registered for this client.'), { 'Content-Type': 'text/html; charset=utf-8' });
  const lane = laneHint || laneForClientResource(client, q.resource);
  const resource = q.resource || lane?.resource;
  const fail = (code, desc) => {
    const u = new URL(redirect_uri);
    u.searchParams.set('error', code); u.searchParams.set('error_description', desc);
    if (state) u.searchParams.set('state', state);
    if (lane?.issuer && q.iss !== undefined) u.searchParams.set('iss', lane.issuer);
    return redirect(res, u.toString());
  };
  if (!lane) return fail('invalid_target', 'unknown resource');
  if (response_type !== 'code') return fail('unsupported_response_type', 'response_type must be code');
  if (!code_challenge || code_challenge_method !== 'S256') return fail('invalid_request', 'PKCE with S256 is required');
  if (/[^A-Za-z0-9\-._~]/.test(code_challenge) || code_challenge.length < 43 || code_challenge.length > 128)
    return fail('invalid_request', 'malformed code_challenge');
  if (resource !== lane.resource) return fail('invalid_target', 'resource does not belong to this OAuth lane');
  const reqScope = (scope || 'mcp').split(' ').filter((s) => s === 'mcp' || s === 'openid' || s === 'email' || s === 'profile');
  if (reqScope.length === 0) return fail('invalid_scope', 'no permitted scope requested');
  return send(res, 200, consentPage({ ...q, resource }, lane), { 'Content-Type': 'text/html; charset=utf-8' });
}

async function handleConsent(req, res, body, laneHint = null) {
  const params = Object.fromEntries(new URLSearchParams(body.toString('utf8')).entries());
  const { client_id, redirect_uri, scope, state, code_challenge } = params;
  const pass = params.passphrase || '';
  const passOk = pass.length > 0 && crypto.timingSafeEqual(
    Buffer.from(crypto.createHash('sha256').update(pass).digest()),
    Buffer.from(crypto.createHash('sha256').update(CONSENT_PASSPHRASE).digest()));
  if (!passOk) return send(res, 401, denyPage('Invalid consent passphrase.'), { 'Content-Type': 'text/html; charset=utf-8' });
  const client = await resolveClient(client_id);
  if (!client || !validRedirect(client, redirect_uri)) return send(res, 400, denyPage('Invalid client/redirect.'), { 'Content-Type': 'text/html; charset=utf-8' });
  const lane = laneHint || laneForClientResource(client, params.resource);
  if (!lane) return send(res, 400, denyPage('Unknown resource.'), { 'Content-Type': 'text/html; charset=utf-8' });
  const resource = params.resource || lane.resource;
  if (resource !== lane.resource) return send(res, 400, denyPage('Resource does not belong to this OAuth lane.'), { 'Content-Type': 'text/html; charset=utf-8' });
  const code = randId();
  codes.set(code, {
    client_id, redirect_uri, scope: scope || 'mcp', resource, issuer: lane.issuer,
    code_challenge, exp: now() + CODE_TTL_S,
  });
  const u = new URL(redirect_uri);
  u.searchParams.set('code', code);
  if (state) u.searchParams.set('state', state);
  u.searchParams.set('iss', lane.issuer);
  return redirect(res, u.toString());
}

const codes = new Map();
setInterval(() => { const t = now(); for (const [c, g] of codes) if (g.exp < t) codes.delete(c); }, 60_000);

function issueTokens(grant, lane = DC_OAUTH_LANE) {
  const t = now();
  const jti = randId();
  const access = signJwt({
    iss: lane.issuer, sub: 'jacen', aud: lane.resource, client_id: grant.client_id,
    scope: grant.scope, iat: t, exp: t + ACCESS_TTL_S, jti,
  });
  const rjti = randId();
  refreshTokens[rjti] = { client_id: grant.client_id, scope: grant.scope, resource: lane.resource, issuer: lane.issuer, exp: t + REFRESH_TTL_S, active: true };
  saveJson(tokensFile, refreshTokens);
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: rjti, scope: grant.scope };
}

async function handleToken(req, res, body, laneHint = null) {
  const p = Object.fromEntries(new URLSearchParams(body.toString('utf8')).entries());
  const { grant_type, code, code_verifier, redirect_uri, client_id, client_secret, refresh_token, resource } = p;
  if (grant_type === 'authorization_code') {
    const g = code ? codes.get(code) : null;
    if (!g) return jsonError(res, 400, 'invalid_grant', 'unknown or expired code');
    codes.delete(code);
    const lane = laneForGrant(g);
    if (!lane || (laneHint && (lane.resource !== laneHint.resource || lane.issuer !== laneHint.issuer)))
      return jsonError(res, 400, 'invalid_target', 'authorization code belongs to a different OAuth lane');
    const client = await resolveClient(client_id || g.client_id);
    if (!client || (client_id && client_id !== g.client_id)) return jsonError(res, 400, 'invalid_grant', 'client mismatch');
    if (client.client_secret && client_secret !== client.client_secret) return jsonError(res, 401, 'invalid_client', 'client auth failed');
    if (redirect_uri !== g.redirect_uri) return jsonError(res, 400, 'invalid_grant', 'redirect_uri mismatch');
    if (!code_verifier) return jsonError(res, 400, 'invalid_request', 'code_verifier required');
    const expect = b64u(crypto.createHash('sha256').update(code_verifier).digest());
    const a = Buffer.from(expect); const b = Buffer.from(g.code_challenge);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return jsonError(res, 400, 'invalid_grant', 'PKCE verification failed');
    if (resource && resource !== lane.resource) return jsonError(res, 400, 'invalid_target', 'resource mismatch');
    return send(res, 200, issueTokens(g, lane), { 'Cache-Control': 'no-store', 'Pragma': 'no-cache' });
  }
  if (grant_type === 'refresh_token') {
    const rec = refreshTokens[refresh_token];
    if (!rec || !rec.active || rec.exp < now()) return jsonError(res, 400, 'invalid_grant', 'invalid refresh token');
    const lane = laneForGrant(rec);
    if (!lane || (laneHint && (lane.resource !== laneHint.resource || lane.issuer !== laneHint.issuer)))
      return jsonError(res, 400, 'invalid_target', 'refresh token belongs to a different OAuth lane');
    if (resource && resource !== lane.resource) return jsonError(res, 400, 'invalid_target', 'resource mismatch');
    rec.active = false;
    const t = issueTokens({ client_id: rec.client_id, scope: rec.scope }, lane);
    return send(res, 200, t, { 'Cache-Control': 'no-store', 'Pragma': 'no-cache' });
  }
  return jsonError(res, 400, 'unsupported_grant_type', 'supported: authorization_code, refresh_token');
}

async function handleRegister(req, res, body, lane = DC_OAUTH_LANE) {
  let meta;
  try { meta = JSON.parse(body.toString('utf8')); } catch { return jsonError(res, 400, 'invalid_client_metadata', 'body must be JSON'); }
  const uris = meta.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => { try { new URL(u); return true; } catch { return false; } }))
    return jsonError(res, 400, 'invalid_redirect_uri', 'redirect_uris must be a non-empty array of valid URIs');
  const grants = meta.grant_types || ['authorization_code'];
  if (!grants.every((g) => ['authorization_code', 'refresh_token'].includes(g)))
    return jsonError(res, 400, 'invalid_client_metadata', 'unsupported grant_types');
  const client_id = randId();
  const client_secret = meta.token_endpoint_auth_method && meta.token_endpoint_auth_method !== 'none' ? randId() : undefined;
  clients[client_id] = {
    client_name: String(meta.client_name || 'dynamic-client').slice(0, 100),
    redirect_uris: uris, grant_types: grants,
    token_endpoint_auth_method: meta.token_endpoint_auth_method || 'none',
    oauth_lane: lane.name === 'jc' ? 'jc' : 'dc',
    scope: 'mcp', client_id_issued_at: now(),
  };
  if (client_secret) { clients[client_id].client_secret = client_secret; clients[client_id].client_secret_expires_at = 0; }
  saveJson(clientsFile, clients);
  return send(res, 201, {
    client_id, ...clients[client_id].client_secret ? { client_secret, client_secret_expires_at: 0 } : {},
    client_id_issued_at: clients[client_id].client_id_issued_at,
    redirect_uris: uris, grant_types: grants,
    token_endpoint_auth_method: clients[client_id].token_endpoint_auth_method,
    scope: 'mcp',
  }, { 'Cache-Control': 'no-store' });
}

// ---------------------------------------------------------------------------
// Bearer validation for /mcp
// ---------------------------------------------------------------------------
const CHALLENGE = () => 'Bearer resource_metadata="' + ISSUER + '/.well-known/oauth-protected-resource", scope="mcp"';
const JC_CHALLENGE = () => 'Bearer resource_metadata="' + ISSUER + '/.well-known/oauth-protected-resource/jc/mcp", scope="mcp"';

function checkAuth(req, expectedResource = RESOURCE, expectedIssuer = ISSUER) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return null;
  const payload = verifyJwt(m[1].trim());
  if (!payload) return null;
  if (payload.iss !== expectedIssuer) return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(expectedResource)) return null;
  return payload;
}

// ---------------------------------------------------------------------------
// Proxy /mcp -> Supergateway (streamable HTTP, streamed both directions)
// ---------------------------------------------------------------------------
const HOP = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'authorization', 'content-length', 'expect']);

function proxyMcp(req, res, bodyBuf, auth, target = { base: UPSTREAM, pathname: null }) {
  const url = new URL(req.url, target.base);
  if (target.pathname) url.pathname = target.pathname; // /jc/mcp -> upstream /mcp
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (HOP.has(lk)) continue;
    if (lk === 'x-forwarded-host' || lk === 'x-forwarded-proto' || lk === 'forwarded') continue; // never leak origin hints upstream
    if (lk === 'x-dc-agent' || lk === 'x-dc-client' || lk === 'x-dc-attestation') continue; // never trust client-supplied identity headers
    headers[k] = v;
  }
  headers['x-forwarded-for'] = 'gateway-authenticated';
  if (GATEWAY_EXECUTION_TOKEN && auth) {
    // Trusted transport attribution: attest the authenticated identity to the
    // executor. The bearer token itself is never forwarded (HOP-stripped).
    const iat = now();
    headers['x-dc-agent'] = String(auth.sub || '');
    headers['x-dc-client'] = String(auth.client_id || '');
    headers['x-dc-attestation'] = mintAttestation({
      sub: auth.sub, client_id: auth.client_id, jti: auth.jti, iat, exp: iat + 60,
    });
  }
  const upstream = new URL(target.base);
  headers.host = upstream.host;
  const opts = { protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80), path: url.pathname + url.search, method: req.method, headers };
  const ureq = http.request(opts, (ures) => {
    const out = {};
    for (const [k, v] of Object.entries(ures.headers)) if (!HOP.has(k.toLowerCase())) out[k] = v;
    res.writeHead(ures.statusCode || 502, out);
    ures.pipe(res); // stream: SSE / JSON both preserved, no buffering
  });
  ureq.setTimeout(15 * 60_000, () => ureq.destroy(new Error('upstream timeout')));
  ureq.on('error', () => { if (!res.headersSent) { log(req.method, target.pathname ? '/jc/mcp' : '/mcp', 502, 'upstream error'); send(res, 502, { error: 'upstream_unavailable' }); } else res.destroy(); });
  if (bodyBuf && bodyBuf.length) ureq.write(bodyBuf);
  ureq.end();
  req.on('aborted', () => ureq.destroy());
}

/**
 * Buffered initialize proxy with runtime-bootstrap attestation.
 *
 * Unlike `proxyMcp` (which streams), this path buffers the child's initialize
 * response so the gateway can extract `result._meta.acsRuntimeIdentity` — the
 * child's own proof — and hand that exact object to ACS's completion endpoint.
 * The child's initialize success is only released to the client after ACS
 * answers 204. Missing or malformed proof, non-200 child response, or ACS
 * rejection all fail closed with 503 before anything is exposed.
 */
function proxyInitializeWithAttestation(req, res, bodyBuf, identity, challenge, auth) {
  const initializeManaged = {
    ...MANAGED,
    timeoutMs: Math.min(MANAGED.timeoutMs || MCP_INITIALIZE_ACS_TIMEOUT_MS, MCP_INITIALIZE_ACS_TIMEOUT_MS),
  };
  return new Promise((resolve, reject) => {
    const url = new URL(req.url, UPSTREAM);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (HOP.has(lk)) continue;
      if (lk === 'x-forwarded-host' || lk === 'x-forwarded-proto' || lk === 'forwarded') continue;
      if (lk === 'x-dc-agent' || lk === 'x-dc-client' || lk === 'x-dc-attestation') continue;
      headers[k] = v;
    }
    headers['x-forwarded-for'] = 'gateway-authenticated';
    if (GATEWAY_EXECUTION_TOKEN && auth) {
      const iat = now();
      headers['x-dc-agent'] = String(auth.sub || '');
      headers['x-dc-client'] = String(auth.client_id || '');
      headers['x-dc-attestation'] = mintAttestation({
        sub: auth.sub, client_id: auth.client_id, jti: auth.jti, iat, exp: iat + 60,
      });
    }
    const upstream = new URL(UPSTREAM);
    headers.host = upstream.host;
    const opts = { protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80), path: url.pathname + url.search, method: req.method, headers };
    // A failed attestation must not strand the bridge session the child's
    // initialize already created: the client never learns its id, so it can
    // never DELETE it, and the bridge does not evict idle sessions.
    let upstreamSessionId;
    const closeUpstreamSession = () => {
      if (!upstreamSessionId) return;
      const del = http.request({ ...opts, method: 'DELETE', headers: { ...headers, 'mcp-session-id': upstreamSessionId } }, (r) => r.resume());
      del.on('error', () => {});
      del.end();
      upstreamSessionId = undefined;
    };
    const fail = (acsCode) => {
      closeUpstreamSession();
      const err = Object.assign(new Error(`managed initialize attestation failed: ${acsCode}`), { acsCode });
      reject(err);
    };
    const ureq = http.request(opts, (ures) => {
      if (typeof ures.headers['mcp-session-id'] === 'string') upstreamSessionId = ures.headers['mcp-session-id'];
      const chunks = [];
      let size = 0;
      ures.on('data', (c) => { size += c.length; if (size > 4 * 1024 * 1024) { ures.destroy(); fail('initialize_response_too_large'); } else chunks.push(c); });
      ures.on('error', () => fail('initialize_upstream_error'));
      ures.on('end', async () => {
        try {
          if ((ures.statusCode || 0) !== 200) return fail('initialize_upstream_not_ok');
          const payload = Buffer.concat(chunks);
          const contentType = String(ures.headers['content-type'] || '');
          // MCP streamable-HTTP children may answer initialize with either a
          // plain JSON document or an SSE stream (`data:` frames). Handle both:
          // proof extraction parses the frame, but the client is always given
          // the child's original bytes, unmodified.
          let parsedInitializeResponse;
          try {
            if (contentType.includes('text/event-stream')) {
              const dataLines = payload.toString('utf8')
                .split(/\r?\n/)
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trim())
                .filter(Boolean);
              if (dataLines.length === 0) return fail('initialize_response_not_json');
              parsedInitializeResponse = JSON.parse(dataLines[dataLines.length - 1]);
            } else {
              parsedInitializeResponse = JSON.parse(payload.toString('utf8'));
            }
          } catch {
            return fail('initialize_response_not_json');
          }
          // The proof must be the child's own object, present and well-formed.
          // It is forwarded exactly as produced — never reconstructed here.
          const runtimeIdentity =
            parsedInitializeResponse && typeof parsedInitializeResponse === 'object'
              ? parsedInitializeResponse?.result?._meta?.acsRuntimeIdentity
              : undefined;
          const valid =
            runtimeIdentity && typeof runtimeIdentity === 'object' && !Array.isArray(runtimeIdentity) &&
            runtimeIdentity.schemaVersion === 1 &&
            typeof runtimeIdentity.runtimeId === 'string' && runtimeIdentity.runtimeId.length > 0 &&
            typeof runtimeIdentity.challenge === 'string' && runtimeIdentity.challenge.length > 0 &&
            Array.isArray(runtimeIdentity.scopes);
          if (!valid) return fail('runtime_identity_proof_missing_or_malformed');
          await completeRuntimeBootstrap(initializeManaged, identity, challenge, runtimeIdentity);
          const out = {};
          for (const [k, v] of Object.entries(ures.headers)) if (!HOP.has(k.toLowerCase())) out[k] = v;
          delete out['transfer-encoding'];
          out['content-length'] = String(payload.length);
          res.writeHead(ures.statusCode || 200, out);
          res.end(payload);
          log(req.method, '/dc/runtime/bootstrap/complete', 204);
          resolve();
        } catch (e) {
          closeUpstreamSession();
          reject(e && e.acsCode ? e : Object.assign(new Error('managed initialize attestation failed'), { acsCode: 'bootstrap_complete_failed' }));
        }
      });
    });
    ureq.setTimeout(MCP_INITIALIZE_UPSTREAM_TIMEOUT_MS, () => ureq.destroy(new Error('initialize upstream timeout')));
    ureq.on('error', () => fail('initialize_upstream_unreachable'));
    if (bodyBuf && bodyBuf.length) ureq.write(bodyBuf);
    ureq.end();
    req.on('aborted', () => { ureq.destroy(); closeUpstreamSession(); reject(Object.assign(new Error('client aborted during initialize'), { acsCode: 'initialize_client_aborted' })); });
  });
}

// ---------------------------------------------------------------------------
// /ready + /authority support (hardening item #2)
// ---------------------------------------------------------------------------
async function checkAcsIssuanceReady() {
  if (!MANAGED.enabled || !MANAGED.acsGatewayUrl) return { reachable: false, detail: 'ACS managed issuance not configured' };
  try {
    const url = new URL('/readyz', MANAGED.acsGatewayUrl);
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return { reachable: r.ok, httpStatus: r.status };
  } catch (e) {
    return { reachable: false, detail: `ACS gateway unreachable: ${e?.message || 'error'}` };
  }
}
async function fetchBridgeAuthority(upstreamBase = UPSTREAM) {
  try {
    const url = new URL('/authority', upstreamBase);
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return { ok: false, error: `bridge /authority HTTP ${r.status}` };
    return { ok: true, data: await r.json() };
  } catch (e) {
    return { ok: false, error: e?.message || 'bridge unreachable' };
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const pathName = u.pathname.replace(/\/+$/, '') || '/';
  try {
    // local health (no auth; contains no data)
    if (pathName === '/healthz') { log('GET', '/healthz', 200); return send(res, 200, { ok: true, service: 'desktop-commander-mcp-gateway' }); }
    if (pathName === '/health') { log('GET', '/health', 200); return send(res, 200, { ok: true, pid: process.pid, service: 'desktop-commander-mcp-gateway' }); }

    // /ready and /authority (hardening item #2): non-secret structured state
    // only — never capability payloads, keys, tokens, or credentials.
    if (pathName === '/ready' || pathName === '/authority') {
      const acsIssuance = await checkAcsIssuanceReady();
      const bridgeAuthority = await fetchBridgeAuthority();
      // The optional JC lane must never delay or gate the primary /ready probe.
      // Report it on /authority only; /ready remains scoped to the primary DC lane.
      const jcAuthority = pathName === '/authority' && JC.enabled ? await fetchBridgeAuthority(JC_UPSTREAM) : null;
      if (pathName === '/authority') {
        const body = {
          managedIssuance: { configured: MANAGED.enabled, ...acsIssuance },
          bridge: bridgeAuthority.ok ? bridgeAuthority.data : { reachable: false, error: bridgeAuthority.error },
          ...(jcAuthority ? { jcBridge: jcAuthority.ok ? jcAuthority.data : { reachable: false, error: jcAuthority.error } } : {}),
        };
        log('GET', '/authority', 200);
        return send(res, 200, body);
      }
      // A jc bridge on UPSTREAM is a misconfiguration, never a ready DC bridge.
      const bridgeReady = bridgeAuthority.ok && bridgeAuthority.data && bridgeAuthority.data.variant !== 'jc' && bridgeAuthority.data.observedMode !== 'ambiguous_conflict' && bridgeAuthority.data.bridge?.hasUpstreamPair;
      const issuanceReady = !MANAGED.enabled || acsIssuance.reachable;
      // /ready gates the primary DC route; the JC bridge is reported, not gating.
      const jcBridgeReady = jcAuthority ? !!(jcAuthority.ok && jcAuthority.data?.variant === 'jc' && jcAuthority.data?.bridge?.hasUpstreamPair) : undefined;
      const ready = !!bridgeReady && !!issuanceReady;
      log('GET', '/ready', ready ? 200 : 503);
      return send(res, ready ? 200 : 503, { ready, bridgeReady: !!bridgeReady, issuanceReady, ...(jcAuthority ? { jcBridgeReady } : {}) });
    }

    // ---- discovery (public, no secrets) ----
    if (pathName === '/.well-known/oauth-protected-resource' || pathName === '/.well-known/oauth-protected-resource/mcp') {
      log('GET', pathName, 200); return send(res, 200, META);
    }
    if (pathName === '/.well-known/oauth-protected-resource/jc/mcp' && JC.enabled) {
      log('GET', pathName, 200); return send(res, 200, JC_META);
    }
    if (pathName === '/.well-known/oauth-authorization-server' || pathName === '/.well-known/oauth-authorization-server/mcp' || pathName === '/.well-known/openid-configuration') {
      log('GET', pathName, 200); return send(res, 200, AS_META());
    }
    if (JC.enabled && (pathName === '/.well-known/oauth-authorization-server/jc' || pathName === '/jc/.well-known/oauth-authorization-server' || pathName === '/jc/.well-known/openid-configuration')) {
      log('GET', pathName, 200); return send(res, 200, JC_AS_META());
    }

    // ---- OAuth endpoints ----
    if (pathName === '/authorize' && req.method === 'GET') {
      const q = parseQuery(req.url);
      const lane = JC.enabled && q.oauth_lane === 'jc' ? JC_OAUTH_LANE : null;
      await handleAuthorize(req, res, q, lane); log('GET', '/authorize', res.statusCode); return;
    }
    if (pathName === '/authorize/consent' && req.method === 'POST') {
      const body = await readBody(req);
      await handleConsent(req, res, body); log('POST', '/authorize/consent', res.statusCode); return;
    }
    if (pathName === '/token' && req.method === 'POST') {
      const body = await readBody(req);
      const q = parseQuery(req.url);
      const lane = JC.enabled && q.oauth_lane === 'jc' ? JC_OAUTH_LANE : null;
      await handleToken(req, res, body, lane); log('POST', '/token', res.statusCode); return;
    }
    if (pathName === '/register' && req.method === 'POST') {
      const body = await readBody(req);
      const q = parseQuery(req.url);
      const lane = JC.enabled && q.oauth_lane === 'jc' ? JC_OAUTH_LANE : DC_OAUTH_LANE;
      await handleRegister(req, res, body, lane); log('POST', '/register', res.statusCode); return;
    }

    // ---- MCP proxy (auth required, all methods) ----
    if (pathName === '/mcp') {
      const auth = checkAuth(req);
      if (!auth) {
        log(req.method, '/mcp', 401, 'auth required');
        return send(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': CHALLENGE() });
      }
      let body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : null;
      if (MANAGED.enabled && req.method === 'POST') {
        const { isCall, parsed, hasBatchedCall } = isToolsCall(body);
        const dcClaims = noteClient('dc', MANAGED, auth, req, parsed);
        if (hasBatchedCall) {
          // Fail closed: a batch containing tools/call would otherwise bypass
          // per-call ACS issuance and anti-spoof metadata stripping.
          log(req.method, '/mcp', 503, 'managed fail-closed: batched_tools_call');
          return send(res, 503, { error: 'managed_authorization_unavailable', code: 'batched_tools_call_rejected' });
        }
        if (isCall) {
          try {
            // With the jc lane on, UPSTREAM may be swapped with JC_UPSTREAM:
            // never issue or forward a DC capability to the jc bridge.
            if (JC.enabled) {
              const dcBridge = await fetchBridgeAuthority(UPSTREAM);
              if (!dcBridge.ok || (dcBridge.data?.variant ?? 'dc') !== 'dc') {
                throw Object.assign(new Error('/mcp upstream is not the Desktop Commander bridge'), { acsCode: 'dc_bridge_mismatch' });
              }
            }
            const rewrite = capabilityTransport(MANAGED, {
              identity: identityAttribution(auth, dcClaims),
              requestId: randId(),
            });
            body = Buffer.from(JSON.stringify(await rewrite(parsed)), 'utf8');
          } catch (e) {
            const code = e && e.acsCode ? e.acsCode : 'managed_fail_closed';
            // A parsed single tools/call refusal is an MCP application error,
            // not an HTTP transport failure. Keep the call fail-closed — it is
            // never forwarded — while preserving the request id and ACS
            // approval metadata for the caller.
            log(req.method, '/mcp', 200, `managed fail-closed: ${code}`);
            return send(res, 200, managedToolErrorResponse(parsed, e));
          }
        } else if (parsed && parsed.method === 'initialize' && NATIVE_RUNTIME_BOOTSTRAP) {
          // Managed initialize: fetch an ACS runtime bootstrap challenge and
          // transport it to the child in _meta.acsRuntimeBootstrap. The child
          // structurally validates it during initialize and returns its own
          // proof in result._meta.acsRuntimeIdentity. That exact object is the
          // completion payload ACS requires; initialize is buffered (not
          // streamed) until the proof is verified and ACS accepts completion.
          // Any failure is fail-closed: the client never sees a successful
          // initialize without a completed attestation.
          try {
            const identity = dcRuntimeIdentityFromState();
            if (!identity) throw Object.assign(new Error('DC runtime identity unavailable'), { acsCode: 'runtime_identity_unavailable' });
            const initializeManaged = {
              ...MANAGED,
              timeoutMs: Math.min(MANAGED.timeoutMs || MCP_INITIALIZE_ACS_TIMEOUT_MS, MCP_INITIALIZE_ACS_TIMEOUT_MS),
            };
            const challenge = await issueRuntimeBootstrap(initializeManaged, identity);
            body = Buffer.from(JSON.stringify(injectRuntimeBootstrap(parsed, challenge)), 'utf8');
            await proxyInitializeWithAttestation(req, res, body, identity, challenge, auth);
            log(req.method, '/mcp', 200, 'initialize attested + proxied');
          } catch (e) {
            const code = e && e.acsCode ? e.acsCode : 'managed_fail_closed';
            log(req.method, '/mcp', 503, `managed initialize fail-closed: ${code}`);
            if (!res.headersSent) return send(res, 503, { error: 'managed_authorization_unavailable', code });
            return res.destroy();
          }
          return;
        }
      }
      proxyMcp(req, res, body, auth);
      log(req.method, '/mcp', 200, 'proxied'); // status approximate; stream continues
      return;
    }

    // ---- Jace Commander MCP proxy (auth required; ACS-managed only) ----
    if (pathName === '/jc/mcp' && JC.enabled) {
      const auth = checkAuth(req, JC_RESOURCE, JC_ISSUER);
      if (!auth) {
        log(req.method, '/jc/mcp', 401, 'auth required');
        return send(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': JC_CHALLENGE() });
      }
      let body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : null;
      if (req.method === 'POST') {
        const { isCall, parsed, hasBatchedCall } = isToolsCall(body);
        const jcClaims = noteClient('jc', JC, auth, req, parsed);
        if (hasBatchedCall) {
          // Fail closed: a batch would bypass per-call ACS issuance and
          // anti-spoof metadata stripping. Clients must send single requests.
          log(req.method, '/jc/mcp', 503, 'managed fail-closed: batched_tools_call');
          return send(res, 503, { error: 'managed_authorization_unavailable', code: 'batched_tools_call_rejected' });
        }
        if (isCall) {
          try {
            // Never issue or forward a JC capability to anything but the JC
            // bridge (e.g. JC_UPSTREAM mistakenly pointed at the DC bridge).
            const jcBridge = await fetchBridgeAuthority(JC_UPSTREAM);
            if (!jcBridge.ok || jcBridge.data?.variant !== 'jc') {
              throw Object.assign(new Error('jc upstream is not the Jace Commander bridge'), { acsCode: 'jc_bridge_mismatch' });
            }
            const rewrite = capabilityTransport(JC, { identity: identityAttribution(auth, jcClaims), requestId: randId() });
            body = Buffer.from(JSON.stringify(await rewrite(parsed)), 'utf8');
          } catch (e) {
            const code = e && e.acsCode ? e.acsCode : 'managed_fail_closed';
            log(req.method, '/jc/mcp', 200, `managed fail-closed: ${code}`);
            return send(res, 200, managedToolErrorResponse(parsed, e));
          }
        }
      }
      proxyMcp(req, res, body, auth, { base: JC_UPSTREAM, pathname: '/mcp' });
      log(req.method, '/jc/mcp', 200, 'proxied');
      return;
    }

    log(req.method, pathName, 404);
    return send(res, 404, { error: 'not_found' });
  } catch (e) {
    const status = e && e.status ? e.status : 500;
    log(req.method, pathName, status, e && e.status ? 'rejected' : 'error');
    if (!res.headersSent) return jsonError(res, status, status === 413 ? 'payload_too_large' : 'server_error', status === 500 ? 'internal error' : String(e.message || 'error'));
    res.destroy();
  }
});

server.headersTimeout = 30_000;
server.requestTimeout = 0;           // SSE streams may be long-lived
server.keepAliveTimeout = 65_000;
server.maxHeadersCount = 100;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`gateway: listening on 127.0.0.1:${PORT}`);
  console.log(`gateway: issuer=${ISSUER} resource=${RESOURCE} upstream=${UPSTREAM}${JC.enabled ? ` jc_resource=${JC_RESOURCE} jc_upstream=${JC_UPSTREAM}` : ''}`);
});
