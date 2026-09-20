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
import { managedModeFromEnv, identityAttribution, capabilityTransport, isToolsCall } from './managed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Configuration (from protected env file; no secrets inline)
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.GATEWAY_PORT || '8010', 10);
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || ''; // e.g. https://jacen-ubuntu.tailaa6d41.ts.net
const RESOURCE = process.env.RESOURCE || `${PUBLIC_ORIGIN}/mcp`;
const ISSUER = process.env.ISSUER || PUBLIC_ORIGIN;
const UPSTREAM = process.env.UPSTREAM || 'http://127.0.0.1:8002';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CONSENT_PASSPHRASE = process.env.CONSENT_PASSPHRASE || '';
const SIGNING_KEY = process.env.SIGNING_KEY || ''; // hex
const GATEWAY_EXECUTION_TOKEN = process.env.GATEWAY_EXECUTION_TOKEN || ''; // optional; enables executor identity attestation
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 30 * 24 * 3600;
const CODE_TTL_S = 300;
const MAX_BODY = 2 * 1024 * 1024; // 2 MB

for (const [k, v] of Object.entries({ PUBLIC_ORIGIN, CONSENT_PASSPHRASE, SIGNING_KEY })) {
  if (!v) { console.error(`gateway: missing required env ${k}; refusing to start`); process.exit(1); }
}
let MANAGED = { enabled: false };
try {
  MANAGED = managedModeFromEnv();
  if (MANAGED.enabled) console.log('gateway: ACS MANAGED MODE enabled (capabilities issued by ACS only; no standalone fallback)');
} catch (e) {
  console.error(`gateway: ${e.message}`);
  process.exit(1);
}
if (!GATEWAY_EXECUTION_TOKEN) console.log('gateway: GATEWAY_EXECUTION_TOKEN not set; executor identity attestation disabled (log-once)');
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

const META = {
  resource: RESOURCE,
  authorization_servers: [ISSUER],
  scopes_supported: ['mcp'],
};

const AS_META = () => ({
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  registration_endpoint: `${ISSUER}/register`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
  scopes_supported: ['mcp'],
  client_id_metadata_document_supported: true,
  authorization_response_iss_parameter_supported: true,
  resource: RESOURCE,
  service_documentation: `${ISSUER}/`,
});

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
function consentPage(q) {
  const hidden = Object.entries(q)
    .filter(([k]) => ['client_id', 'redirect_uri', 'response_type', 'scope', 'state', 'code_challenge', 'code_challenge_method', 'resource'].includes(k))
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('\n');
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
<code>${esc(RESOURCE)}</code>.</p>
<p class="warn">Full Desktop Commander access (shell, filesystem). Only approve clients you trust.</p>
<form method="POST" action="/authorize/consent">
${hidden}
<label>Consent passphrase<input type="password" name="passphrase" autocomplete="off" required></label>
<button type="submit">Authorize</button></form></div></body></html>`;
}

function denyPage(msg) {
  return `<!doctype html><html><body style="font-family:system-ui;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh"><p>${esc(msg)}</p></body></html>`;
}

function parseQuery(url) { return Object.fromEntries(new URL(url).searchParams.entries()); }

async function handleAuthorize(req, res, q) {
  const { client_id, redirect_uri, response_type, code_challenge, code_challenge_method, scope, state, resource } = q;
  if (!client_id || !redirect_uri) return jsonError(res, 400, 'invalid_request', 'client_id and redirect_uri required');
  const client = await resolveClient(client_id);
  if (!client) return send(res, 400, denyPage('Unknown client.'), { 'Content-Type': 'text/html; charset=utf-8' });
  if (!validRedirect(client, redirect_uri)) return send(res, 400, denyPage('redirect_uri not registered for this client.'), { 'Content-Type': 'text/html; charset=utf-8' });
  const fail = (code, desc) => {
    const u = new URL(redirect_uri);
    u.searchParams.set('error', code); u.searchParams.set('error_description', desc);
    if (state) u.searchParams.set('state', state);
    if (ISSUER && q.iss !== undefined) u.searchParams.set('iss', ISSUER);
    return redirect(res, u.toString());
  };
  if (response_type !== 'code') return fail('unsupported_response_type', 'response_type must be code');
  if (!code_challenge || code_challenge_method !== 'S256') return fail('invalid_request', 'PKCE with S256 is required');
  if (/[^A-Za-z0-9\-._~]/.test(code_challenge) || code_challenge.length < 43 || code_challenge.length > 128)
    return fail('invalid_request', 'malformed code_challenge');
  if (resource && resource !== RESOURCE) return fail('invalid_target', 'resource mismatch');
  const reqScope = (scope || 'mcp').split(' ').filter((s) => s === 'mcp' || s === 'openid' || s === 'email' || s === 'profile');
  if (reqScope.length === 0) return fail('invalid_scope', 'no permitted scope requested');
  return send(res, 200, consentPage(q), { 'Content-Type': 'text/html; charset=utf-8' });
}

async function handleConsent(req, res, body) {
  const params = Object.fromEntries(new URLSearchParams(body.toString('utf8')).entries());
  const { client_id, redirect_uri, scope, state, code_challenge, resource } = params;
  const pass = params.passphrase || '';
  const passOk = pass.length > 0 && crypto.timingSafeEqual(
    Buffer.from(crypto.createHash('sha256').update(pass).digest()),
    Buffer.from(crypto.createHash('sha256').update(CONSENT_PASSPHRASE).digest()));
  if (!passOk) return send(res, 401, denyPage('Invalid consent passphrase.'), { 'Content-Type': 'text/html; charset=utf-8' });
  const client = await resolveClient(client_id);
  if (!client || !validRedirect(client, redirect_uri)) return send(res, 400, denyPage('Invalid client/redirect.'), { 'Content-Type': 'text/html; charset=utf-8' });
  const code = randId();
  codes.set(code, {
    client_id, redirect_uri, scope: scope || 'mcp', resource: resource || RESOURCE,
    code_challenge, exp: now() + CODE_TTL_S,
  });
  const u = new URL(redirect_uri);
  u.searchParams.set('code', code);
  if (state) u.searchParams.set('state', state);
  u.searchParams.set('iss', ISSUER);
  return redirect(res, u.toString());
}

const codes = new Map(); // code -> grant data
setInterval(() => { const t = now(); for (const [c, g] of codes) if (g.exp < t) codes.delete(c); }, 60_000);

function issueTokens(grant) {
  const t = now();
  const jti = randId();
  const access = signJwt({
    iss: ISSUER, sub: 'jacen', aud: grant.resource || RESOURCE, client_id: grant.client_id,
    scope: grant.scope, iat: t, exp: t + ACCESS_TTL_S, jti,
  });
  const rjti = randId();
  refreshTokens[rjti] = { client_id: grant.client_id, scope: grant.scope, resource: grant.resource || RESOURCE, exp: t + REFRESH_TTL_S, active: true };
  saveJson(tokensFile, refreshTokens);
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: rjti, scope: grant.scope };
}

async function handleToken(req, res, body) {
  const p = Object.fromEntries(new URLSearchParams(body.toString('utf8')).entries());
  const { grant_type, code, code_verifier, redirect_uri, client_id, client_secret, refresh_token, resource } = p;
  if (grant_type === 'authorization_code') {
    const g = code ? codes.get(code) : null;
    if (!g) return jsonError(res, 400, 'invalid_grant', 'unknown or expired code');
    codes.delete(code); // one-time use, even on failure paths below
    const client = await resolveClient(client_id || g.client_id);
    if (!client || (client_id && client_id !== g.client_id)) return jsonError(res, 400, 'invalid_grant', 'client mismatch');
    if (client.client_secret && client_secret !== client.client_secret) return jsonError(res, 401, 'invalid_client', 'client auth failed');
    if (redirect_uri !== g.redirect_uri) return jsonError(res, 400, 'invalid_grant', 'redirect_uri mismatch');
    if (!code_verifier) return jsonError(res, 400, 'invalid_request', 'code_verifier required');
    const expect = b64u(crypto.createHash('sha256').update(code_verifier).digest());
    const a = Buffer.from(expect); const b = Buffer.from(g.code_challenge);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return jsonError(res, 400, 'invalid_grant', 'PKCE verification failed');
    if (resource && resource !== g.resource) return jsonError(res, 400, 'invalid_target', 'resource mismatch');
    return send(res, 200, issueTokens(g), { 'Cache-Control': 'no-store', 'Pragma': 'no-cache' });
  }
  if (grant_type === 'refresh_token') {
    const rec = refreshTokens[refresh_token];
    if (!rec || !rec.active || rec.exp < now()) return jsonError(res, 400, 'invalid_grant', 'invalid refresh token');
    if (resource && resource !== rec.resource) return jsonError(res, 400, 'invalid_target', 'resource mismatch');
    rec.active = false; // rotation: old refresh token single-use
    const t = issueTokens({ client_id: rec.client_id, scope: rec.scope, resource: rec.resource });
    return send(res, 200, t, { 'Cache-Control': 'no-store', 'Pragma': 'no-cache' });
  }
  return jsonError(res, 400, 'unsupported_grant_type', 'supported: authorization_code, refresh_token');
}

async function handleRegister(req, res, body) {
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
const CHALLENGE = () => `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource", scope="mcp"`;

function checkAuth(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return null;
  const payload = verifyJwt(m[1].trim());
  if (!payload) return null;
  if (payload.iss !== ISSUER) return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(RESOURCE)) return null; // audience/resource binding (RFC 8707)
  return payload;
}

// ---------------------------------------------------------------------------
// Proxy /mcp -> Supergateway (streamable HTTP, streamed both directions)
// ---------------------------------------------------------------------------
const HOP = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'authorization', 'content-length', 'expect']);

function proxyMcp(req, res, bodyBuf, auth) {
  const url = new URL(req.url, UPSTREAM);
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
  const upstream = new URL(UPSTREAM);
  headers.host = upstream.host;
  const opts = { protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80), path: url.pathname + url.search, method: req.method, headers };
  const ureq = http.request(opts, (ures) => {
    const out = {};
    for (const [k, v] of Object.entries(ures.headers)) if (!HOP.has(k.toLowerCase())) out[k] = v;
    res.writeHead(ures.statusCode || 502, out);
    ures.pipe(res); // stream: SSE / JSON both preserved, no buffering
  });
  ureq.setTimeout(15 * 60_000, () => ureq.destroy(new Error('upstream timeout')));
  ureq.on('error', (e) => { if (!res.headersSent) { log(req.method, '/mcp', 502, 'upstream error'); send(res, 502, { error: 'upstream_unavailable' }); } else res.destroy(); });
  if (bodyBuf && bodyBuf.length) ureq.write(bodyBuf);
  ureq.end();
  req.on('aborted', () => ureq.destroy());
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

    // ---- discovery (public, no secrets) ----
    if (pathName === '/.well-known/oauth-protected-resource' || pathName === '/.well-known/oauth-protected-resource/mcp') {
      log('GET', pathName, 200); return send(res, 200, META);
    }
    if (pathName === '/.well-known/oauth-authorization-server' || pathName === '/.well-known/oauth-authorization-server/mcp' || pathName === '/.well-known/openid-configuration') {
      log('GET', pathName, 200); return send(res, 200, AS_META());
    }

    // ---- OAuth endpoints ----
    if (pathName === '/authorize' && req.method === 'GET') {
      const status = 200; const q = parseQuery(req.url);
      await handleAuthorize(req, res, q); log('GET', '/authorize', res.statusCode); return;
    }
    if (pathName === '/authorize/consent' && req.method === 'POST') {
      const body = await readBody(req);
      await handleConsent(req, res, body); log('POST', '/authorize/consent', res.statusCode); return;
    }
    if (pathName === '/token' && req.method === 'POST') {
      const body = await readBody(req);
      await handleToken(req, res, body); log('POST', '/token', res.statusCode); return;
    }
    if (pathName === '/register' && req.method === 'POST') {
      const body = await readBody(req);
      await handleRegister(req, res, body); log('POST', '/register', res.statusCode); return;
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
        const { isCall, parsed } = isToolsCall(body);
        if (isCall) {
          try {
            const rewrite = capabilityTransport(MANAGED, {
              identity: identityAttribution(auth),
              requestId: randId(),
            });
            body = Buffer.from(JSON.stringify(await rewrite(parsed)), 'utf8');
          } catch (e) {
            const code = e && e.acsCode ? e.acsCode : 'managed_fail_closed';
            log(req.method, '/mcp', 503, `managed fail-closed: ${code}`);
            return send(res, 503, { error: 'managed_authorization_unavailable', code });
          }
        }
      }
      proxyMcp(req, res, body, auth);
      log(req.method, '/mcp', 200, 'proxied'); // status approximate; stream continues
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
  console.log(`gateway: issuer=${ISSUER} resource=${RESOURCE} upstream=${UPSTREAM}`);
});
