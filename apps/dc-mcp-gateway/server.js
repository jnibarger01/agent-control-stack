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
import { saveJson } from './atomic-json.js';
import { fetchClientMetadata, isAllowedRedirectUri, matchesRegisteredLoopback } from './cimd-guard.js';
import { ClientInfoCache, createClientObserver, extractClientInfo } from './client-attribution.js';
import { localRoutingFromEnv, stripAuthorityMeta } from './jc-routing.js';
import { managedModeFromEnv, jcModeFromEnv, identityAttribution, capabilityTransport, acsPost, isToolsCall, dcRuntimeIdentityFromState, issueRuntimeBootstrap, completeRuntimeBootstrap, injectRuntimeBootstrap } from './managed.js';
import { enableAcsTiming } from './acs-timing.js';
import { dcBridgeReady, jcBridgeReady } from './readiness.js';
import { REPORTABLE_REFRESH_FAILURES, bearerChallenge, classifyTokenAuth, createAuthEventReporter, dpopChallenge, equalSecrets, resolveRefresh } from './auth-health.js';
import { SUPPORTED_DPOP_ALGS, createNonceManager, isValidJkt, verifyDpopProof } from './dpop.js';
import { createGatewayStore, normalizeUserCode } from './store.js';
import { parseFormStrict } from './strict-form.js';
import { createFailureThrottle } from './failure-throttle.js';
import { CONSENT_PAGE_CSP, codeEntryPage, consentPage as ownerConsentPage, createOwnerConsent, messagePage, ownerOidcConfigFromEnv, safeEqual } from './owner-oidc.js';

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
// Token lifetimes are fixed in production. The override exists only for disposable compatibility labs and is honoured
// only with EDGE_TEST_MODE=1; it is announced loudly at startup so it can never be on by accident.
const EDGE_TEST_MODE = process.env.EDGE_TEST_MODE === '1';
const testTtl = (name, fallback) => {
  const v = Number.parseInt(process.env[name] || '', 10);
  return EDGE_TEST_MODE && Number.isFinite(v) && v > 0 ? Math.min(v, 86_400) : fallback; // lab only, capped at one day
};
const ACCESS_TTL_S = testTtl('EDGE_TEST_ACCESS_TTL_S', 3600);
const JC_CLI_ACCESS_TTL_S = testTtl('EDGE_TEST_JC_CLI_ACCESS_TTL_S', testTtl('EDGE_TEST_ACCESS_TTL_S', 600));
const REFRESH_TTL_S = testTtl('EDGE_TEST_REFRESH_TTL_S', 30 * 24 * 3600);
const INACTIVITY_TTL_S = testTtl('EDGE_TEST_INACTIVITY_TTL_S', 7 * 24 * 3600);
const DEVICE_CODE_TTL_S = testTtl('EDGE_TEST_DEVICE_CODE_TTL_S', 600);
const DEVICE_INTERVAL_S = testTtl('EDGE_TEST_DEVICE_INTERVAL_S', 5);
const RECOVERY_TTL_S = testTtl('EDGE_TEST_RECOVERY_TTL_S', 120);
const DPOP_NONCE_REQUIRED = process.env.DPOP_NONCE_REQUIRED !== '0' && process.env.DPOP_NONCE_REQUIRED !== 'false';
const JC_REFRESH_RECOVERY_KEY = process.env.JC_REFRESH_RECOVERY_KEY || '';
if (EDGE_TEST_MODE) console.warn(`gateway: EDGE_TEST_MODE=1 (access ttl ${ACCESS_TTL_S}s, refresh ttl ${REFRESH_TTL_S}s). NOT FOR PRODUCTION.`);
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
if (NATIVE_RUNTIME_BOOTSTRAP) enableAcsTiming(); // #375 diagnostics: event-loop delay baseline
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
// ADR 0026: with JC_PRESET=local the edge skips ACS capability ISSUANCE for tools whose
// effective authorizer is `local` (the JC server enforces them). Authentication is unchanged.
const JC_LOCAL = localRoutingFromEnv();
if (JC_LOCAL.error) console.error(`gateway: jc local routing: ${JC_LOCAL.error}`);
// RFC 8707: each OAuth surface is bound to exactly one protected resource.
// The JC issuer advertises root physical endpoints with an explicit lane hint
// so hosted clients do not need path-specific DCR support.
if (!GATEWAY_EXECUTION_TOKEN) console.log('gateway: GATEWAY_EXECUTION_TOKEN not set; executor identity attestation disabled (log-once)');
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const PUBLIC_ORIGIN_CANONICAL = new URL(PUBLIC_ORIGIN).origin;
// Jace Auth (OIDC) owner consent for /jc/device. Unset = legacy shared-passphrase approval (hardened, but it cannot say who approved).
let OWNER_OIDC_CFG;
try { OWNER_OIDC_CFG = ownerOidcConfigFromEnv(process.env, { testMode: EDGE_TEST_MODE }); }
catch (err) { console.error(`gateway: owner OIDC consent misconfigured: ${err.message}; refusing to start`); process.exit(1); }
const ownerConsent = OWNER_OIDC_CFG.enabled && JC.enabled
  ? createOwnerConsent({ config: OWNER_OIDC_CFG, publicOrigin: PUBLIC_ORIGIN_CANONICAL, signingKey: SIGNING_KEY })
  : null;
// Failed-approval throttles. Keys identify a caller (owner session id); the legacy passphrase path has no caller identity
// (the ingress strips X-Forwarded-*), so it only slows repeated failures and never locks anyone out.
const ownerDecisionThrottle = createFailureThrottle({ max: 5, windowMs: 5 * 60_000, maxKeys: 1000 });
const legacyPassphraseThrottle = createFailureThrottle({ softDelayMs: 250, windowMs: 60_000, maxKeys: 4 });
const LEGACY_THROTTLE_KEY = 'shared';
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// With owner consent on, a DPoP-bound device may only be enrolled through the owner-verified device flow. The shared-passphrase
// authorization-code path (jc connect, loopback) would otherwise mint devices with no verified owner. Bearer clients
// (ChatGPT, Claude) are not devices and are unaffected. The escape hatch is explicit and off by default.
const OWNER_LEGACY_ENROLLMENT_ALLOWED = process.env.JC_OWNER_OIDC_ALLOW_LEGACY_ENROLLMENT === '1';
const enrollsDevice = (client, dpopJkt) => Boolean(client?.require_dpop || (dpopJkt !== undefined && dpopJkt !== ''));
const legacyEnrollmentRefused = (client, dpopJkt) => Boolean(ownerConsent && !OWNER_LEGACY_ENROLLMENT_ALLOWED && enrollsDevice(client, dpopJkt));
const gatewayStore = createGatewayStore(path.join(DATA_DIR, 'gateway.db'), {
  signingKey: SIGNING_KEY,
  recoveryKey: JC_REFRESH_RECOVERY_KEY,
});
const dpopNonces = createNonceManager({ signingKey: SIGNING_KEY });

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
  ...(lane.name === 'jc'
    ? { device_authorization_endpoint: `${PUBLIC_ORIGIN_CANONICAL}/jc/oauth/device/code` }
    : {}),
  response_types_supported: ['code'],
  grant_types_supported:
    lane.name === 'jc'
      ? ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code']
      : ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
  dpop_signing_alg_values_supported: [...SUPPORTED_DPOP_ALGS],
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
// Built-in static clients & CIMD: fetch + validate a client's metadata document
// ---------------------------------------------------------------------------
const BUILTIN_CLIENTS = Object.freeze({
  'jace-commander-cli': Object.freeze({
    client_name: 'Jace Commander CLI',
    redirect_uris: ['http://127.0.0.1/callback', 'http://[::1]/callback'],
    grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
    token_endpoint_auth_method: 'none',
    oauth_lane: 'jc',
    scope: 'mcp',
    require_dpop: true,
    require_state: true,
    access_ttl_s: JC_CLI_ACCESS_TTL_S,
    builtin: true,
  }),
});

async function resolveClient(clientId) {
  if (typeof clientId === 'string' && Object.hasOwn(BUILTIN_CLIENTS, clientId)) return BUILTIN_CLIENTS[clientId];
  if (typeof clientId === 'string' && Object.hasOwn(clients, clientId)) return clients[clientId];
  if (typeof clientId !== 'string' || !/^https:\/\//.test(clientId)) return null; // CIMD ids must be https URLs
  const cached = cimdCache.get(clientId);
  if (cached && cached._fetched + 3600_000 > Date.now()) return cached;
  try {
    // Connection-time SSRF policy, no redirects, bounded time and size (see cimd-guard.js).
    const meta = await fetchClientMetadata(clientId);
    const doc = { ...meta, _fetched: Date.now() };
    cimdCache.set(clientId, doc);
    return doc;
  } catch (err) {
    console.warn(`gateway: client metadata rejected: ${logSafe(err && err.message)}`);
    return null;
  }
}

function validRedirect(client, redirectUri) {
  if (client.redirect_uris.includes(redirectUri)) return true;
  // Loopback: any port, but only on a host and path the client registered (RFC 8252 §7.3).
  return matchesRegisteredLoopback(redirectUri, client.redirect_uris);
}

// ---------------------------------------------------------------------------
// Consent page (single-owner deployment: passphrase-gated approval)
// ---------------------------------------------------------------------------
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function consentPage(q, lane = DC_OAUTH_LANE) {
  const hidden = Object.entries(q)
    .filter(([k]) => ['client_id', 'redirect_uri', 'response_type', 'scope', 'state', 'code_challenge', 'code_challenge_method', 'resource', 'dpop_jkt', 'device_name'].includes(k))
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
  const { client_id, redirect_uri, response_type, code_challenge, code_challenge_method, scope, state, dpop_jkt } = q;
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
  if (legacyEnrollmentRefused(client, dpop_jkt)) return fail('access_denied', 'device enrollment requires owner sign-in; use the device login flow');
  if (client.builtin && client.oauth_lane === 'jc' && lane.name !== 'jc') return fail('invalid_target', 'client restricted to jc lane');
  if (response_type !== 'code') return fail('unsupported_response_type', 'response_type must be code');
  if (client.require_state && !state) return fail('invalid_request', 'state is required');
  if (dpop_jkt !== undefined && dpop_jkt !== '' && !isValidJkt(dpop_jkt)) return fail('invalid_request', 'malformed dpop_jkt');
  if (!code_challenge || code_challenge_method !== 'S256') return fail('invalid_request', 'PKCE with S256 is required');
  // Same rule as the consent POST: an S256 challenge is exactly 43 base64url characters.
  if (!isPkceChallenge(code_challenge)) return fail('invalid_request', 'malformed code_challenge');
  if (resource !== lane.resource) return fail('invalid_target', 'resource does not belong to this OAuth lane');
  const reqScope = (scope || 'mcp').split(' ').filter((s) => s === 'mcp' || s === 'openid' || s === 'email' || s === 'profile');
  if (reqScope.length === 0) return fail('invalid_scope', 'no permitted scope requested');
  return send(res, 200, consentPage({ ...q, resource }, lane), { 'Content-Type': 'text/html; charset=utf-8' });
}

async function handleConsent(req, res, body, laneHint = null) {
  const params = Object.fromEntries(new URLSearchParams(body.toString('utf8')).entries());
  const { client_id, redirect_uri, scope, state, code_challenge, code_challenge_method, dpop_jkt, device_name } = params;
  const pass = params.passphrase || '';
  const consentDelay = legacyPassphraseThrottle.delayMs(LEGACY_THROTTLE_KEY);
  if (consentDelay > 0) await sleepMs(consentDelay);
  const passOk = pass.length > 0 && crypto.timingSafeEqual(
    Buffer.from(crypto.createHash('sha256').update(pass).digest()),
    Buffer.from(crypto.createHash('sha256').update(CONSENT_PASSPHRASE).digest()));
  if (!passOk) {
    legacyPassphraseThrottle.fail(LEGACY_THROTTLE_KEY);
    return send(res, 401, denyPage('Invalid consent passphrase.'), { 'Content-Type': 'text/html; charset=utf-8' });
  }
  legacyPassphraseThrottle.clear(LEGACY_THROTTLE_KEY);
  const client = await resolveClient(client_id);
  if (!client || !validRedirect(client, redirect_uri)) return send(res, 400, denyPage('Invalid client/redirect.'), { 'Content-Type': 'text/html; charset=utf-8' });
  if (legacyEnrollmentRefused(client, dpop_jkt)) return send(res, 403, denyPage('Device enrollment requires owner sign-in. Use the device login flow.'), { 'Content-Type': 'text/html; charset=utf-8' });
  const lane = laneHint || laneForClientResource(client, params.resource);
  if (!lane) return send(res, 400, denyPage('Unknown resource.'), { 'Content-Type': 'text/html; charset=utf-8' });
  if (client.builtin && client.oauth_lane === 'jc' && lane.name !== 'jc') return send(res, 400, denyPage('Client restricted to jc lane.'), { 'Content-Type': 'text/html; charset=utf-8' });
  const resource = params.resource || lane.resource;
  if (resource !== lane.resource) return send(res, 400, denyPage('Resource does not belong to this OAuth lane.'), { 'Content-Type': 'text/html; charset=utf-8' });
  if (client.require_state && !state) return send(res, 400, denyPage('state is required.'), { 'Content-Type': 'text/html; charset=utf-8' });
  if (dpop_jkt !== undefined && dpop_jkt !== '' && !isValidJkt(dpop_jkt)) return send(res, 400, denyPage('Malformed dpop_jkt.'), { 'Content-Type': 'text/html; charset=utf-8' });
  // The consent POST is a second entry point: it must enforce the same PKCE rule as /authorize, not trust the form.
  if (code_challenge_method !== 'S256' || !isPkceChallenge(code_challenge)) return send(res, 400, denyPage('PKCE with S256 is required.'), { 'Content-Type': 'text/html; charset=utf-8' });
  const reqScope = (scope || 'mcp').split(' ').filter((s) => s === 'mcp' || s === 'openid' || s === 'email' || s === 'profile');
  if (reqScope.length === 0) return send(res, 400, denyPage('No permitted scope requested.'), { 'Content-Type': 'text/html; charset=utf-8' });
  const code = randId();
  gatewayStore.saveAuthCode(code, {
    client_id, redirect_uri, scope: reqScope.join(' '), resource, issuer: lane.issuer,
    code_challenge, code_challenge_method: 'S256',
    dpop_jkt: dpop_jkt || null,
    device_name: typeof device_name === 'string' ? device_name.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 64) || null : null,
    exp: now() + CODE_TTL_S,
  });
  const u = new URL(redirect_uri);
  u.searchParams.set('code', code);
  if (state) u.searchParams.set('state', state);
  u.searchParams.set('iss', lane.issuer);
  return redirect(res, u.toString());
}

// RFC 7636 section 4.1 / 4.2: 43-128 unreserved characters.
const isPkceVerifier = (v) => typeof v === 'string' && /^[A-Za-z0-9\-._~]{43,128}$/.test(v);
const isPkceChallenge = (v) => typeof v === 'string' && /^[A-Za-z0-9\-_]{43}$/.test(v);

function issueTokens(grant, lane = DC_OAUTH_LANE, family = randId().slice(0, 12)) {
  const t = now();
  const jti = randId();
  const access = signJwt({
    iss: lane.issuer, sub: 'jacen', aud: lane.resource, client_id: grant.client_id,
    scope: grant.scope, iat: t, exp: t + ACCESS_TTL_S, jti,
  });
  const rjti = randId();
  refreshTokens[rjti] = { client_id: grant.client_id, scope: grant.scope, resource: lane.resource, issuer: lane.issuer, exp: t + REFRESH_TTL_S, active: true, family };
  saveJson(tokensFile, refreshTokens);
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: rjti, scope: grant.scope };
}

/** Owner scope of a verified token: the (iss, sub) pair recorded at enrollment. Legacy tokens carry none (null namespace). */
function ownerScope(payload) {
  return typeof payload?.oiss === 'string' && typeof payload?.osub === 'string'
    ? { ownerIss: payload.oiss, ownerSub: payload.osub }
    : { ownerIss: null, ownerSub: null };
}

function mintDpopResponse({ sub, client_id, scope, lane, jkt, device_id, accessTtlS, owner_iss = null, owner_sub = null }) {
  const t = now();
  const jti = randId();
  const access = signJwt({
    iss: lane.issuer,
    sub,
    aud: lane.resource,
    client_id,
    scope,
    iat: t,
    exp: t + accessTtlS,
    jti,
    cnf: { jkt },
    ...(device_id ? { did: device_id } : {}),
    ...(owner_iss && owner_sub ? { oiss: owner_iss, osub: owner_sub } : {}),
  });
  const refreshToken = randId();
  return {
    refresh_token: refreshToken,
    response: {
      access_token: access,
      token_type: 'DPoP',
      expires_in: accessTtlS,
      refresh_token: refreshToken,
      scope,
      ...(device_id ? { device_id } : {}),
    },
  };
}

function verifyRequestDpop(req, pathname, { required = false, accessToken } = {}) {
  const hdr = req.headers['dpop'];
  if (typeof hdr !== 'string' || hdr.trim().length === 0) {
    if (!required) return { ok: true, used: false, freshNonce: dpopNonces.issue(now()) };
    return { ok: false, reason: 'missing_dpop', freshNonce: dpopNonces.issue(now()) };
  }
  const verified = verifyDpopProof(hdr, {
    htm: req.method,
    htu: `${PUBLIC_ORIGIN_CANONICAL}${pathname}`,
    accessToken,
    nowSec: now(),
    nonceManager: dpopNonces,
    nonceRequired: DPOP_NONCE_REQUIRED,
    consumeJti: (jti, jkt, exp) => gatewayStore.consumeJti(jti, jkt, exp, now()),
  });
  if (!verified.ok) return verified;
  return { ...verified, used: true };
}

// ---- Authentication health (ADR 0027) ----
// OAuth correctness (challenges, refresh classification) is always on. Only the REPORT to ACS is behind
// ACS_MCP_AUTH_EVENTS=1 (default off). Refresh-token rotation is strict and has no retry/cache path.
const AUTH_EVENTS = process.env.ACS_MCP_AUTH_EVENTS === '1';
const authReporters = new Map();
function authReporterFor(laneName) {
  const managed = laneName === 'jc' ? JC : MANAGED;
  let reporter = authReporters.get(laneName);
  if (!reporter) {
    const reporting = managed && managed.enabled ? { ...managed, timeoutMs: Math.min(managed.timeoutMs || 1500, 1500) } : null;
    reporter = createAuthEventReporter({
      enabled: AUTH_EVENTS && Boolean(reporting),
      post: (route, payload) => acsPost(reporting, route, payload),
      onError: (error) => console.warn(`gateway: auth event (${laneName}) failed: ${error && error.message ? error.message : 'error'}`),
    });
    authReporters.set(laneName, reporter);
  }
  return reporter;
}
/** Fire-and-forget. Never awaited, never throws, never changes a response. */
function reportAuth(laneName, identity, kind, reason, refreshExpiresAt, family) {
  try { void authReporterFor(laneName).report({ lane: laneName, identity, kind, reason, refreshExpiresAt, family }); } catch { /* reporting is best-effort */ }
}
/** Untrusted values in log lines: printable ASCII only (no forged lines or terminal control), bounded. */
const logSafe = (value) => String(value ?? '-').replace(/[^\x20-\x7e]/g, '?').slice(0, 64);
const isoFromSec = (sec) => new Date(sec * 1000).toISOString();

const DEVICE_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
function randomUserCode() {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i += 1) {
    out += DEVICE_CODE_ALPHABET[bytes[i] % DEVICE_CODE_ALPHABET.length];
    if (i === 3) out += '-';
  }
  return out;
}

function parseTokenBody(body) {
  return Object.fromEntries(new URLSearchParams(body.toString('utf8')).entries());
}

function sendUseDpopNonce(res, freshNonce, asTokenEndpoint = false) {
  if (asTokenEndpoint) {
    return jsonError(res, 400, 'use_dpop_nonce', 'DPoP nonce required', { 'DPoP-Nonce': freshNonce });
  }
  return null;
}

async function handleToken(req, res, body, laneHint = null, pathname = '/token') {
  const p = parseTokenBody(body);
  const { grant_type, code, code_verifier, redirect_uri, client_id, client_secret, refresh_token, resource, refresh_request_id, device_code } = p;
  if (grant_type === 'authorization_code') {
    const peek = code ? gatewayStore.peekAuthCode(code, now()) : null;
    if (!peek) return jsonError(res, 400, 'invalid_grant', 'unknown or expired code');
    const peekClient = await resolveClient(client_id || peek.client_id);
    const dpopRequired = Boolean(peekClient?.require_dpop || peek.dpop_jkt);
    const dpopPresent = typeof req.headers['dpop'] === 'string' && req.headers['dpop'].trim().length > 0;
    let dpopRes = null;
    if (dpopRequired || dpopPresent) {
      dpopRes = verifyRequestDpop(req, pathname, { required: true });
      if (!dpopRes.ok) {
        if (dpopRes.reason === 'use_dpop_nonce') return sendUseDpopNonce(res, dpopRes.freshNonce, true);
        return jsonError(res, 400, 'invalid_dpop_proof', dpopRes.reason || 'DPoP verification failed');
      }
      if (peek.dpop_jkt && dpopRes.jkt !== peek.dpop_jkt) {
        return jsonError(res, 400, 'invalid_dpop_proof', 'DPoP key thumbprint mismatch');
      }
    }
    const g = gatewayStore.consumeAuthCode(code, now());
    if (!g) return jsonError(res, 400, 'invalid_grant', 'unknown or expired code');
    const lane = laneForGrant(g);
    if (!lane || (laneHint && (lane.resource !== laneHint.resource || lane.issuer !== laneHint.issuer)))
      return jsonError(res, 400, 'invalid_target', 'authorization code belongs to a different OAuth lane');
    const client = peekClient;
    if (!client || (client_id && client_id !== g.client_id)) return jsonError(res, 400, 'invalid_grant', 'client mismatch');
    if (client.client_secret && !equalSecrets(client.client_secret, client_secret)) return jsonError(res, 401, 'invalid_client', 'client auth failed');
    if (redirect_uri !== g.redirect_uri) return jsonError(res, 400, 'invalid_grant', 'redirect_uri mismatch');
    if (!code_verifier) return jsonError(res, 400, 'invalid_request', 'code_verifier required');
    if (!isPkceVerifier(code_verifier)) return jsonError(res, 400, 'invalid_grant', 'PKCE verification failed');
    const expect = b64u(crypto.createHash('sha256').update(code_verifier).digest());
    const a = Buffer.from(expect); const b = Buffer.from(g.code_challenge);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return jsonError(res, 400, 'invalid_grant', 'PKCE verification failed');
    if (resource && resource !== lane.resource) return jsonError(res, 400, 'invalid_target', 'resource mismatch');

    if (dpopRes && dpopRes.used) {
      const family = randId().slice(0, 12);
      const accessTtlS = client.access_ttl_s || ACCESS_TTL_S;
      const label = typeof p.device_name === 'string' && p.device_name.trim()
        ? p.device_name.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 64)
        : (g.device_name || g.client_id);
      const preMint = mintDpopResponse({
        sub: 'jacen',
        client_id: g.client_id,
        scope: g.scope,
        lane,
        jkt: dpopRes.jkt,
        device_id: null,
        accessTtlS,
      });
      const issuedDev = gatewayStore.issueDpopGrant({
        sub: 'jacen',
        clientId: g.client_id,
        jkt: dpopRes.jkt,
        label,
        scope: g.scope,
        resource: lane.resource,
        issuer: lane.issuer,
        refreshToken: preMint.refresh_token,
        family,
        nowSec: now(),
        refreshTtlS: REFRESH_TTL_S,
        inactivityTtlS: INACTIVITY_TTL_S,
      });
      if (!issuedDev.ok) return jsonError(res, 400, 'invalid_grant', 'device has been revoked');
      // Re-mint access JWT carrying the bound device_id claim (`did`).
      const t = now();
      const access = signJwt({
        iss: lane.issuer, sub: 'jacen', aud: lane.resource, client_id: g.client_id,
        scope: g.scope, iat: t, exp: t + accessTtlS, jti: randId(),
        cnf: { jkt: dpopRes.jkt }, did: issuedDev.deviceId,
      });
      const response = {
        access_token: access,
        token_type: 'DPoP',
        expires_in: accessTtlS,
        refresh_token: preMint.refresh_token,
        scope: g.scope,
        device_id: issuedDev.deviceId,
      };
      reportAuth(lane.name, { clientId: g.client_id, subject: 'jacen' }, 'granted', undefined, isoFromSec(issuedDev.refreshExpiresAt), family);
      return send(res, 200, response, {
        'Cache-Control': 'no-store',
        'Pragma': 'no-cache',
        ...(dpopRes.freshNonce ? { 'DPoP-Nonce': dpopRes.freshNonce } : {}),
      });
    }

    const issued = issueTokens(g, lane);
    reportAuth(lane.name, { clientId: g.client_id, subject: 'jacen' }, 'granted', undefined, isoFromSec(refreshTokens[issued.refresh_token].exp), refreshTokens[issued.refresh_token].family);
    return send(res, 200, issued, { 'Cache-Control': 'no-store', 'Pragma': 'no-cache' });
  }
  if (grant_type === 'refresh_token') {
    const isDpopStoreToken = gatewayStore.hasRefreshToken(refresh_token);
    const reqClient = client_id ? await resolveClient(client_id) : null;
    if (isDpopStoreToken || reqClient?.require_dpop) {
      const dpopRes = verifyRequestDpop(req, pathname, { required: true });
      if (!dpopRes.ok) {
        if (dpopRes.reason === 'use_dpop_nonce') return sendUseDpopNonce(res, dpopRes.freshNonce, true);
        return jsonError(res, 400, 'invalid_dpop_proof', dpopRes.reason || 'DPoP verification failed');
      }
      if (!isDpopStoreToken) {
        console.log(`auth: refresh refused reason=refresh_unknown lane=${laneHint ? laneHint.name : '-'} client=${logSafe(client_id)}`);
        return jsonError(res, 400, 'invalid_grant', 'invalid refresh token', dpopRes.freshNonce ? { 'DPoP-Nonce': dpopRes.freshNonce } : {});
      }
      const laneTarget = laneHint || (resource === JC_RESOURCE ? JC_OAUTH_LANE : resource === RESOURCE ? DC_OAUTH_LANE : null);
      if (resource && !laneTarget) return jsonError(res, 400, 'invalid_target', 'unknown resource');
      const rot = gatewayStore.rotateDpopRefresh({
        presentedRefreshToken: refresh_token,
        presentedClientId: client_id,
        dpopJkt: dpopRes.jkt,
        refreshRequestId: refresh_request_id,
        expectedResource: laneTarget ? laneTarget.resource : undefined,
        expectedIssuer: laneTarget ? laneTarget.issuer : undefined,
        nowSec: now(),
        inactivityTtlS: INACTIVITY_TTL_S,
        recoveryTtlS: RECOVERY_TTL_S,
        mintTokens: ({ sub, client_id: cid, scope, resource: rRes, issuer: rIss, cnf_jkt, device_id, owner_iss, owner_sub }) => {
          const lane = rRes === JC_RESOURCE && rIss === JC_ISSUER ? JC_OAUTH_LANE : DC_OAUTH_LANE;
          const cDef = BUILTIN_CLIENTS[cid];
          const accessTtlS = cDef?.access_ttl_s || ACCESS_TTL_S;
          return mintDpopResponse({ sub, client_id: cid, scope, lane, jkt: cnf_jkt, device_id, accessTtlS, owner_iss, owner_sub });
        },
      });
      const nonceHeader = dpopRes.freshNonce ? { 'DPoP-Nonce': dpopRes.freshNonce } : {};
      if (!rot.ok) {
        console.log(`auth: refresh refused reason=${rot.reason} lane=${laneHint ? laneHint.name : 'jc'} client=${logSafe(rot.clientId || client_id)}`);
        if (rot.clientId && REPORTABLE_REFRESH_FAILURES.has(rot.reason)) {
          reportAuth(laneHint ? laneHint.name : 'jc', { clientId: rot.clientId, subject: 'jacen' }, 'refresh_failed', rot.reason, undefined, rot.family);
        }
        if (rot.reason === 'invalid_target') return jsonError(res, 400, 'invalid_target', 'refresh token belongs to a different OAuth lane', nonceHeader);
        return jsonError(res, 400, 'invalid_grant', rot.reason === 'refresh_reused' ? 'refresh_reused' : 'invalid refresh token', nonceHeader);
      }
      reportAuth(laneHint ? laneHint.name : 'jc', { clientId: rot.clientId, subject: 'jacen' }, 'refreshed', undefined, isoFromSec(rot.refreshExpiresAt), rot.family);
      return send(res, 200, rot.response, { 'Cache-Control': 'no-store', 'Pragma': 'no-cache', ...nonceHeader });
    }

    // Authenticate the client first (RFC 6749 section 6): a confidential client's refresh token alone is not enough.
    const known = Object.hasOwn(refreshTokens, refresh_token) ? refreshTokens[refresh_token] : undefined;
    const refreshClient = known ? await resolveClient(known.client_id) : null;
    // A record whose own client is gone from clients.json must not fall back to "public client". https ids are CIMD
    // documents, which never carry a secret, so an unreachable metadata host must not turn into a refusal.
    if (known && !refreshClient && !/^https:\/\//.test(String(known.client_id))) {
      console.log(`auth: refresh refused reason=client_unknown client=${logSafe(known.client_id)}`);
      return jsonError(res, 400, 'invalid_grant', 'invalid refresh token');
    }
    const resolved = resolveRefresh(refreshTokens, refresh_token, now(), {
      clientSecret: refreshClient && refreshClient.client_secret,
      presentedSecret: client_secret,
      presentedClientId: client_id,
    });
    const rejectedLane = known ? laneForGrant(known) : null;
    if (resolved.ok === false) {
      // Every refusal leaves a trace (reason, lane, client; never a token), whether or not reporting to ACS is on.
      console.log(`auth: refresh refused reason=${resolved.reason} lane=${rejectedLane ? rejectedLane.name : '-'} client=${logSafe(resolved.clientId || client_id)}`);
      if (rejectedLane && resolved.clientId && REPORTABLE_REFRESH_FAILURES.has(resolved.reason)) reportAuth(rejectedLane.name, { clientId: resolved.clientId, subject: 'jacen' }, 'refresh_failed', resolved.reason, undefined, known && known.family);
      if (resolved.reason === 'invalid_client') return jsonError(res, 401, 'invalid_client', 'client auth failed');
      return jsonError(res, 400, 'invalid_grant', 'invalid refresh token');
    }
    const rec = resolved.record;
    const lane = laneForGrant(rec);
    if (!lane || (laneHint && (lane.resource !== laneHint.resource || lane.issuer !== laneHint.issuer)))
      return jsonError(res, 400, 'invalid_target', 'refresh token belongs to a different OAuth lane');
    if (resource && resource !== lane.resource) return jsonError(res, 400, 'invalid_target', 'resource mismatch');
    rec.active = false;
    rec.rotatedAt = now();
    const t = issueTokens({ client_id: rec.client_id, scope: rec.scope }, lane, rec.family);
    rec.successor = t.refresh_token;
    saveJson(tokensFile, refreshTokens);
    reportAuth(lane.name, { clientId: rec.client_id, subject: 'jacen' }, 'refreshed', undefined, isoFromSec(refreshTokens[t.refresh_token].exp), rec.family);
    return send(res, 200, t, { 'Cache-Control': 'no-store', 'Pragma': 'no-cache' });
  }
  if (grant_type === 'urn:ietf:params:oauth:grant-type:device_code' && JC.enabled && (!laneHint || laneHint.name === 'jc')) {
    const dpopRes = verifyRequestDpop(req, pathname, { required: true });
    if (!dpopRes.ok) {
      if (dpopRes.reason === 'use_dpop_nonce') return sendUseDpopNonce(res, dpopRes.freshNonce, true);
      return jsonError(res, 400, 'invalid_dpop_proof', dpopRes.reason || 'DPoP verification failed');
    }
    const nonceHeader = dpopRes.freshNonce ? { 'DPoP-Nonce': dpopRes.freshNonce } : {};
    const client = await resolveClient(client_id);
    if (!client || client.oauth_lane !== 'jc' || !Array.isArray(client.grant_types) || !client.grant_types.includes('urn:ietf:params:oauth:grant-type:device_code')) {
      return jsonError(res, 400, 'invalid_client', 'client not authorized for device_code grant', nonceHeader);
    }
    if (!device_code) return jsonError(res, 400, 'invalid_request', 'device_code required', nonceHeader);
    const poll = gatewayStore.pollDeviceCode({
      deviceCode: device_code,
      clientId: client_id,
      dpopJkt: dpopRes.jkt,
      nowMs: Date.now(),
    });
    if (!poll.ok) {
      return send(res, 400, {
        error: poll.error,
        ...(poll.interval ? { interval: poll.interval } : {}),
        ...(poll.description ? { error_description: poll.description } : {}),
      }, { 'Cache-Control': 'no-store', 'Pragma': 'no-cache', ...nonceHeader });
    }
    const family = randId().slice(0, 12);
    const accessTtlS = client.access_ttl_s || ACCESS_TTL_S;
    const preMint = mintDpopResponse({
      sub: poll.sub,
      client_id: poll.client_id,
      scope: poll.scope,
      lane: JC_OAUTH_LANE,
      jkt: dpopRes.jkt,
      device_id: null,
      accessTtlS,
    });
    const issuedDev = gatewayStore.issueDpopGrant({
      ownerIss: poll.owner_iss,
      ownerSub: poll.owner_sub,
      sub: poll.sub,
      clientId: poll.client_id,
      jkt: dpopRes.jkt,
      label: poll.device_name || poll.client_id,
      scope: poll.scope,
      resource: JC_OAUTH_LANE.resource,
      issuer: JC_OAUTH_LANE.issuer,
      refreshToken: preMint.refresh_token,
      family,
      nowSec: now(),
      refreshTtlS: REFRESH_TTL_S,
      inactivityTtlS: INACTIVITY_TTL_S,
    });
    if (!issuedDev.ok) return jsonError(res, 400, 'invalid_grant', 'device has been revoked', nonceHeader);
    const t = now();
    const access = signJwt({
      iss: JC_OAUTH_LANE.issuer, sub: poll.sub, aud: JC_OAUTH_LANE.resource, client_id: poll.client_id,
      scope: poll.scope, iat: t, exp: t + accessTtlS, jti: randId(),
      cnf: { jkt: dpopRes.jkt }, did: issuedDev.deviceId,
      ...(poll.owner_iss && poll.owner_sub ? { oiss: poll.owner_iss, osub: poll.owner_sub } : {}),
    });
    const response = {
      access_token: access,
      token_type: 'DPoP',
      expires_in: accessTtlS,
      refresh_token: preMint.refresh_token,
      scope: poll.scope,
      device_id: issuedDev.deviceId,
    };
    reportAuth('jc', { clientId: poll.client_id, subject: poll.sub }, 'granted', undefined, isoFromSec(issuedDev.refreshExpiresAt), family);
    return send(res, 200, response, { 'Cache-Control': 'no-store', 'Pragma': 'no-cache', ...nonceHeader });
  }
  return jsonError(res, 400, 'unsupported_grant_type', 'supported: authorization_code, refresh_token');
}

async function handleDeviceCode(req, res, body) {
  let p;
  const ct = String(req.headers['content-type'] || '');
  if (ct.includes('application/json')) {
    try { p = JSON.parse(body.toString('utf8')); } catch { return jsonError(res, 400, 'invalid_request', 'invalid JSON'); }
  } else {
    p = parseTokenBody(body);
  }
  const clientId = typeof p.client_id === 'string' ? p.client_id : '';
  const client = await resolveClient(clientId);
  if (!client || client.oauth_lane !== 'jc' || !Array.isArray(client.grant_types) || !client.grant_types.includes('urn:ietf:params:oauth:grant-type:device_code')) {
    return jsonError(res, 400, 'invalid_client', 'client not authorized for device authorization');
  }
  const reqScope = String(p.scope || 'mcp').split(' ').filter((s) => s === 'mcp' || s === 'openid' || s === 'email' || s === 'profile');
  if (reqScope.length === 0) return jsonError(res, 400, 'invalid_scope', 'no permitted scope requested');
  const dpopJkt = typeof p.dpop_jkt === 'string' && p.dpop_jkt.length > 0 ? p.dpop_jkt : null;
  if (dpopJkt && !isValidJkt(dpopJkt)) return jsonError(res, 400, 'invalid_request', 'malformed dpop_jkt');
  const deviceName = typeof p.device_name === 'string'
    ? p.device_name.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 64) || null
    : null;
  const deviceCode = randId();
  const userCode = randomUserCode();
  const t = now();
  gatewayStore.createDeviceCode({
    deviceCode,
    userCode,
    clientId,
    scope: reqScope.join(' '),
    resource: JC_RESOURCE,
    issuer: JC_ISSUER,
    dpopJkt,
    deviceName,
    intervalS: DEVICE_INTERVAL_S,
    expiresAt: t + DEVICE_CODE_TTL_S,
    nowSec: t,
  });
  const verificationUri = `${PUBLIC_ORIGIN_CANONICAL}/jc/device`;
  return send(res, 200, {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(userCode)}`,
    expires_in: DEVICE_CODE_TTL_S,
    interval: DEVICE_INTERVAL_S,
  }, { 'Cache-Control': 'no-store', 'Pragma': 'no-cache' });
}

function handleDeviceVerifyPage(req, res, q) {
  const prefill = typeof q.user_code === 'string' ? q.user_code.replace(/[^A-Za-z0-9-]/g, '').slice(0, 16) : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Jace Commander CLI - Device Verification</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui,sans-serif;background:#111;color:#eee;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#1c1c1c;padding:2rem;border-radius:12px;max-width:420px;width:90%}h1{font-size:1.1rem}
input{width:100%;padding:.6rem;margin:.5rem 0 1rem;border-radius:6px;border:1px solid #444;background:#252525;color:#eee;box-sizing:border-box}
.row{display:flex;gap:.75rem}button{flex:1;padding:.7rem;border:0;border-radius:6px;background:#4f8cff;color:#fff;font-size:1rem;cursor:pointer}
button.deny{background:#555}</style></head>
<body><div class="card"><h1>Authorize Jace Commander CLI device?</h1>
<p>Confirm the user code shown in your terminal for <code>${esc(JC_RESOURCE)}</code>.</p>
<form method="POST" action="/jc/device">
<label>Device code<input type="text" name="user_code" value="${esc(prefill)}" autocomplete="off" required></label>
<label>Consent passphrase<input type="password" name="passphrase" autocomplete="off" required></label>
<div class="row"><button type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny" class="deny">Deny</button></div></form></div></body></html>`;
  return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
}

async function handleDeviceDecision(req, res, body) {
  const HTML_HDR = { 'Content-Type': 'text/html; charset=utf-8' };
  // RFC 6749 section 3.2: a repeated field is ambiguous (decision=deny&decision=approve), so it is refused outright,
  // before any credential check, rather than letting the parser's last-wins rule choose for the user.
  const parsed = parseFormStrict(body);
  if (!parsed.ok) return send(res, 400, denyPage(parsed.reason === 'duplicate_field' ? 'Duplicate form field.' : 'Invalid form.'), HTML_HDR);
  const params = parsed.params;
  // No caller identity exists on this path (the ingress strips X-Forwarded-*), so repeated failures only slow responses down.
  // A hard lock keyed on the shared proxy address would let one caller lock out the owner.
  const delay = legacyPassphraseThrottle.delayMs(LEGACY_THROTTLE_KEY);
  if (delay > 0) await sleepMs(delay);
  const pass = params.passphrase || '';
  const passOk = pass.length > 0 && crypto.timingSafeEqual(
    Buffer.from(crypto.createHash('sha256').update(pass).digest()),
    Buffer.from(crypto.createHash('sha256').update(CONSENT_PASSPHRASE).digest()));
  if (!passOk) {
    legacyPassphraseThrottle.fail(LEGACY_THROTTLE_KEY);
    return send(res, 401, denyPage('Invalid consent passphrase.'), HTML_HDR);
  }
  legacyPassphraseThrottle.clear(LEGACY_THROTTLE_KEY);
  const userCode = normalizeUserCode(params.user_code || '');
  if (!userCode) return send(res, 400, denyPage('Missing user code.'), HTML_HDR);
  if (params.decision && params.action && params.decision !== params.action) {
    return send(res, 400, denyPage('Conflicting decision parameters.'), HTML_HDR);
  }
  const decision = params.decision ?? params.action;
  if (decision !== 'approve' && decision !== 'deny') {
    return send(res, 400, denyPage('Invalid decision; expected approve or deny.'), HTML_HDR);
  }
  const result = gatewayStore.decideDeviceCode({ userCode, decision, sub: 'jacen', nowSec: now() });
  if (!result.ok) return send(res, 400, denyPage('Unknown, expired, or already used device code.'), HTML_HDR);
  const msg = result.status === 'denied'
    ? 'Device authorization denied. You may close this tab.'
    : 'Device authorized for Jace Commander CLI. You may close this tab.';
  return send(res, 200, denyPage(msg), HTML_HDR);
}

// ---- Jace Auth (OIDC) owner consent: sign in, review the exact enrollment, explicitly approve ----
const OWNER_HTML = { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CONSENT_PAGE_CSP };
const ownerHtml = (res, status, body, extra = {}) => send(res, status, body, { ...OWNER_HTML, ...extra });
const formatUserCode = (c) => (c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c);
function strictQuery(url) {
  const parsed = parseFormStrict(new URL(url, 'http://localhost').search.slice(1));
  return parsed.ok ? parsed.params : null;
}

async function handleOwnerDevicePage(req, res) {
  const q = strictQuery(req.url);
  if (!q) return ownerHtml(res, 400, messagePage('Invalid or duplicated query parameter.'));
  const userCode = normalizeUserCode(typeof q.user_code === 'string' ? q.user_code : '').slice(0, 16);
  const session = ownerConsent.session(req.headers['cookie']);
  if (!session) {
    let login;
    try { login = await ownerConsent.startLogin({ userCode: userCode || null }); }
    catch (err) {
      console.warn(`gateway: owner sign-in unavailable: ${logSafe(err && err.message)}`);
      return ownerHtml(res, 502, messagePage('The sign-in provider is unavailable. Try again shortly.'));
    }
    return send(res, 302, '', { Location: login.location, 'Set-Cookie': login.setCookie, 'Referrer-Policy': 'no-referrer' });
  }
  if (!userCode) return ownerHtml(res, 200, codeEntryPage());
  const lock = ownerDecisionThrottle.check(session.sid);
  if (lock.locked) return ownerHtml(res, 429, messagePage('Too many attempts. Try again later.'), { 'Retry-After': String(lock.retryAfterS) });
  const pending = gatewayStore.findPendingDeviceCode(userCode, now());
  if (!pending) {
    ownerDecisionThrottle.fail(session.sid);
    return ownerHtml(res, 404, codeEntryPage('Unknown, expired, or already used code.'));
  }
  return ownerHtml(res, 200, ownerConsentPage({
    clientId: pending.clientId,
    deviceName: pending.deviceName,
    scope: pending.scope,
    userCode: formatUserCode(userCode),
    expiresAt: pending.expiresAt,
    ownerSub: session.sub,
    csrf: session.csrf,
    binding: ownerConsent.bindingFor(session, pending.userCodeHash, pending.createdAt),
    keyBound: pending.dpopBound,
  }));
}

async function handleOwnerDeviceCallback(req, res) {
  const q = strictQuery(req.url);
  const result = q
    ? await ownerConsent.completeLogin({ query: q, cookieHeader: req.headers['cookie'] })
    : { ok: false, status: 400, reason: 'duplicate_query', clearCookie: ownerConsent.clearTxCookie() };
  if (!result.ok) {
    console.warn(`gateway: owner sign-in refused reason=${logSafe(result.reason)}`);
    const msg = result.status === 403 ? 'This account is not permitted to approve devices.'
      : result.status === 502 ? 'The sign-in provider is unavailable. Try again shortly.'
      : 'Sign-in could not be completed. Open the link from your terminal again.';
    return ownerHtml(res, result.status, messagePage(msg), { 'Set-Cookie': result.clearCookie });
  }
  const to = result.userCode ? `/jc/device?user_code=${encodeURIComponent(result.userCode)}` : '/jc/device';
  return send(res, 302, '', { Location: to, 'Set-Cookie': [result.clearCookie, result.sessionCookie], 'Referrer-Policy': 'no-referrer' });
}

async function handleOwnerDeviceDecision(req, res, body) {
  const session = ownerConsent.session(req.headers['cookie']);
  if (!session) return ownerHtml(res, 401, messagePage('Sign in required. Open the link from your terminal again.'));
  const lock = ownerDecisionThrottle.check(session.sid);
  if (lock.locked) return ownerHtml(res, 429, messagePage('Too many attempts. Try again later.'), { 'Retry-After': String(lock.retryAfterS) });
  const refuse = (status, msg) => { ownerDecisionThrottle.fail(session.sid); return ownerHtml(res, status, messagePage(msg)); };
  const parsed = parseFormStrict(body);
  if (!parsed.ok) return refuse(400, parsed.reason === 'duplicate_field' ? 'Duplicate form field.' : 'Invalid form.');
  const p = parsed.params;
  // Only the consent page's own fields. A passphrase or legacy `action` field is never a way to approve in this mode.
  if (Object.keys(p).some((k) => !['user_code', 'csrf', 'binding', 'decision'].includes(k))) return refuse(400, 'Unsupported field.');
  if (typeof p.csrf !== 'string' || !safeEqual(p.csrf, session.csrf)) return refuse(403, 'Invalid or missing form token. Reload the page from your terminal link.');
  if (p.decision !== 'approve' && p.decision !== 'deny') return refuse(400, 'Invalid decision; expected approve or deny.');
  const userCode = normalizeUserCode(p.user_code || '').slice(0, 16);
  const pending = userCode ? gatewayStore.findPendingDeviceCode(userCode, now()) : null;
  if (!pending) return refuse(404, 'Unknown, expired, or already used code.');
  const expected = ownerConsent.bindingFor(session, pending.userCodeHash, pending.createdAt);
  if (typeof p.binding !== 'string' || !safeEqual(p.binding, expected)) {
    return refuse(403, 'This approval was not issued for this session and code. Reload the page from your terminal link.');
  }
  const result = gatewayStore.decideDeviceCode({
    userCode, decision: p.decision, sub: 'jacen', ownerIss: session.iss, ownerSub: session.sub, nowSec: now(),
  });
  if (!result.ok) return refuse(404, 'Unknown, expired, or already used code.');
  ownerDecisionThrottle.clear(session.sid);
  console.log(`auth: device ${result.status} client=${logSafe(result.clientId)} owner=${logSafe(session.sub)}`);
  // The session is single-use: the next enrollment signs in again.
  return ownerHtml(res, 200, messagePage(result.status === 'denied'
    ? 'Device authorization denied. You may close this tab.'
    : 'Device authorized for Jace Commander CLI. You may close this tab.'), { 'Set-Cookie': ownerConsent.clearSessionCookie() });
}

// Dynamic client registration is unauthenticated; bound its rate so a flood cannot starve /mcp (each write is a full, fsynced rewrite).
const registrations = [];
const REGISTER_LIMIT_PER_MIN = 60;
async function handleRegister(req, res, body, lane = DC_OAUTH_LANE) {
  const t0 = Date.now();
  while (registrations.length && t0 - registrations[0] > 60_000) registrations.shift();
  if (registrations.length >= REGISTER_LIMIT_PER_MIN) return jsonError(res, 429, 'temporarily_unavailable', 'too many registrations; retry later', { 'Retry-After': '30' });
  registrations.push(t0);
  let meta;
  try { meta = JSON.parse(body.toString('utf8')); } catch { return jsonError(res, 400, 'invalid_client_metadata', 'body must be JSON'); }
  const uris = meta.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 20 || !uris.every(isAllowedRedirectUri))
    return jsonError(res, 400, 'invalid_redirect_uri', 'redirect_uris must be 1-20 https (or loopback http) URIs without fragments or userinfo');
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
// Bearer + DPoP validation for /mcp, /jc/mcp, and /jc/devices*
// ---------------------------------------------------------------------------
const CHALLENGE = () => 'Bearer resource_metadata="' + ISSUER + '/.well-known/oauth-protected-resource", scope="mcp"';
const JC_CHALLENGE = () => 'Bearer resource_metadata="' + ISSUER + '/.well-known/oauth-protected-resource/jc/mcp", scope="mcp"';
const DPOP_CHALLENGE = () => 'DPoP algs="EdDSA ES256", resource_metadata="' + ISSUER + '/.well-known/oauth-protected-resource", scope="mcp"';
const JC_DPOP_CHALLENGE = () => 'DPoP algs="EdDSA ES256", resource_metadata="' + ISSUER + '/.well-known/oauth-protected-resource/jc/mcp", scope="mcp"';

function authenticateRequest(
  req,
  res,
  { expectedResource = RESOURCE, expectedIssuer = ISSUER, baseChallenge = CHALLENGE(), dpopBaseChallenge = DPOP_CHALLENGE(), laneName = 'dc', pathname, requireDpop = false },
) {
  const authResult = classifyTokenAuth(req.headers['authorization'] || '', {
    signingKey: SIGNING_KEY,
    issuer: expectedIssuer,
    resource: expectedResource,
    nowSec: now(),
  });
  if (!authResult.ok) {
    log(req.method, pathname, 401, `auth required (${authResult.reason})`);
    if (authResult.clientId && authResult.reason === 'expired') {
      reportAuth(laneName, { clientId: authResult.clientId, subject: authResult.subject }, 'token_rejected', authResult.reason);
    }
    const hasDpopHeader = typeof req.headers['dpop'] === 'string' && req.headers['dpop'].trim().length > 0;
    if (authResult.scheme === 'dpop' || hasDpopHeader || (requireDpop && authResult.reason === 'missing')) {
      send(res, 401, { error: 'unauthorized' }, {
        'WWW-Authenticate': dpopChallenge(dpopBaseChallenge, authResult.reason),
        'DPoP-Nonce': dpopNonces.issue(now()),
      });
      return null;
    }
    send(res, 401, { error: 'unauthorized' }, {
      'WWW-Authenticate': bearerChallenge(baseChallenge, authResult.reason),
      ...(DPOP_NONCE_REQUIRED ? { 'DPoP-Nonce': dpopNonces.issue(now()) } : {}),
    });
    return null;
  }

  const payload = authResult.payload;
  const boundJkt = payload && payload.cnf && typeof payload.cnf.jkt === 'string' ? payload.cnf.jkt : null;
  if (boundJkt || requireDpop) {
    if (authResult.scheme !== 'dpop' || !boundJkt) {
      log(req.method, pathname, 401, 'dpop required');
      send(res, 401, { error: 'unauthorized' }, {
        'WWW-Authenticate': dpopChallenge(dpopBaseChallenge, 'dpop_required'),
        'DPoP-Nonce': dpopNonces.issue(now()),
      });
      return null;
    }
    const dpopRes = verifyRequestDpop(req, pathname, { required: true, accessToken: authResult.token });
    const nonce = dpopRes.freshNonce || dpopNonces.issue(now());
    if (!dpopRes.ok) {
      const mapped =
        dpopRes.reason === 'use_dpop_nonce'
          ? 'use_dpop_nonce'
          : dpopRes.reason === 'replayed_jti'
            ? 'dpop_replay'
            : 'dpop_invalid';
      log(req.method, pathname, 401, `dpop rejected (${dpopRes.reason})`);
      send(res, 401, { error: mapped === 'use_dpop_nonce' ? 'use_dpop_nonce' : 'unauthorized' }, {
        'WWW-Authenticate': dpopChallenge(dpopBaseChallenge, mapped),
        'DPoP-Nonce': nonce,
      });
      return null;
    }
    if (dpopRes.jkt !== boundJkt) {
      log(req.method, pathname, 401, 'dpop jkt mismatch');
      send(res, 401, { error: 'unauthorized' }, {
        'WWW-Authenticate': dpopChallenge(dpopBaseChallenge, 'dpop_invalid'),
        'DPoP-Nonce': nonce,
      });
      return null;
    }
    if (gatewayStore.isDeviceOrJktRevoked(payload.did, boundJkt)) {
      log(req.method, pathname, 401, 'device revoked');
      send(res, 401, { error: 'unauthorized' }, {
        'WWW-Authenticate': dpopChallenge(dpopBaseChallenge, 'device_revoked'),
        'DPoP-Nonce': nonce,
      });
      return null;
    }
    gatewayStore.touchDevice(payload.did, now());
    res.setHeader('DPoP-Nonce', nonce);
    return payload;
  }

  if (authResult.scheme !== 'bearer') {
    log(req.method, pathname, 401, 'bearer token sent with dpop scheme');
    send(res, 401, { error: 'unauthorized' }, {
      'WWW-Authenticate': dpopChallenge(dpopBaseChallenge, 'dpop_invalid'),
      'DPoP-Nonce': dpopNonces.issue(now()),
    });
    return null;
  }
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
          try {
            await completeRuntimeBootstrap(initializeManaged, identity, challenge, runtimeIdentity);
          } catch (error) {
            // ACS rejection keeps its explicit code; transport failures have a
            // distinct, non-sensitive code so intermittent CI failures are diagnosable.
            if (error && error.acsCode) throw error;
            throw Object.assign(new Error('ACS bootstrap completion unavailable'), { acsCode: 'bootstrap_complete_unavailable' });
          }
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
async function checkAcsIssuanceReady(config = MANAGED) {
  if (!config.enabled || !config.acsGatewayUrl) return { reachable: false, detail: 'ACS managed issuance not configured' };
  try {
    const url = new URL('/readyz', config.acsGatewayUrl);
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

    if (pathName === '/jc/ready' && req.method === 'GET') {
      const configured = !!(JC.enabled && !JC.acsOptional && !JC_LOCAL.enabled && JC.acsGatewayUrl && JC.acsGatewayToken && GATEWAY_EXECUTION_TOKEN);
      const [acs, bridge] = configured
        ? await Promise.all([checkAcsIssuanceReady(JC), fetchBridgeAuthority(JC_UPSTREAM)])
        : [{ reachable: false }, { ok: false }];
      const bridgeReady = bridge.ok && jcBridgeReady(bridge.data);
      const issuanceReady = acs.reachable === true;
      const ready = configured && bridgeReady && issuanceReady;
      log('GET', '/jc/ready', ready ? 200 : 503);
      return send(res, ready ? 200 : 503, { ready, configured, bridgeReady, issuanceReady });
    }

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
      // The edge applies the bridge's own /ready predicate (readiness.js) to the
      // bridge's /authority JSON, so an ambiguous, expired, malformed, or
      // process-mismatched executor lease the bridge rejects can never make the
      // edge ready. A jc bridge on UPSTREAM (variant !== 'dc') is never ready.
      const bridgeReady = bridgeAuthority.ok && dcBridgeReady(bridgeAuthority.data, { managed: MANAGED.enabled });
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
      await handleToken(req, res, body, lane, '/token'); log('POST', '/token', res.statusCode); return;
    }
    if (JC.enabled && pathName === '/jc/oauth/token' && req.method === 'POST') {
      const body = await readBody(req);
      await handleToken(req, res, body, JC_OAUTH_LANE, '/jc/oauth/token'); log('POST', '/jc/oauth/token', res.statusCode); return;
    }
    if (JC.enabled && pathName === '/jc/oauth/device/code' && req.method === 'POST') {
      const body = await readBody(req);
      await handleDeviceCode(req, res, body); log('POST', '/jc/oauth/device/code', res.statusCode); return;
    }
    if (JC.enabled && ownerConsent && pathName === '/jc/device/callback' && req.method === 'GET') {
      await handleOwnerDeviceCallback(req, res); log('GET', '/jc/device/callback', res.statusCode); return;
    }
    if (JC.enabled && pathName === '/jc/device' && req.method === 'GET') {
      if (ownerConsent) await handleOwnerDevicePage(req, res);
      else handleDeviceVerifyPage(req, res, parseQuery(req.url));
      log('GET', '/jc/device', res.statusCode); return;
    }
    if (JC.enabled && pathName === '/jc/device' && req.method === 'POST') {
      const body = await readBody(req);
      if (ownerConsent) await handleOwnerDeviceDecision(req, res, body);
      else await handleDeviceDecision(req, res, body);
      log('POST', '/jc/device', res.statusCode); return;
    }
    if (JC.enabled && pathName === '/jc/devices' && req.method === 'GET') {
      const auth = authenticateRequest(req, res, {
        expectedResource: JC_RESOURCE,
        expectedIssuer: JC_ISSUER,
        baseChallenge: JC_CHALLENGE(),
        dpopBaseChallenge: JC_DPOP_CHALLENGE(),
        laneName: 'jc',
        pathname: '/jc/devices',
        requireDpop: true,
      });
      if (!auth) return;
      send(res, 200, { devices: gatewayStore.listDevices(auth.sub, ownerScope(auth)) });
      log('GET', '/jc/devices', 200);
      return;
    }
    if (JC.enabled) {
      const revPost = req.method === 'POST' ? /^\/jc\/devices\/([A-Za-z0-9_-]{1,128})\/revoke$/.exec(pathName) : null;
      const revDel = req.method === 'DELETE' ? /^\/jc\/devices\/([A-Za-z0-9_-]{1,128})$/.exec(pathName) : null;
      const match = revPost || revDel;
      if (match) {
        const auth = authenticateRequest(req, res, {
          expectedResource: JC_RESOURCE,
          expectedIssuer: JC_ISSUER,
          baseChallenge: JC_CHALLENGE(),
          dpopBaseChallenge: JC_DPOP_CHALLENGE(),
          laneName: 'jc',
          pathname: pathName,
          requireDpop: true,
        });
        if (!auth) return;
        const result = gatewayStore.revokeDevice(match[1], auth.sub, now(), ownerScope(auth));
        if (!result.found) {
          send(res, 404, { error: 'not_found' });
          log(req.method, pathName, 404);
          return;
        }
        send(res, 200, { revoked: true, device_id: result.deviceId });
        log(req.method, pathName, 200);
        return;
      }
    }
    if (pathName === '/register' && req.method === 'POST') {
      const body = await readBody(req);
      const q = parseQuery(req.url);
      const lane = JC.enabled && q.oauth_lane === 'jc' ? JC_OAUTH_LANE : DC_OAUTH_LANE;
      await handleRegister(req, res, body, lane); log('POST', '/register', res.statusCode); return;
    }

    // ---- MCP proxy (auth required, all methods) ----
    if (pathName === '/mcp') {
      const auth = authenticateRequest(req, res, {
        expectedResource: RESOURCE,
        expectedIssuer: ISSUER,
        baseChallenge: CHALLENGE(),
        dpopBaseChallenge: DPOP_CHALLENGE(),
        laneName: 'dc',
        pathname: '/mcp',
      });
      if (!auth) return;
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
      const auth = authenticateRequest(req, res, {
        expectedResource: JC_RESOURCE,
        expectedIssuer: JC_ISSUER,
        baseChallenge: JC_CHALLENGE(),
        dpopBaseChallenge: JC_DPOP_CHALLENGE(),
        laneName: 'jc',
        pathname: '/jc/mcp',
      });
      if (!auth) return;
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
            const jcToolName = typeof parsed?.params?.name === 'string' ? parsed.params.name : '';
            if (JC_LOCAL.enabled && JC_LOCAL.isLocal(jcToolName)) {
              // No ACS issuance; client-supplied authority metadata is still stripped.
              body = Buffer.from(JSON.stringify(stripAuthorityMeta(parsed)), 'utf8');
              log(req.method, '/jc/mcp', 200, `jc local: no ACS issuance for ${jcToolName}`);
            } else {
              const rewrite = capabilityTransport(JC, { identity: identityAttribution(auth, jcClaims), requestId: randId() });
              body = Buffer.from(JSON.stringify(await rewrite(parsed)), 'utf8');
            }
          } catch (e) {
            // Local preset: an unreachable ACS is the distinct, actionable ACS_UNAVAILABLE
            // (managed keeps acs_http_unreachable so its responses are unchanged).
            if (JC_LOCAL.enabled && e && e.acsCode === 'acs_http_unreachable') e.acsCode = 'ACS_UNAVAILABLE';
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
