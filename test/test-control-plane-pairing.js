#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createControlPlaneServer } from '../dist/control-plane/server.js';
import { InMemoryPairingStore } from '../dist/control-plane/pairing-store.js';
import { signPairingState, verifyPairingState } from '../dist/control-plane/pairing-crypto.js';
import { ControlPlaneError } from '../dist/control-plane/service.js';

const verifier = 'pairing-verifier-012345678901234567890123456789012345678901234567';
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const stateKey = crypto.randomBytes(32);
const config = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'test-publishable-key',
  SUPABASE_SECRET_KEY: 'test-secret-key',
  DEVICE_OAUTH_CLIENT_ID: '123d8cb8-c40c-45e7-92fd-e02d137398ae',
  PAIRING_STATE_KEY: stateKey.toString('base64'),
  PAIRING_CODE_KEY: crypto.randomBytes(32).toString('base64'),
  CONTROL_PLANE_URL: 'https://relay.example.test:8443',
  PORT: '0',
};
const store = new InMemoryPairingStore();
const server = createControlPlaneServer(config, {
  pairingStore: store,
  authenticate: async () => { throw new ControlPlaneError('not_found', 'not found'); },
});

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`PASS  ${name}`); }
  catch (error) { failures++; console.error(`FAIL  ${name}\n  ${error.stack || error.message}`); }
}
async function post(path, payload) {
  return fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
}
function startPayload(deviceName, extra = {}) {
  return { client_id: 'mcp-device', scope: 'mcp:tools', device_name: deviceName, device_type: 'mcp', code_challenge: challenge, code_challenge_method: 'S256', ...extra };
}
async function start(name = 'Test laptop') {
  const response = await post('/device/start', startPayload(name));
  assert.equal(response.status, 200);
  return response.json();
}
async function authorize(pairing) {
  const response = await fetch(`${base}/add-device?session_id=${encodeURIComponent(pairing.session_id)}`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  return new URL(response.headers.get('location'));
}
async function callback(state, params = { code: 'supabase-auth-code-abc123' }) {
  const url = new URL(`${base}/device/callback`);
  url.searchParams.set('state', state);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return fetch(url, { redirect: 'manual' });
}
async function poll(pairing, codeVerifier = verifier) {
  const response = await post('/device/poll', { session_id: pairing.session_id, client_id: 'mcp-device', code_verifier: codeVerifier });
  return { status: response.status, body: await response.json() };
}

server.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  await test('mcp-info has the exact own-relay contract shape', async () => {
    const info = await (await fetch(`${base}/api/mcp-info`)).json();
    assert.deepEqual(info, {
      supabaseUrl: config.SUPABASE_URL,
      supabasePublishableKey: config.SUPABASE_PUBLISHABLE_KEY,
      controlPlaneVersion: 1,
      deviceAuthMode: 'supabase_oauth_pkce',
      oauthClientId: config.DEVICE_OAUTH_CLIENT_ID,
      oauthRedirectUri: 'https://relay.example.test:8443/device/callback',
      deviceRegistrationEndpoint: '/api/devices/register',
      deviceTopicFormat: 'user:{user_id}:device:{device_id}',
    });
  });

  await test('/device/start accepts S256 only', async () => {
    assert.equal((await post('/device/start', startPayload('Plain', { code_challenge_method: 'plain' }))).status, 400);
    assert.equal((await post('/device/start', startPayload('Short', { code_challenge: 'too-short' }))).status, 400);
    const pairing = await start();
    assert.match(pairing.session_id, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(new URL(pairing.verification_uri_complete).pathname, '/add-device');
    assert.equal(new URL(pairing.verification_uri_complete).searchParams.get('session_id'), pairing.session_id);
    assert.equal(pairing.verify_device_uri, undefined, 'legacy verify-device link must be gone');
  });

  await test('/add-device redirects to Supabase authorize with the session PKCE challenge and signed state', async () => {
    const pairing = await start();
    const location = await authorize(pairing);
    assert.equal(`${location.origin}${location.pathname}`, 'https://example.supabase.co/auth/v1/oauth/authorize');
    assert.equal(location.searchParams.get('response_type'), 'code');
    assert.equal(location.searchParams.get('client_id'), config.DEVICE_OAUTH_CLIENT_ID);
    assert.equal(location.searchParams.get('redirect_uri'), 'https://relay.example.test:8443/device/callback');
    assert.equal(location.searchParams.get('code_challenge'), challenge);
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
    const state = verifyPairingState(stateKey, location.searchParams.get('state'));
    assert.equal(state?.sessionId, pairing.session_id);
    assert.equal((await fetch(`${base}/add-device?session_id=unknown-session-id-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx`, { redirect: 'manual' })).status, 404);
  });

  await test('bad state is rejected and changes nothing', async () => {
    const pairing = await start();
    const location = await authorize(pairing);
    const good = location.searchParams.get('state');
    const tampered = good.slice(0, -2) + (good.endsWith('A') ? 'BB' : 'AA');
    assert.equal((await callback(tampered)).status, 400);
    assert.equal((await callback(signPairingState(crypto.randomBytes(32), pairing.session_id, 'n'.repeat(43)))).status, 400, 'foreign-key state accepted');
    assert.equal((await callback('')).status, 400);
    const staleNonce = signPairingState(stateKey, pairing.session_id, 'x'.repeat(43));
    assert.equal((await callback(staleNonce)).status, 400, 'validly signed state with an unbound nonce accepted');
    assert.equal((await store.get(pairing.session_id)).state, 'PENDING');
    assert.deepEqual((await poll(pairing)).body, { error: 'authorization_pending' });
  });

  await test('a newer /add-device visit invalidates the earlier state', async () => {
    const pairing = await start();
    const first = (await authorize(pairing)).searchParams.get('state');
    const second = (await authorize(pairing)).searchParams.get('state');
    assert.equal((await callback(first)).status, 400);
    assert.equal((await callback(second)).status, 200);
  });

  await test('happy path: callback seals code, poll returns it once, second poll is invalid_grant', async () => {
    const pairing = await start();
    const state = (await authorize(pairing)).searchParams.get('state');
    const cb = await callback(state, { code: 'supabase-auth-code-happy' });
    assert.equal(cb.status, 200);
    assert.match(cb.headers.get('content-security-policy') || '', /default-src 'none'/);
    assert.equal((await store.get(pairing.session_id)).state, 'VERIFIED');
    const sealed = store.sealedCode(pairing.session_id);
    assert(sealed && !sealed.includes('supabase-auth-code-happy'), 'code stored in plaintext');
    const first = await poll(pairing);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { authorization_code: 'supabase-auth-code-happy', redirect_uri: 'https://relay.example.test:8443/device/callback' });
    assert.equal(first.body.access_token, undefined);
    assert.equal(store.holdsSecretMaterial(pairing.session_id), false, 'sealed code not wiped');
    const second = await poll(pairing);
    assert.equal(second.status, 400);
    assert.deepEqual(second.body, { error: 'invalid_grant' });
  });

  await test('wrong verifier is invalid_grant and does not consume the code', async () => {
    const pairing = await start();
    await callback((await authorize(pairing)).searchParams.get('state'));
    const wrong = await poll(pairing, 'x'.repeat(64));
    assert.equal(wrong.status, 400);
    assert.deepEqual(wrong.body, { error: 'invalid_grant' });
    assert.equal((await store.get(pairing.session_id)).state, 'VERIFIED');
    assert.equal((await poll(pairing)).status, 200);
  });

  await test('callback replay rejects the session and wipes the code', async () => {
    const pairing = await start();
    const state = (await authorize(pairing)).searchParams.get('state');
    assert.equal((await callback(state)).status, 200);
    assert.equal((await callback(state, { code: 'attacker-code' })).status, 409);
    assert.equal((await store.get(pairing.session_id)).state, 'REJECTED');
    assert.equal(store.holdsSecretMaterial(pairing.session_id), false);
    assert.deepEqual((await poll(pairing)).body, { error: 'access_denied' });
  });

  await test('expired code is expired_token and wiped', async () => {
    const pairing = await start();
    await callback((await authorize(pairing)).searchParams.get('state'));
    store.expireCodeNow(pairing.session_id);
    assert.deepEqual((await poll(pairing)).body, { error: 'expired_token' });
    assert.equal((await store.get(pairing.session_id)).state, 'EXPIRED');
    assert.equal(store.holdsSecretMaterial(pairing.session_id), false);
  });

  await test('expired pairing session cannot be authorized or polled', async () => {
    const expired = await store.create({ device_name: 'Old', code_challenge: challenge, expires_in: -1 });
    assert.equal((await fetch(`${base}/add-device?session_id=${expired.session_id}`, { redirect: 'manual' })).status, 410);
    assert.deepEqual((await poll(expired)).body, { error: 'expired_token' });
  });

  await test('OAuth error callback rejects the pairing', async () => {
    const pairing = await start();
    const state = (await authorize(pairing)).searchParams.get('state');
    assert.equal((await callback(state, { error: 'access_denied' })).status, 200);
    assert.deepEqual((await poll(pairing)).body, { error: 'access_denied' });
  });

  await test('concurrent polls release the code exactly once', async () => {
    const pairing = await start();
    await callback((await authorize(pairing)).searchParams.get('state'));
    const results = await Promise.all([poll(pairing), poll(pairing), poll(pairing)]);
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.equal(results.filter((r) => r.body.error === 'invalid_grant').length, 2);
  });

  await test('device_code compatibility lookup and mismatch', async () => {
    const pairing = await start();
    const pending = await post('/device/poll', { device_code: pairing.device_code, client_id: 'mcp-device', code_verifier: verifier });
    assert.deepEqual(await pending.json(), { error: 'authorization_pending' });
    const other = await start('Other');
    const mismatch = await post('/device/poll', { session_id: pairing.session_id, device_code: other.device_code, client_id: 'mcp-device', code_verifier: verifier });
    assert.equal(mismatch.status, 404);
  });

  await test('access log records path only: no query (code/state), Authorization, Cookie, or body', async () => {
    const entries = [];
    const logged = createControlPlaneServer(config, { pairingStore: store, accessLog: (entry) => entries.push(entry), authenticate: async () => { throw new ControlPlaneError('not_found', 'not found'); } });
    logged.listen(0, '127.0.0.1');
    await new Promise((resolve) => logged.once('listening', resolve));
    const url = `http://127.0.0.1:${logged.address().port}`;
    try {
      const response = await fetch(`${url}/device/callback?code=SECRET-CODE-VALUE-123&state=SECRET-STATE-VALUE-456`, {
        headers: { authorization: 'Bearer SECRET-BEARER-789', cookie: 'sb=SECRET-COOKIE-000', 'user-agent': 'Claude-User/1.0' },
      });
      await response.text();
      await fetch(`${url}/device/poll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code_verifier: 'SECRET-BODY-VERIFIER' }) }).then((r) => r.text());
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(entries.length, 2);
      assert.deepEqual({ ...entries[0], duration_ms: 0 }, { event: 'http', method: 'GET', path: '/device/callback', status: 400, duration_ms: 0, user_agent: 'Claude-User/1.0' });
      assert.equal(typeof entries[0].duration_ms, 'number');
      assert.equal(entries[1].path, '/device/poll');
      const serialized = JSON.stringify(entries);
      for (const secret of ['SECRET-CODE-VALUE-123', 'SECRET-STATE-VALUE-456', 'SECRET-BEARER-789', 'SECRET-COOKIE-000', 'SECRET-BODY-VERIFIER', 'code=', 'state=', '?']) {
        assert(!serialized.includes(secret), `access log leaked ${secret}`);
      }
    } finally {
      await new Promise((resolve) => logged.close(resolve));
    }
  });

  await test('legacy token-handoff routes are gone', async () => {
    assert.equal((await fetch(`${base}/verify-device?user_code=ABCD-EFGH`)).status, 404);
    assert.equal((await post('/device/verify', { user_code: 'ABCD-EFGH' })).status, 404);
  });
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
process.exitCode = failures ? 1 : 0;
