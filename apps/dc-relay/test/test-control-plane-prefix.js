#!/usr/bin/env node
/**
 * CONTROL_PLANE_URL with a path prefix (https://host/relay). Tailscale Funnel
 * path mounts strip the prefix, so the plane must serve un-prefixed paths while
 * every URL it generates carries the prefix. Prefixed requests are accepted too.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { basePath, createControlPlaneServer, routePath } from '../dist/control-plane/server.js';
import { InMemoryPairingStore } from '../dist/control-plane/pairing-store.js';
import { ControlPlaneError } from '../dist/control-plane/service.js';

const ORIGIN = 'https://jacen-ubuntu.tailaa6d41.ts.net';
const verifier = 'prefix-verifier-0123456789012345678901234567890123456789012345';
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const config = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'test-publishable-key',
  SUPABASE_SECRET_KEY: 'test-secret-key',
  DEVICE_OAUTH_CLIENT_ID: 'device-client',
  PAIRING_STATE_KEY: crypto.randomBytes(32).toString('base64'),
  PAIRING_CODE_KEY: crypto.randomBytes(32).toString('base64'),
  CONTROL_PLANE_URL: `${ORIGIN}/relay`,
};

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`PASS  ${name}`); }
  catch (error) { failures++; console.error(`FAIL  ${name}\n  ${error.stack || error.message}`); }
}

async function withServer(cfg, fn) {
  const server = createControlPlaneServer(cfg, {
    pairingStore: new InMemoryPairingStore(),
    accessLog: () => {},
    authenticate: async () => { throw new ControlPlaneError('not_found', 'not found'); },
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

await test('basePath / routePath: exact segment match only', () => {
  assert.equal(basePath(config), '/relay');
  assert.equal(basePath({ CONTROL_PLANE_URL: ORIGIN }), '');
  assert.equal(basePath({ CONTROL_PLANE_URL: `${ORIGIN}/relay/` }), '/relay');
  assert.equal(routePath('/relay/mcp', '/relay'), '/mcp');
  assert.equal(routePath('/relay', '/relay'), '/');
  assert.equal(routePath('/mcp', '/relay'), '/mcp');
  assert.equal(routePath('/relayx/mcp', '/relay'), '/relayx/mcp', '/relayx must not be treated as prefixed');
  assert.equal(routePath('/mcp', ''), '/mcp');
});

for (const [label, pre] of [['stripped (Funnel)', ''], ['prefixed (direct)', '/relay']]) {
  await test(`${label}: mcp-info is exact with /relay URLs`, () => withServer(config, async (base) => {
    const info = await (await fetch(`${base}${pre}/api/mcp-info`)).json();
    assert.equal(info.oauthRedirectUri, `${ORIGIN}/relay/device/callback`);
    assert.equal(info.deviceRegistrationEndpoint, '/api/devices/register');
    assert.equal(info.deviceAuthMode, 'supabase_oauth_pkce');
  }));

  await test(`${label}: protected resource metadata (plain and /mcp-suffixed) names /relay/mcp`, () => withServer(config, async (base) => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const body = await (await fetch(`${base}${pre}${path}`)).json();
      assert.equal(body.resource, `${ORIGIN}/relay/mcp`);
      assert.deepEqual(body.authorization_servers, ['https://example.supabase.co/auth/v1']);
    }
  }));

  await test(`${label}: 401 WWW-Authenticate points at /relay metadata`, () => withServer(config, async (base) => {
    const response = await fetch(`${base}${pre}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), `Bearer resource_metadata="${ORIGIN}/relay/.well-known/oauth-protected-resource"`);
  }));

  await test(`${label}: pairing start and /add-device use /relay URLs; no Set-Cookie anywhere`, () => withServer(config, async (base) => {
    const start = await fetch(`${base}${pre}/device/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: 'mcp-device', scope: 'mcp:tools', device_name: 'box', device_type: 'mcp', code_challenge: challenge, code_challenge_method: 'S256' }) });
    assert.equal(start.headers.get('set-cookie'), null);
    const pairing = await start.json();
    assert.equal(pairing.verification_uri, `${ORIGIN}/relay/add-device`);
    assert(pairing.verification_uri_complete.startsWith(`${ORIGIN}/relay/add-device?session_id=`));
    const add = await fetch(`${base}${pre}/add-device?session_id=${pairing.session_id}`, { redirect: 'manual' });
    assert.equal(add.status, 302);
    assert.equal(add.headers.get('set-cookie'), null);
    assert.equal(new URL(add.headers.get('location')).searchParams.get('redirect_uri'), `${ORIGIN}/relay/device/callback`);
    const poll = await fetch(`${base}${pre}/device/poll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: pairing.session_id, client_id: 'mcp-device', code_verifier: verifier }) });
    assert.deepEqual(await poll.json(), { error: 'authorization_pending' });
  }));

  await test(`${label}: consent page loads supabase-js from /relay/static and the bundle is served there`, () => withServer(config, async (base) => {
    const page = await fetch(`${base}${pre}/oauth/consent?authorization_id=x`);
    assert.equal(page.headers.get('set-cookie'), null);
    const html = await page.text();
    assert.match(html, /<script nonce="[^"]+" src="\/relay\/static\/supabase\.js"><\/script>/);
    assert.doesNotMatch(html, /src="\/static\/supabase\.js"/);
    assert.equal((await fetch(`${base}${pre}/static/supabase.js`)).status, 200);
  }));
}

await test('/relayx/... is not routed as /relay', () => withServer(config, async (base) => {
  assert.equal((await fetch(`${base}/relayx/api/mcp-info`)).status, 404);
}));

await test('root CONTROL_PLANE_URL behaves exactly as before (no prefix in generated URLs)', () => withServer({ ...config, CONTROL_PLANE_URL: ORIGIN }, async (base) => {
  const info = await (await fetch(`${base}/api/mcp-info`)).json();
  assert.equal(info.oauthRedirectUri, `${ORIGIN}/device/callback`);
  const html = await (await fetch(`${base}/oauth/consent?authorization_id=x`)).text();
  assert.match(html, /src="\/static\/supabase\.js"/);
  const response = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' , headers: { 'content-type': 'application/json' } });
  assert.equal(response.headers.get('www-authenticate'), `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`);
}));

process.exitCode = failures ? 1 : 0;
