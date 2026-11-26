#!/usr/bin/env node
/**
 * Jace Auth (OIDC) owner consent for the Jace Commander device flow.
 *
 * Boots the real edge gateway as a child process (loopback ports, temp data dir, stub upstreams) against an in-process fake
 * OpenID Provider that signs real RS256 ID tokens. Nothing here touches a live gateway, ACS, Supabase or Jace Auth.
 *
 * Covers: verified-owner enrollment, explicit approval, enrollment/session binding, CSRF, allowlist, ID token validation,
 * duplicate fields, per-session throttling that cannot lock out anyone else, the hardened legacy passphrase path,
 * owner-scoped device list/revoke, revocation of the refresh family, legacy namespace isolation, and compatibility of the
 * Bearer (ChatGPT/Claude style) authorization-code flow.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { allowedPublicRoute } from '../public-edge-policy.js';
import { ownerOidcConfigFromEnv } from '../owner-oidc.js';

const KEY = 'k'.repeat(32);
const ORIGIN = 'https://gw.test';
const JC_RESOURCE = `${ORIGIN}/jc/mcp`;
const PASS = 'test-pass-phrase';
const OIDC_CLIENT = 'jc-device-consent';
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

// ---------------------------------------------------------------------------------------------------------------------
// DPoP helpers (client side)
// ---------------------------------------------------------------------------------------------------------------------
function genKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  const jkt = b64u(crypto.createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })).digest());
  return { privateKey, jwk, jkt };
}
function proof(kp, { htm, htu, accessToken, nonce }) {
  const h = b64u(JSON.stringify({ alg: 'EdDSA', typ: 'dpop+jwt', jwk: kp.jwk }));
  const p = b64u(JSON.stringify({
    jti: crypto.randomBytes(16).toString('base64url'), htm, htu, iat: Math.floor(Date.now() / 1000),
    ...(nonce ? { nonce } : {}),
    ...(accessToken ? { ath: b64u(crypto.createHash('sha256').update(accessToken, 'ascii').digest()) } : {}),
  }));
  return `${h}.${p}.${b64u(crypto.sign(null, Buffer.from(`${h}.${p}`, 'ascii'), kp.privateKey))}`;
}
async function dpopPost(gw, endpoint, kp, fields) {
  const url = `${gw.base}${endpoint}`;
  const send = (nonce) => fetch(url, { method: 'POST', headers: { ...FORM, DPoP: proof(kp, { htm: 'POST', htu: `${ORIGIN}${endpoint}`, nonce }) }, body: new URLSearchParams(fields).toString() });
  let res = await send();
  if (res.status === 400 && (await res.clone().json().catch(() => ({}))).error === 'use_dpop_nonce') res = await send(res.headers.get('dpop-nonce'));
  return res;
}
async function dpopCall(gw, method, endpoint, kp, token) {
  const url = `${gw.base}${endpoint}`;
  const send = (nonce) => fetch(url, { method, headers: { authorization: `DPoP ${token}`, DPoP: proof(kp, { htm: method, htu: `${ORIGIN}${endpoint}`, accessToken: token, nonce }) } });
  let res = await send();
  if (res.status === 401 && res.headers.get('dpop-nonce')) res = await send(res.headers.get('dpop-nonce'));
  return res;
}
const jwtClaims = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));

// ---------------------------------------------------------------------------------------------------------------------
// Fake OpenID Provider (real RS256 signatures; behaviour switches for negative tests)
// ---------------------------------------------------------------------------------------------------------------------
async function startOp() {
  const good = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const evil = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...good.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const op = { mode: 'ok', sub: 'owner-a', authRequests: [], tokenCalls: 0, issuer: '' };
  const codes = new Map();
  const sign = (header, payload, privateKey) => {
    const data = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
    return `${data}.${privateKey ? b64u(crypto.sign('sha256', Buffer.from(data), privateKey)) : ''}`;
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json({ issuer: op.issuer, authorization_endpoint: `${op.issuer}/authorize`, token_endpoint: `${op.issuer}/token`, jwks_uri: `${op.issuer}/jwks`, code_challenge_methods_supported: ['S256'] });
    }
    if (url.pathname === '/jwks') return json({ keys: [jwk] });
    if (url.pathname === '/authorize') {
      const q = Object.fromEntries(url.searchParams);
      op.authRequests.push(q);
      const code = crypto.randomBytes(16).toString('hex');
      codes.set(code, { ...q, sub: op.sub });
      const back = new URL(q.redirect_uri);
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.state);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      op.tokenCalls += 1;
      let raw = ''; for await (const c of req) raw += c;
      const f = Object.fromEntries(new URLSearchParams(raw));
      const rec = codes.get(f.code);
      codes.delete(f.code);
      const pkceOk = rec && b64u(crypto.createHash('sha256').update(f.code_verifier || '').digest()) === rec.code_challenge;
      if (!rec || !pkceOk || f.redirect_uri !== rec.redirect_uri || (f.client_id && f.client_id !== rec.client_id)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'invalid_grant' }));
      }
      const t = Math.floor(Date.now() / 1000);
      let payload = { iss: op.issuer, sub: rec.sub, aud: rec.client_id, exp: t + 300, iat: t, auth_time: t, nonce: rec.nonce };
      let header = { alg: 'RS256', kid: 'k1', typ: 'JWT' };
      let signer = good.privateKey;
      switch (op.mode) {
        case 'bad_sig': signer = evil.privateKey; break;
        case 'wrong_aud': payload.aud = 'someone-else'; break;
        case 'wrong_iss': payload.iss = 'https://evil.test'; break;
        case 'expired': payload = { ...payload, exp: t - 3600, iat: t - 3700, auth_time: t - 3700 }; break;
        case 'wrong_nonce': payload.nonce = 'not-the-nonce'; break;
        case 'stale': payload = { ...payload, iat: t - 1200, auth_time: t - 1200 }; break;
        case 'alg_none': header = { alg: 'none', typ: 'JWT' }; signer = null; break;
        case 'hs256': {
          header = { alg: 'HS256', kid: 'k1', typ: 'JWT' };
          const data = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
          return json({ id_token: `${data}.${b64u(crypto.createHmac('sha256', jwk.n).update(data).digest())}`, token_type: 'Bearer' });
        }
        default: break;
      }
      return json({ id_token: sign(header, payload, signer), access_token: 'unused', token_type: 'Bearer' });
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  op.issuer = `http://127.0.0.1:${server.address().port}`;
  op.close = () => server.close();
  return op;
}

// ---------------------------------------------------------------------------------------------------------------------
// Gateway child process
// ---------------------------------------------------------------------------------------------------------------------
function stub(handler) {
  const server = http.createServer(handler);
  return { server, listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))) };
}
let nextPort = 19800;
async function bootGateway({ dir, env = {} } = {}) {
  const jcUp = stub((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(req.url === '/authority' ? '{"variant":"jc"}' : '{"jsonrpc":"2.0","id":1,"result":{}}'); });
  const dcUp = stub((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"jsonrpc":"2.0","id":1,"result":{}}'); });
  const acs = stub((req, res) => { res.writeHead(202, { 'content-type': 'application/json' }); res.end('{"recorded":true}'); });
  const [jcPort, dcPort, acsPort] = [await jcUp.listen(), await dcUp.listen(), await acs.listen()];
  const port = nextPort++;
  const dataDir = dir || fs.mkdtempSync(path.join(os.tmpdir(), `jca2-owner-${port}-`));
  if (!fs.existsSync(path.join(dataDir, 'clients.json'))) {
    fs.writeFileSync(path.join(dataDir, 'clients.json'), JSON.stringify({
      'legacy-public': { client_name: 'legacy', redirect_uris: ['https://app.test/cb'], token_endpoint_auth_method: 'none', oauth_lane: 'jc', scope: 'mcp' },
    }));
    fs.writeFileSync(path.join(dataDir, 'tokens.json'), '{}');
  }
  let child; let output = '';
  const start = async () => {
    child = spawn(process.execPath, ['server.js'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: {
        PATH: process.env.PATH, GATEWAY_PORT: String(port), PUBLIC_ORIGIN: ORIGIN, CONSENT_PASSPHRASE: PASS, SIGNING_KEY: KEY, DATA_DIR: dataDir,
        UPSTREAM: `http://127.0.0.1:${dcPort}`, JC_ENABLED: '1', JC_UPSTREAM: `http://127.0.0.1:${jcPort}`,
        ACS_GATEWAY_URL: `http://127.0.0.1:${acsPort}`, ACS_JC_GATEWAY_TOKEN: 'jc-bridge-token',
        EDGE_TEST_MODE: '1', EDGE_TEST_DEVICE_INTERVAL_S: '1', ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    let up = false;
    for (let i = 0; i < 80 && !up; i += 1) {
      if (child.exitCode !== null) break;
      try { up = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch { await sleep(50); }
    }
    assert.ok(up, `gateway failed to start: ${output}`);
  };
  await start();
  return {
    base: `http://127.0.0.1:${port}`, dataDir, output: () => output,
    stop: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } },
    close: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } jcUp.server.close(); dcUp.server.close(); acs.server.close(); },
    cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }),
  };
}
const oidcEnv = (op, sub = 'owner-a', extra = {}) => ({
  JC_OWNER_OIDC_ISSUER: op.issuer, JC_OWNER_OIDC_CLIENT_ID: OIDC_CLIENT, JC_OWNER_OIDC_ALLOWED_SUB: sub, JC_OWNER_OIDC_ALLOW_HTTP: '1', ...extra,
});

// ---------------------------------------------------------------------------------------------------------------------
// Browser-side helpers
// ---------------------------------------------------------------------------------------------------------------------
function cookieFrom(res, name) {
  for (const c of res.headers.getSetCookie()) {
    if (c.startsWith(`${name}=`)) {
      const pair = c.split(';')[0];
      return pair === `${name}=` ? null : pair;
    }
  }
  return null;
}
async function startEnrollment(gw, kp, label = 'laptop') {
  const res = await fetch(`${gw.base}/jc/oauth/device/code`, { method: 'POST', headers: FORM, body: new URLSearchParams({ client_id: 'jace-commander-cli', scope: 'mcp', dpop_jkt: kp.jkt, device_name: label }).toString() });
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
}
/** Drive the browser: /jc/device -> provider -> callback. Returns the callback response and the owner session cookie. */
async function ownerSignIn(gw, op, { sub = 'owner-a', userCode = null } = {}) {
  op.sub = sub;
  const r1 = await fetch(`${gw.base}/jc/device${userCode ? `?user_code=${encodeURIComponent(userCode)}` : ''}`, { redirect: 'manual' });
  assert.equal(r1.status, 302, 'unauthenticated browser must be sent to the provider');
  const tx = cookieFrom(r1, 'jc_owner_tx');
  assert.ok(tx, 'transaction cookie set');
  const r2 = await fetch(r1.headers.get('location'), { redirect: 'manual' });
  const cb = new URL(r2.headers.get('location'));
  const r3 = await fetch(`${gw.base}${cb.pathname}${cb.search}`, { redirect: 'manual', headers: { cookie: tx } });
  return { r1, r3, tx, session: cookieFrom(r3, 'jc_owner_session') };
}
async function consentFor(gw, session, userCode) {
  const res = await fetch(`${gw.base}/jc/device?user_code=${encodeURIComponent(userCode)}`, { headers: { cookie: session } });
  const html = await res.text();
  const pick = (n) => (new RegExp(`name="${n}" value="([^"]*)"`).exec(html) || [])[1];
  return { res, html, csrf: pick('csrf'), binding: pick('binding') };
}
const postDecision = (gw, session, body) => fetch(`${gw.base}/jc/device`, { method: 'POST', headers: { ...FORM, ...(session ? { cookie: session } : {}) }, body: typeof body === 'string' ? body : new URLSearchParams(body).toString() });
async function pollOnce(gw, kp, dc) {
  return dpopPost(gw, '/jc/oauth/token', kp, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: dc.device_code, client_id: 'jace-commander-cli' });
}
/** Full owner-approved enrollment. Returns the token response. */
async function enrollAsOwner(gw, op, kp, { sub = 'owner-a', label = 'laptop' } = {}) {
  const dc = await startEnrollment(gw, kp, label);
  const { session } = await ownerSignIn(gw, op, { sub, userCode: dc.user_code });
  assert.ok(session, 'owner session established');
  const c = await consentFor(gw, session, dc.user_code);
  const r = await postDecision(gw, session, { user_code: dc.user_code, csrf: c.csrf, binding: c.binding, decision: 'approve' });
  assert.equal(r.status, 200, await r.clone().text());
  const poll = await pollOnce(gw, kp, dc);
  assert.equal(poll.status, 200, await poll.clone().text());
  return poll.json();
}
/** Legacy (no OIDC) passphrase enrollment. */
async function enrollWithPassphrase(gw, kp, label = 'legacy-box') {
  const dc = await startEnrollment(gw, kp, label);
  const r = await postDecision(gw, null, { user_code: dc.user_code, passphrase: PASS, decision: 'approve' });
  assert.equal(r.status, 200, await r.clone().text());
  const poll = await pollOnce(gw, kp, dc);
  assert.equal(poll.status, 200, await poll.clone().text());
  return poll.json();
}

// =====================================================================================================================
// Owner consent
// =====================================================================================================================
test('owner approval: Jace Auth sign-in, explicit consent page, verified (iss, sub) recorded; ACS-facing subject unchanged', async () => {
  const op = await startOp(); const gw = await bootGateway({ env: oidcEnv(op) }); const kp = genKeypair();
  try {
    const dc = await startEnrollment(gw, kp, 'build-box');
    const { r1, r3, session } = await ownerSignIn(gw, op, { userCode: dc.user_code });
    // Authorization request shape: auth code + PKCE S256 + nonce + state, forced re-authentication, dedicated client.
    const aq = op.authRequests.at(-1);
    assert.equal(aq.client_id, OIDC_CLIENT);
    assert.equal(aq.response_type, 'code');
    assert.equal(aq.code_challenge_method, 'S256');
    assert.equal(aq.redirect_uri, `${ORIGIN}/jc/device/callback`);
    assert.equal(aq.prompt, 'login');
    assert.ok(aq.state && aq.nonce);
    assert.match(r1.headers.get('set-cookie'), /HttpOnly/);
    assert.match(r1.headers.get('set-cookie'), /SameSite=Lax/);
    assert.equal(r3.status, 302);
    assert.equal(r3.headers.get('location'), `/jc/device?user_code=${encodeURIComponent(dc.user_code.replace('-', ''))}`);
    assert.ok(session);

    const c = await consentFor(gw, session, dc.user_code);
    assert.equal(c.res.status, 200);
    for (const needle of [dc.user_code, 'jace-commander-cli', 'build-box', 'mcp', 'owner-a']) assert.ok(c.html.includes(needle), `consent page shows ${needle}`);
    assert.ok(!/passphrase/i.test(c.html), 'no shared passphrase in owner mode');
    assert.match(c.res.headers.get('content-security-policy'), /frame-ancestors 'none'/);

    const done = await postDecision(gw, session, { user_code: dc.user_code, csrf: c.csrf, binding: c.binding, decision: 'approve' });
    assert.equal(done.status, 200);
    assert.ok(!cookieFrom(done, 'jc_owner_session'), 'session is single-use (cleared after the decision)');

    const poll = await pollOnce(gw, kp, dc);
    assert.equal(poll.status, 200);
    const tok = await poll.json();
    const claims = jwtClaims(tok.access_token);
    assert.equal(claims.oiss, op.issuer);
    assert.equal(claims.osub, 'owner-a');
    assert.equal(claims.sub, 'jacen', 'ACS-facing subject is unchanged; the verified owner is carried separately');
    assert.equal(claims.cnf.jkt, kp.jkt);
    assert.match(gw.output(), /auth: device approved client=jace-commander-cli owner=owner-a/);
    assert.ok(!gw.output().includes(PASS) && !gw.output().includes(tok.access_token) && !gw.output().includes(tok.refresh_token));
  } finally { gw.close(); op.close(); gw.cleanup(); }
});

test('a pre-filled URL never approves by itself; approval needs an explicit, CSRF-protected click', async () => {
  const op = await startOp(); const gw = await bootGateway({ env: oidcEnv(op) }); const kp = genKeypair();
  try {
    const dc = await startEnrollment(gw, kp);
    const { session } = await ownerSignIn(gw, op, { userCode: dc.user_code });
    const c = await consentFor(gw, session, dc.user_code); // rendering the pre-filled page decides nothing
    assert.equal(c.res.status, 200);
    assert.equal((await (await pollOnce(gw, kp, dc)).json()).error, 'authorization_pending');
    // No session at all
    assert.equal((await postDecision(gw, null, { user_code: dc.user_code, decision: 'approve' })).status, 401);
    // Session but no / wrong CSRF token
    assert.equal((await postDecision(gw, session, { user_code: dc.user_code, binding: c.binding, decision: 'approve' })).status, 403);
    assert.equal((await postDecision(gw, session, { user_code: dc.user_code, csrf: 'wrong', binding: c.binding, decision: 'approve' })).status, 403);
    // The legacy passphrase is not an approval path in owner mode
    assert.equal((await postDecision(gw, session, { user_code: dc.user_code, csrf: c.csrf, binding: c.binding, decision: 'approve', passphrase: PASS })).status, 400);
    assert.equal((await postDecision(gw, null, { user_code: dc.user_code, passphrase: PASS, decision: 'approve' })).status, 401);
    await sleep(1100);
    assert.equal((await (await pollOnce(gw, kp, dc)).json()).error, 'authorization_pending', 'nothing above approved the device');
  } finally { gw.close(); op.close(); gw.cleanup(); }
});

test('only the allow-listed account can approve: a second account is refused and the code stays pending', async () => {
  const op = await startOp(); const gw = await bootGateway({ env: oidcEnv(op, 'owner-a') }); const kp = genKeypair();
  try {
    const dc = await startEnrollment(gw, kp);
    const { r3, session } = await ownerSignIn(gw, op, { sub: 'intruder', userCode: dc.user_code });
    assert.equal(r3.status, 403);
    assert.equal(session, null, 'no session is minted for another account');
    assert.match(gw.output(), /owner sign-in refused reason=not_allowed/);
    assert.equal((await (await pollOnce(gw, kp, dc)).json()).error, 'authorization_pending');
    // A forged cookie is no substitute for a session
    assert.equal((await postDecision(gw, 'jc_owner_session=' + 'A'.repeat(80), { user_code: dc.user_code, decision: 'approve' })).status, 401);
  } finally { gw.close(); op.close(); gw.cleanup(); }
});

for (const mode of ['bad_sig', 'wrong_aud', 'wrong_iss', 'expired', 'wrong_nonce', 'stale', 'alg_none', 'hs256']) {
  test(`ID token validation fails closed: ${mode}`, async () => {
    const op = await startOp(); const gw = await bootGateway({ env: oidcEnv(op) }); const kp = genKeypair();
    try {
      op.mode = mode;
      const dc = await startEnrollment(gw, kp);
      const { r3, session } = await ownerSignIn(gw, op, { userCode: dc.user_code });
      assert.ok(r3.status === 400 || r3.status === 403, `status ${r3.status}`);
      assert.equal(session, null);
      assert.match(gw.output(), /owner sign-in refused reason=id_token:/);
    } finally { gw.close(); op.close(); gw.cleanup(); }
  });
}

test('callback binds to the browser transaction: missing cookie, state mismatch, replay and duplicate parameters are refused', async () => {
  const op = await startOp(); const gw = await bootGateway({ env: oidcEnv(op) }); const kp = genKeypair();
  try {
    const dc = await startEnrollment(gw, kp);
    const r1 = await fetch(`${gw.base}/jc/device?user_code=${dc.user_code}`, { redirect: 'manual' });
    const tx = cookieFrom(r1, 'jc_owner_tx');
    const cb = new URL((await fetch(r1.headers.get('location'), { redirect: 'manual' })).headers.get('location'));
    const url = `${gw.base}${cb.pathname}${cb.search}`;
    // Login CSRF: a victim's browser without the attacker's transaction cookie
    assert.equal((await fetch(url, { redirect: 'manual' })).status, 400);
    // Another browser's cookie (different transaction)
    const other = await fetch(`${gw.base}/jc/device`, { redirect: 'manual' });
    assert.equal((await fetch(url, { redirect: 'manual', headers: { cookie: cookieFrom(other, 'jc_owner_tx') } })).status, 400);
    // Duplicated query parameter
    assert.equal((await fetch(`${url}&state=other`, { redirect: 'manual', headers: { cookie: tx } })).status, 400);
    // Tampered state
    const bad = new URL(url); bad.searchParams.set('state', 'tampered');
    assert.equal((await fetch(bad, { redirect: 'manual', headers: { cookie: tx } })).status, 400);
    // The genuine one succeeds once; the authorization code cannot be replayed
    assert.equal((await fetch(url, { redirect: 'manual', headers: { cookie: tx } })).status, 302);
    assert.equal((await fetch(url, { redirect: 'manual', headers: { cookie: tx } })).status, 400);
    // Provider error response
    assert.equal((await fetch(`${gw.base}/jc/device/callback?error=access_denied&state=x`, { redirect: 'manual', headers: { cookie: tx } })).status, 400);
  } finally { gw.close(); op.close(); gw.cleanup(); }
});

test('approval is bound to the enrollment the owner actually reviewed in this session', async () => {
  const op = await startOp(); const gw = await bootGateway({ env: oidcEnv(op) }); const kpA = genKeypair(); const kpB = genKeypair();
  try {
    const a = await startEnrollment(gw, kpA, 'reviewed');
    const b = await startEnrollment(gw, kpB, 'attacker-started');
    const { session } = await ownerSignIn(gw, op, { userCode: a.user_code });
    const ca = await consentFor(gw, session, a.user_code);
    // Reuse A's page token to decide B (a code the owner never saw a consent page for)
    const r = await postDecision(gw, session, { user_code: b.user_code, csrf: ca.csrf, binding: ca.binding, decision: 'approve' });
    assert.equal(r.status, 403);
    assert.equal((await (await pollOnce(gw, kpB, b)).json()).error, 'authorization_pending');
    // A binding minted for another session does not carry over either
    const { session: session2 } = await ownerSignIn(gw, op, { userCode: a.user_code });
    const r2 = await postDecision(gw, session2, { user_code: a.user_code, csrf: (await consentFor(gw, session2, a.user_code)).csrf, binding: ca.binding, decision: 'approve' });
    assert.equal(r2.status, 403);
  } finally { gw.close(); op.close(); gw.cleanup(); }
});

test('duplicate decision / user_code / csrf fields are rejected outright and decide nothing', async () => {
  const op = await startOp(); const gw = await bootGateway({ env: oidcEnv(op) }); const kp = genKeypair();
  try {
    const dc = await startEnrollment(gw, kp);
    const { session } = await ownerSignIn(gw, op, { userCode: dc.user_code });
    const c = await consentFor(gw, session, dc.user_code);
    const base = `user_code=${encodeURIComponent(dc.user_code)}&csrf=${c.csrf}&binding=${c.binding}`;
    assert.equal((await postDecision(gw, session, `${base}&decision=deny&decision=approve`)).status, 400);
    assert.equal((await postDecision(gw, session, `${base}&decision=approve&decision=deny`)).status, 400);
    assert.equal((await postDecision(gw, session, `${base}&user_code=AAAA-BBBB&decision=approve`)).status, 400);
    assert.equal((await postDecision(gw, session, `${base}&csrf=${c.csrf}&decision=approve`)).status, 400);
    assert.equal((await (await pollOnce(gw, kp, dc)).json()).error, 'authorization_pending');
    // Fresh session (the failures above are bounded per session)
    const { session: s2 } = await ownerSignIn(gw, op, { userCode: dc.user_code });
    const c2 = await consentFor(gw, s2, dc.user_code);
    assert.equal((await postDecision(gw, s2, { user_code: dc.user_code, csrf: c2.csrf, binding: c2.binding, decision: 'approve' })).status, 200);
  } finally { gw.close(); op.close(); gw.cleanup(); }
});

test('throttling is per owner session: five failures lock that session only, never other sessions or the public edge', async () => {
  const op = await startOp(); const gw = await bootGateway({ env: oidcEnv(op) }); const kp = genKeypair();
  try {
    const dc = await startEnrollment(gw, kp);
    const { session: s1 } = await ownerSignIn(gw, op, { userCode: dc.user_code });
    for (let i = 0; i < 5; i += 1) {
      const r = await fetch(`${gw.base}/jc/device?user_code=ZZZZ-ZZZ${i}`, { headers: { cookie: s1 } });
      assert.equal(r.status, 404);
    }
    const locked = await fetch(`${gw.base}/jc/device?user_code=ZZZZ-ZZZZ`, { headers: { cookie: s1 } });
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get('retry-after')) >= 1);
    // Even the right code and the right token are refused for the locked session...
    const c1 = await consentFor(gw, s1, dc.user_code);
    assert.equal(c1.res.status, 429);
    // ...but the unauthenticated edge still redirects to sign-in (nobody is locked out by someone else's failures) ...
    assert.equal((await fetch(`${gw.base}/jc/device`, { redirect: 'manual' })).status, 302);
    // ... and a fresh sign-in of the owner is a different session and works immediately.
    const { session: s2 } = await ownerSignIn(gw, op, { userCode: dc.user_code });
    const c2 = await consentFor(gw, s2, dc.user_code);
    assert.equal(c2.res.status, 200);
    assert.equal((await postDecision(gw, s2, { user_code: dc.user_code, csrf: c2.csrf, binding: c2.binding, decision: 'approve' })).status, 200);
  } finally { gw.close(); op.close(); gw.cleanup(); }
});

test('an expired approved device code cannot be redeemed (edge store)', async () => {
  const op = await startOp();
  const gw = await bootGateway({ env: { ...oidcEnv(op), EDGE_TEST_DEVICE_CODE_TTL_S: '2' } }); const kp = genKeypair();
  try {
    const dc = await startEnrollment(gw, kp);
    const { session } = await ownerSignIn(gw, op, { userCode: dc.user_code });
    const c = await consentFor(gw, session, dc.user_code);
    assert.equal((await postDecision(gw, session, { user_code: dc.user_code, csrf: c.csrf, binding: c.binding, decision: 'approve' })).status, 200);
    await sleep(3200);
    const poll = await pollOnce(gw, kp, dc);
    assert.equal(poll.status, 400);
    assert.equal((await poll.json()).error, 'expired_token');
  } finally { gw.close(); op.close(); gw.cleanup(); }
});

// =====================================================================================================================
// Ownership and revocation
// =====================================================================================================================
test('ownership: a second account cannot list or revoke your devices; revocation kills the device and its refresh family; legacy devices are a separate namespace', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jca2-owner-own-'));
  const op = await startOp(); const kpL = genKeypair(); const kpA = genKeypair(); const kpB = genKeypair();
  let gw;
  try {
    // 1) legacy device enrolled with the shared passphrase before owner consent exists
    gw = await bootGateway({ dir });
    const L = await enrollWithPassphrase(gw, kpL);
    assert.equal(jwtClaims(L.access_token).oiss, undefined);
    gw.close();

    // 2) owner A enrols under owner consent
    gw = await bootGateway({ dir, env: oidcEnv(op, 'owner-a') });
    const A = await enrollAsOwner(gw, op, kpA, { sub: 'owner-a', label: 'A-laptop' });
    const listA = await (await dpopCall(gw, 'GET', '/jc/devices', kpA, A.access_token)).json();
    assert.deepEqual(listA.devices.map((d) => d.device_id), [A.device_id], 'owner sees only their own device, not the legacy one');
    const legacyVsOwner = await dpopCall(gw, 'POST', `/jc/devices/${L.device_id}/revoke`, kpA, A.access_token);
    assert.equal(legacyVsOwner.status, 404, 'a verified owner cannot manage legacy (NULL-owner) devices');
    gw.close();

    // 3) the allow-list now names a DIFFERENT account; that account enrols its own device
    gw = await bootGateway({ dir, env: oidcEnv(op, 'owner-b') });
    const B = await enrollAsOwner(gw, op, kpB, { sub: 'owner-b', label: 'B-laptop' });
    const listB = await (await dpopCall(gw, 'GET', '/jc/devices', kpB, B.access_token)).json();
    assert.deepEqual(listB.devices.map((d) => d.device_id), [B.device_id]);
    // B cannot revoke A's device (indistinguishable from a missing one) and cannot revoke the legacy one
    assert.equal((await dpopCall(gw, 'POST', `/jc/devices/${A.device_id}/revoke`, kpB, B.access_token)).status, 404);
    assert.equal((await dpopCall(gw, 'DELETE', `/jc/devices/${A.device_id}`, kpB, B.access_token)).status, 404);
    assert.equal((await dpopCall(gw, 'POST', `/jc/devices/${L.device_id}/revoke`, kpB, B.access_token)).status, 404);
    // A is untouched: still authenticated and still refreshable
    assert.equal((await dpopCall(gw, 'GET', '/jc/devices', kpA, A.access_token)).status, 200);
    const refreshedA = await dpopPost(gw, '/jc/oauth/token', kpA, { grant_type: 'refresh_token', refresh_token: A.refresh_token, client_id: 'jace-commander-cli' });
    assert.equal(refreshedA.status, 200, await refreshedA.clone().text());
    const A2 = await refreshedA.json();
    assert.equal(jwtClaims(A2.access_token).osub, 'owner-a', 'refresh keeps the verified owner');

    // 4) B revokes B's own device: access and refresh are both dead, and A / legacy are unaffected
    const rev = await dpopCall(gw, 'POST', `/jc/devices/${B.device_id}/revoke`, kpB, B.access_token);
    assert.equal(rev.status, 200);
    assert.equal((await dpopCall(gw, 'GET', '/jc/devices', kpB, B.access_token)).status, 401, 'revoked device is refused immediately');
    const refreshB = await dpopPost(gw, '/jc/oauth/token', kpB, { grant_type: 'refresh_token', refresh_token: B.refresh_token, client_id: 'jace-commander-cli' });
    assert.equal(refreshB.status, 400);
    assert.equal((await refreshB.json()).error, 'invalid_grant');
    // the same key cannot be re-enrolled after revocation (re-enrolment needs a new key)
    const dcAgain = await startEnrollment(gw, kpB);
    const { session } = await ownerSignIn(gw, op, { sub: 'owner-b', userCode: dcAgain.user_code });
    const cAgain = await consentFor(gw, session, dcAgain.user_code);
    await postDecision(gw, session, { user_code: dcAgain.user_code, csrf: cAgain.csrf, binding: cAgain.binding, decision: 'approve' });
    assert.notEqual((await pollOnce(gw, kpB, dcAgain)).status, 200, 'a revoked key stays revoked');
    assert.equal((await dpopCall(gw, 'GET', '/jc/devices', kpA, A2.access_token)).status, 200);
    // legacy token still sees only the legacy namespace
    const listL = await (await dpopCall(gw, 'GET', '/jc/devices', kpL, L.access_token)).json();
    assert.deepEqual(listL.devices.map((d) => d.device_id), [L.device_id]);
  } finally { gw?.close(); op.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// =====================================================================================================================
// Legacy passphrase path (owner consent not configured) and compatibility
// =====================================================================================================================
test('legacy passphrase path: duplicate fields are refused, repeated failures slow down but never lock out the owner', async () => {
  const gw = await bootGateway(); const kp = genKeypair();
  try {
    const dc = await startEnrollment(gw, kp);
    const body = `user_code=${encodeURIComponent(dc.user_code)}&passphrase=${PASS}`;
    assert.equal((await postDecision(gw, null, `${body}&decision=deny&decision=approve`)).status, 400);
    assert.equal((await postDecision(gw, null, `${body}&decision=approve&decision=deny`)).status, 400);
    assert.equal((await postDecision(gw, null, `${body}&user_code=AAAA-BBBB&decision=approve`)).status, 400);
    assert.equal((await postDecision(gw, null, `user_code=${dc.user_code}&passphrase=wrong&passphrase=${PASS}&decision=approve`)).status, 400);
    assert.equal((await (await pollOnce(gw, kp, dc)).json()).error, 'authorization_pending');
    // A burst of wrong passphrases (an attacker sharing the proxy address) ...
    const t0 = Date.now();
    for (let i = 0; i < 8; i += 1) assert.equal((await postDecision(gw, null, { user_code: dc.user_code, passphrase: `wrong-${i}`, decision: 'approve' })).status, 401);
    // ... is slowed, never refused: the owner's correct passphrase is still honoured, within a bounded delay.
    const t1 = Date.now();
    const ok = await postDecision(gw, null, { user_code: dc.user_code, passphrase: PASS, decision: 'approve' });
    assert.equal(ok.status, 200);
    assert.ok(Date.now() - t1 < 4000, 'bounded delay');
    assert.ok(Date.now() - t0 > 500, 'failures are slowed');
  } finally { gw.close(); gw.cleanup(); }
});

test('owner consent leaves the Bearer authorization-code flow (ChatGPT/Claude style) working, and refuses passphrase-only DPoP device enrollment', async () => {
  const op = await startOp(); const gw = await bootGateway({ env: oidcEnv(op) });
  try {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
    const redirect = 'https://app.test/cb';
    const consent = (extra = {}) => fetch(`${gw.base}/authorize/consent`, {
      method: 'POST', headers: FORM, redirect: 'manual',
      body: new URLSearchParams({ client_id: 'legacy-public', redirect_uri: redirect, response_type: 'code', scope: 'mcp', state: 's1', code_challenge: challenge, code_challenge_method: 'S256', resource: JC_RESOURCE, passphrase: PASS, ...extra }).toString(),
    });
    const r = await consent();
    assert.equal(r.status, 302);
    const code = new URL(r.headers.get('location')).searchParams.get('code');
    assert.ok(code);
    const tokRes = await fetch(`${gw.base}/jc/oauth/token`, { method: 'POST', headers: FORM, body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirect, client_id: 'legacy-public', resource: JC_RESOURCE }).toString() });
    assert.equal(tokRes.status, 200, await tokRes.clone().text());
    assert.equal((await tokRes.json()).token_type, 'Bearer');

    // A DPoP-bound CLI device may not be minted from the shared passphrase while owner consent is on
    const kp = genKeypair();
    const cli = await fetch(`${gw.base}/authorize/consent`, {
      method: 'POST', headers: FORM, redirect: 'manual',
      body: new URLSearchParams({ client_id: 'jace-commander-cli', redirect_uri: 'http://127.0.0.1:43210/callback', response_type: 'code', scope: 'mcp', state: 's2', code_challenge: challenge, code_challenge_method: 'S256', resource: JC_RESOURCE, dpop_jkt: kp.jkt, passphrase: PASS }).toString(),
    });
    assert.equal(cli.status, 403);
    assert.match(await cli.text(), /owner sign-in/i);
  } finally { gw.close(); op.close(); gw.cleanup(); }
});

test('escape hatch: JC_OWNER_OIDC_ALLOW_LEGACY_ENROLLMENT=1 keeps loopback DPoP enrollment working (explicit, off by default)', async () => {
  const op = await startOp(); const gw = await bootGateway({ env: oidcEnv(op, 'owner-a', { JC_OWNER_OIDC_ALLOW_LEGACY_ENROLLMENT: '1' }) });
  try {
    const kp = genKeypair();
    const challenge = b64u(crypto.createHash('sha256').update(crypto.randomBytes(32).toString('base64url')).digest());
    const cli = await fetch(`${gw.base}/authorize/consent`, {
      method: 'POST', headers: FORM, redirect: 'manual',
      body: new URLSearchParams({ client_id: 'jace-commander-cli', redirect_uri: 'http://127.0.0.1:43210/callback', response_type: 'code', scope: 'mcp', state: 's2', code_challenge: challenge, code_challenge_method: 'S256', resource: JC_RESOURCE, dpop_jkt: kp.jkt, passphrase: PASS }).toString(),
    });
    assert.equal(cli.status, 302);
  } finally { gw.close(); op.close(); gw.cleanup(); }
});

// =====================================================================================================================
// Configuration and edge policy
// =====================================================================================================================
test('owner OIDC configuration fails closed on partial or unsafe settings', async () => {
  assert.deepEqual(ownerOidcConfigFromEnv({}), { enabled: false });
  const base = { JC_OWNER_OIDC_ISSUER: 'https://jace-auth.example', JC_OWNER_OIDC_CLIENT_ID: 'c', JC_OWNER_OIDC_ALLOWED_SUB: 'owner' };
  assert.equal(ownerOidcConfigFromEnv(base).enabled, true);
  assert.throws(() => ownerOidcConfigFromEnv({ ...base, JC_OWNER_OIDC_CLIENT_ID: '' }), /CLIENT_ID/);
  assert.throws(() => ownerOidcConfigFromEnv({ ...base, JC_OWNER_OIDC_ALLOWED_SUB: '' }), /ALLOWED_SUB/);
  assert.throws(() => ownerOidcConfigFromEnv({ ...base, JC_OWNER_OIDC_ALLOWED_SUB: 'a,b' }), /exactly one/);
  assert.throws(() => ownerOidcConfigFromEnv({ ...base, JC_OWNER_OIDC_ISSUER: 'http://jace-auth.example' }), /https/);
  assert.throws(() => ownerOidcConfigFromEnv({ ...base, JC_OWNER_OIDC_ISSUER: 'http://jace-auth.example', JC_OWNER_OIDC_ALLOW_HTTP: '1' }), /https/, 'http is never allowed outside test mode');
  assert.throws(() => ownerOidcConfigFromEnv({ JC_OWNER_OIDC_CLIENT_ID: 'c' }), /ISSUER is not/);
  // The gateway itself refuses to start on a partial configuration instead of silently using the passphrase.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jca2-owner-cfg-'));
  try {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { PATH: process.env.PATH, GATEWAY_PORT: '19799', PUBLIC_ORIGIN: ORIGIN, CONSENT_PASSPHRASE: PASS, SIGNING_KEY: KEY, DATA_DIR: dir, JC_ENABLED: '1', ACS_GATEWAY_URL: 'http://127.0.0.1:1', ACS_JC_GATEWAY_TOKEN: 'x', JC_OWNER_OIDC_ISSUER: 'https://jace-auth.example' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; child.stderr.on('data', (d) => { out += d; }); child.stdout.on('data', (d) => { out += d; });
    const code = await new Promise((r) => child.on('exit', r));
    assert.notEqual(code, 0);
    assert.match(out, /owner OIDC consent misconfigured/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('public edge policy: only the standard OIDC response parameters reach /jc/device/callback', () => {
  const ok = (m, u, b = '') => allowedPublicRoute(m, u, b, JC_RESOURCE);
  assert.equal(ok('GET', '/jc/device/callback?code=abc&state=xyz'), true);
  assert.equal(ok('GET', '/jc/device/callback?error=access_denied&state=xyz&iss=https%3A%2F%2Fx'), true);
  assert.equal(ok('GET', '/jc/device/callback'), false);
  assert.equal(ok('GET', '/jc/device/callback?code=a&state=b&extra=1'), false);
  assert.equal(ok('POST', '/jc/device/callback?code=a&state=b'), false);
  assert.equal(ok('GET', '/jc/device/callback/x?code=a&state=b'), false);
});
