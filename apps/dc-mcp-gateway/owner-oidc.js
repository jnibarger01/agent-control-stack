/**
 * Jace Auth (OIDC) owner consent for the Jace Commander device flow (/jc/device).
 *
 * What this proves: WHO approved a device. The browser signs in through the configured OpenID Provider
 * (authorization code + PKCE, `prompt=login`), the ID token is verified (RS256/ES256 signature against the provider's JWKS,
 * iss, aud/azp, exp, iat freshness, nonce), and the verified (iss, sub) pair must equal the single allow-listed owner.
 * Only then is a short-lived session created, and approval still needs an explicit, CSRF-protected, enrollment-bound click.
 *
 * What it deliberately is not: an authority. ACS remains the only authority for capabilities and approvals; this
 * module authenticates the human who enrols a device and nothing more. Routine tool calls and refreshes are unchanged.
 *
 * Zero runtime dependencies (node:crypto + fetch). All login state lives in AES-256-GCM sealed cookies, so unauthenticated
 * traffic cannot grow server memory or evict a legitimate login.
 */
import crypto from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha256b64u = (v) => crypto.createHash('sha256').update(String(v), 'utf8').digest('base64url');
const SESSION_TTL_S = 600;
const TX_TTL_S = 600;
const MAX_ID_TOKEN_AGE_S = 600; // prompt=login: the authentication must be recent
const CLOCK_SKEW_S = 60;
const MAX_RESPONSE_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 5000;
const ALLOWED_ALGS = Object.freeze(['RS256', 'ES256']);

export const OWNER_SESSION_COOKIE = 'jc_owner_session';
export const OWNER_TX_COOKIE = 'jc_owner_tx';

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * Parse owner-consent configuration. Returns { enabled: false } when no issuer is configured (legacy passphrase mode).
 * Throws on any partial or unsafe configuration so the gateway refuses to start rather than silently falling back.
 */
export function ownerOidcConfigFromEnv(env, { testMode = false } = {}) {
  const issuerRaw = (env.JC_OWNER_OIDC_ISSUER || '').trim();
  if (!issuerRaw) {
    for (const k of ['JC_OWNER_OIDC_CLIENT_ID', 'JC_OWNER_OIDC_CLIENT_SECRET', 'JC_OWNER_OIDC_ALLOWED_SUB']) {
      if ((env[k] || '').trim()) throw new Error(`${k} is set but JC_OWNER_OIDC_ISSUER is not`);
    }
    return { enabled: false };
  }
  const allowHttp = testMode && env.JC_OWNER_OIDC_ALLOW_HTTP === '1';
  let u;
  try { u = new URL(issuerRaw); } catch { throw new Error('JC_OWNER_OIDC_ISSUER is not a valid URL'); }
  if (u.search || u.hash || u.username || u.password) throw new Error('JC_OWNER_OIDC_ISSUER must not carry query, fragment or credentials');
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) throw new Error('JC_OWNER_OIDC_ISSUER must be https');
  const clientId = (env.JC_OWNER_OIDC_CLIENT_ID || '').trim();
  if (!clientId) throw new Error('JC_OWNER_OIDC_CLIENT_ID is required when owner OIDC consent is enabled');
  const allowedSub = (env.JC_OWNER_OIDC_ALLOWED_SUB || '').trim();
  if (!allowedSub) throw new Error('JC_OWNER_OIDC_ALLOWED_SUB is required (exactly one owner account)');
  if (/[\s,;|]/.test(allowedSub)) throw new Error('JC_OWNER_OIDC_ALLOWED_SUB must be exactly one subject (single-owner at launch)');
  const clientSecret = (env.JC_OWNER_OIDC_CLIENT_SECRET || '').trim();
  return {
    enabled: true,
    issuer: issuerRaw, // compared byte-for-byte with discovery `issuer` and the ID token `iss`
    clientId,
    clientSecret: clientSecret || null,
    allowedSub,
    promptLogin: env.JC_OWNER_OIDC_PROMPT_LOGIN !== '0',
    allowHttp,
  };
}

function parseCookies(header) {
  const out = new Map();
  const dup = new Set();
  if (typeof header !== 'string') return { get: () => null };
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (out.has(k)) dup.add(k);
    else out.set(k, v);
  }
  // A repeated cookie name is ambiguous (cookie tossing); treat it as absent.
  return { get: (name) => (dup.has(name) ? null : (out.get(name) ?? null)) };
}

async function readLimited(res) {
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_RESPONSE_BYTES) throw new Error('response too large');
  const text = await res.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error('response too large');
  return text;
}

export function createOwnerConsent({ config, publicOrigin, signingKey, fetchImpl = fetch, nowSec = () => Math.floor(Date.now() / 1000) }) {
  if (!config?.enabled) throw new Error('owner consent not enabled');
  const secureCookies = new URL(publicOrigin).protocol === 'https:';
  const redirectUri = `${publicOrigin}/jc/device/callback`;
  const cookieKey = Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(String(signingKey), 'utf8'), Buffer.alloc(0), Buffer.from('jc-owner-oidc-cookie-v1'), 32),
  );
  const bindingKey = Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(String(signingKey), 'utf8'), Buffer.alloc(0), Buffer.from('jc-owner-consent-binding-v1'), 32),
  );

  function seal(obj, aad) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', cookieKey, iv);
    c.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    return b64u(Buffer.concat([iv, c.getAuthTag(), ct]));
  }
  function open(value, aad) {
    try {
      if (typeof value !== 'string' || value.length < 40 || value.length > 4096) return null;
      const raw = Buffer.from(value, 'base64url');
      const d = crypto.createDecipheriv('aes-256-gcm', cookieKey, raw.subarray(0, 12));
      d.setAAD(Buffer.from(aad, 'utf8'));
      d.setAuthTag(raw.subarray(12, 28));
      const obj = JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
      return obj && typeof obj === 'object' ? obj : null;
    } catch {
      return null;
    }
  }
  const cookieAttrs = (maxAge) => `HttpOnly; SameSite=Lax; Path=/jc/device; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`;
  const setCookie = (name, value, maxAge) => `${name}=${value}; ${cookieAttrs(maxAge)}`;
  const clearCookie = (name) => `${name}=; ${cookieAttrs(0)}`;

  // ---- OIDC discovery + JWKS (cached; the provider is only ever contacted from the callback / first login) ----
  let discoveryCache = null;
  let jwksCache = null;
  const endpointOk = (v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'https:' || (config.allowHttp && u.protocol === 'http:');
    } catch { return false; }
  };
  async function getJson(url) {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: 'application/json' }, redirect: 'error' });
    if (!res.ok) throw new Error(`provider responded ${res.status}`);
    return JSON.parse(await readLimited(res));
  }
  async function discover() {
    const t = nowSec();
    if (discoveryCache && t - discoveryCache.at < 600) return discoveryCache.doc;
    const doc = await getJson(`${config.issuer}/.well-known/openid-configuration`);
    if (doc.issuer !== config.issuer) throw new Error('discovery issuer mismatch');
    for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
      if (typeof doc[k] !== 'string' || !endpointOk(doc[k])) throw new Error(`discovery ${k} missing or not https`);
    }
    if (Array.isArray(doc.code_challenge_methods_supported) && !doc.code_challenge_methods_supported.includes('S256')) {
      throw new Error('provider does not advertise PKCE S256');
    }
    discoveryCache = { doc, at: t };
    return doc;
  }
  async function jwkFor(kid, alg, { forceRefresh = false } = {}) {
    const t = nowSec();
    if (!jwksCache || forceRefresh || t - jwksCache.at > 300) {
      const doc = await discover();
      const jwks = await getJson(doc.jwks_uri);
      if (!jwks || !Array.isArray(jwks.keys)) throw new Error('malformed jwks');
      jwksCache = { keys: jwks.keys, at: t };
    }
    const kty = alg === 'RS256' ? 'RSA' : 'EC';
    const candidates = jwksCache.keys.filter((k) => k && k.kty === kty && (k.use === undefined || k.use === 'sig') && (k.alg === undefined || k.alg === alg));
    if (typeof kid === 'string') return candidates.find((k) => k.kid === kid) || null;
    return candidates.length === 1 ? candidates[0] : null;
  }

  async function verifyIdToken(idToken, { nonce }) {
    const fail = (why) => { throw Object.assign(new Error(`id_token rejected: ${why}`), { idTokenReject: why }); };
    if (typeof idToken !== 'string' || idToken.length > 16384) fail('malformed');
    const parts = idToken.split('.');
    if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) fail('malformed');
    let header; let payload;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch { fail('malformed'); }
    if (!header || typeof header !== 'object' || !payload || typeof payload !== 'object') fail('malformed');
    if (!ALLOWED_ALGS.includes(header.alg)) fail('alg');
    if (header.crit !== undefined) fail('crit');
    let jwk = await jwkFor(header.kid, header.alg);
    if (!jwk) jwk = await jwkFor(header.kid, header.alg, { forceRefresh: true });
    if (!jwk) fail('unknown_key');
    let key;
    try { key = crypto.createPublicKey({ key: jwk, format: 'jwk' }); } catch { fail('bad_key'); }
    if (header.alg === 'RS256' && (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) fail('weak_key');
    const data = Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii');
    const sig = Buffer.from(parts[2], 'base64url');
    const sigOk = header.alg === 'RS256'
      ? crypto.verify('sha256', data, key, sig)
      : sig.length === 64 && crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig);
    if (!sigOk) fail('signature');
    const t = nowSec();
    if (payload.iss !== config.issuer) fail('iss');
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(config.clientId)) fail('aud');
    if (aud.length > 1 && payload.azp !== config.clientId) fail('azp');
    if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_S < t) fail('exp');
    if (typeof payload.iat !== 'number' || payload.iat - CLOCK_SKEW_S > t) fail('iat');
    const authTime = typeof payload.auth_time === 'number' ? payload.auth_time : payload.iat;
    if (config.promptLogin && t - authTime > MAX_ID_TOKEN_AGE_S) fail('stale_authentication');
    if (typeof payload.nonce !== 'string' || !safeEqual(payload.nonce, nonce)) fail('nonce');
    if (typeof payload.sub !== 'string' || payload.sub.length === 0 || payload.sub.length > 255) fail('sub');
    return { iss: payload.iss, sub: payload.sub };
  }

  const isAllowed = (iss, sub) => iss === config.issuer && safeEqual(sub, config.allowedSub);

  return {
    config,
    isAllowed,

    /** Begin sign-in: returns the provider redirect and the sealed transaction cookie. */
    async startLogin({ userCode = null } = {}) {
      const doc = await discover();
      const verifier = b64u(crypto.randomBytes(32));
      const state = b64u(crypto.randomBytes(24));
      const nonce = b64u(crypto.randomBytes(24));
      const tx = { state, nonce, verifier, uc: userCode, exp: nowSec() + TX_TTL_S };
      const q = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid',
        state,
        nonce,
        code_challenge: b64u(crypto.createHash('sha256').update(verifier).digest()),
        code_challenge_method: 'S256',
      });
      if (config.promptLogin) q.set('prompt', 'login');
      const sep = doc.authorization_endpoint.includes('?') ? '&' : '?';
      return {
        location: `${doc.authorization_endpoint}${sep}${q.toString()}`,
        setCookie: setCookie(OWNER_TX_COOKIE, seal(tx, OWNER_TX_COOKIE), TX_TTL_S),
      };
    },

    /**
     * Complete sign-in from the provider redirect. Every failure path returns a generic outcome (no oracle for which
     * check failed) plus a cookie that clears the transaction.
     */
    async completeLogin({ query, cookieHeader }) {
      const clear = clearCookie(OWNER_TX_COOKIE);
      const reject = (status, reason) => ({ ok: false, status, reason, clearCookie: clear });
      const tx = open(parseCookies(cookieHeader).get(OWNER_TX_COOKIE), OWNER_TX_COOKIE);
      if (!tx || typeof tx.exp !== 'number' || tx.exp < nowSec()) return reject(400, 'no_transaction');
      if (typeof query.state !== 'string' || !safeEqual(query.state, tx.state)) return reject(400, 'state');
      if (query.error !== undefined) return reject(400, 'provider_error');
      if (query.iss !== undefined && query.iss !== config.issuer) return reject(400, 'iss_param');
      if (typeof query.code !== 'string' || query.code.length === 0 || query.code.length > 2048) return reject(400, 'code');
      try {
        const doc = await discover();
        const body = new URLSearchParams({
          grant_type: 'authorization_code',
          code: query.code,
          redirect_uri: redirectUri,
          code_verifier: tx.verifier,
        });
        const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
        if (config.clientSecret) {
          headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`).toString('base64')}`;
        } else {
          body.set('client_id', config.clientId);
        }
        const res = await fetchImpl(doc.token_endpoint, { method: 'POST', headers, body: body.toString(), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'error' });
        if (!res.ok) return reject(400, 'token_exchange');
        const tokens = JSON.parse(await readLimited(res));
        const identity = await verifyIdToken(tokens.id_token, { nonce: tx.nonce });
        if (!isAllowed(identity.iss, identity.sub)) return reject(403, 'not_allowed');
        const sid = b64u(crypto.randomBytes(16));
        const session = { sid, iss: identity.iss, sub: identity.sub, csrf: b64u(crypto.randomBytes(24)), exp: nowSec() + SESSION_TTL_S };
        return {
          ok: true,
          userCode: typeof tx.uc === 'string' ? tx.uc : null,
          clearCookie: clear,
          sessionCookie: setCookie(OWNER_SESSION_COOKIE, seal(session, OWNER_SESSION_COOKIE), SESSION_TTL_S),
        };
      } catch (err) {
        return reject(err && err.idTokenReject ? 400 : 502, err && err.idTokenReject ? `id_token:${err.idTokenReject}` : 'provider_unavailable');
      }
    },

    /** The verified owner session for this request, re-checked against the allowlist, or null. */
    session(cookieHeader) {
      const s = open(parseCookies(cookieHeader).get(OWNER_SESSION_COOKIE), OWNER_SESSION_COOKIE);
      if (!s || typeof s.exp !== 'number' || s.exp < nowSec()) return null;
      if (typeof s.sid !== 'string' || typeof s.csrf !== 'string' || typeof s.iss !== 'string' || typeof s.sub !== 'string') return null;
      if (!isAllowed(s.iss, s.sub)) return null;
      return s;
    },

    /**
     * Binds an approval to this browser session AND this exact pending enrollment: the consent page embeds it, the POST must
     * return it. A decision for a code the owner never saw on a consent page in this session cannot match.
     */
    bindingFor(session, userCodeHash, createdAt) {
      return b64u(crypto.createHmac('sha256', bindingKey).update(`${session.sid}\0${userCodeHash}\0${createdAt}`).digest());
    },
    clearSessionCookie: () => clearCookie(OWNER_SESSION_COOKIE),
    clearTxCookie: () => clearCookie(OWNER_TX_COOKIE),
    sha256b64u,
  };
}

// ---- Pages (inline CSS is allowed only on these responses via their own CSP) ----
export const CONSENT_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STYLE = `body{font-family:system-ui,sans-serif;background:#111;color:#eee;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#1c1c1c;padding:2rem;border-radius:12px;max-width:440px;width:90%}h1{font-size:1.1rem}dl{display:grid;grid-template-columns:auto 1fr;gap:.4rem 1rem}dt{color:#aaa}dd{margin:0;word-break:break-all}
code{background:#333;padding:2px 6px;border-radius:4px}input[type=text]{width:100%;padding:.6rem;margin:.5rem 0 1rem;border-radius:6px;border:1px solid #444;background:#252525;color:#eee;box-sizing:border-box}
.row{display:flex;gap:.75rem}button{flex:1;padding:.7rem;border:0;border-radius:6px;background:#4f8cff;color:#fff;font-size:1rem;cursor:pointer}button.deny{background:#555}.warn{color:#ffb454;font-size:.85rem}`;
const shell = (body) => `<!doctype html><html><head><meta charset="utf-8"><title>Jace Commander - Device approval</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${STYLE}</style></head><body><div class="card">${body}</div></body></html>`;

export const messagePage = (msg) => shell(`<p>${esc(msg)}</p>`);
export const codeEntryPage = (note = '') => shell(`<h1>Approve a Jace Commander device</h1>${note ? `<p class="warn">${esc(note)}</p>` : ''}
<form method="GET" action="/jc/device"><label>Code shown in your terminal<input type="text" name="user_code" autocomplete="off" required></label><button type="submit">Continue</button></form>`);
export function consentPage({ clientId, deviceName, scope, userCode, expiresAt, ownerSub, csrf, binding, keyBound }) {
  return shell(`<h1>Approve this device?</h1>
<p class="warn">Confirm that the code below is exactly the one your terminal is showing. Approve only a device you started.</p>
<dl><dt>Code</dt><dd><code>${esc(userCode)}</code></dd><dt>Client</dt><dd>${esc(clientId)}</dd><dt>Device</dt><dd>${esc(deviceName || '(unnamed)')}</dd>
<dt>Scope</dt><dd>${esc(scope)}</dd><dt>Expires</dt><dd>${esc(new Date(expiresAt * 1000).toISOString())}</dd><dt>Key-bound</dt><dd>${keyBound ? 'yes' : 'no'}</dd>
<dt>Signed in as</dt><dd>${esc(ownerSub)}</dd></dl>
<form method="POST" action="/jc/device"><input type="hidden" name="user_code" value="${esc(userCode)}"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="binding" value="${esc(binding)}">
<div class="row"><button type="submit" name="decision" value="approve">Approve</button><button type="submit" name="decision" value="deny" class="deny">Deny</button></div></form>`);
}
