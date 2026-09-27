#!/usr/bin/env node

/**
 * Own-relay (supabase_oauth_pkce) device mode.
 *
 *   D1  refresh rewrite to /auth/v1/oauth/token + passthrough
 *   D2  mcp-info gating (legacy shapes stay DC cloud)
 *   D3  rotated-token persistence: serialized, atomic, 0600, opt-out honored
 *   D4  offline subprocess: no tokens in argv, access token on stdin, expired → 2
 *   D5  device-side code exchange + relay registration
 *   D6  per-device topic, Presence meta, claim/complete RPCs, no client result doorbell
 *
 * Run: npm run build && node test/test-remote-own-relay.js
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
// Captured before any monkeypatch: syncBuiltinESMExports() rewires named imports too.
const realSpawnSync = childProcess.spawnSync;
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-own-relay-test-'));
process.env.DESKTOP_COMMANDER_DEVICE_CONFIG_PATH = path.join(tmp, 'device', 'device.json');

const {
  parseMcpInfo, resolveRelayEndpoint, rewriteRefreshRequest, oauthRelayFetch, normalizeOAuthTokenResponse,
  exchangeAuthorizationCode, registerWithRelay, relayCapabilities, deviceTopic, presenceMeta,
} = await import('../dist/remote-device/oauth-relay.js');
const { DeviceAuthenticator } = await import('../dist/remote-device/device-authenticator.js');
const { RemoteChannel } = await import('../dist/remote-device/remote-channel.js');
const { MCPDevice } = await import('../dist/remote-device/device.js');

const SUPABASE = 'https://ref.supabase.co';
const RELAY = 'https://relay.example.test:8443';
const CLIENT_ID = '123d8cb8-c40c-45e7-92fd-e02d137398ae';
const USER = '22222222-2222-4222-8222-222222222222';
const DEVICE = '11111111-1111-4111-8111-111111111111';
const RELAY_INFO = {
  supabaseUrl: SUPABASE, supabasePublishableKey: 'sb_publishable_x', controlPlaneVersion: 1,
  deviceAuthMode: 'supabase_oauth_pkce', oauthClientId: CLIENT_ID, oauthRedirectUri: `${RELAY}/device/callback`,
  deviceRegistrationEndpoint: '/api/devices/register', deviceTopicFormat: 'user:{user_id}:device:{device_id}',
};
const settings = parseMcpInfo(RELAY_INFO, RELAY).oauth;

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`✅ PASS  ${name}`); }
  catch (error) { failures++; console.error(`🔴 FAIL  ${name}\n     ${error.stack || error.message}`); }
}
function jwt(claims) {
  const enc = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc(claims)}.sig`;
}
function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

// ---------------------------------------------------------------- D2
await test('D2: exact relay contract selects supabase_oauth_pkce with derived endpoints', () => {
  const config = parseMcpInfo(RELAY_INFO, RELAY);
  assert.equal(config.mode, 'supabase_oauth_pkce');
  assert.deepEqual(config.oauth, {
    supabaseUrl: SUPABASE, anonKey: 'sb_publishable_x', clientId: CLIENT_ID,
    redirectUri: `${RELAY}/device/callback`, registrationUrl: `${RELAY}/api/devices/register`,
  });
});
await test('D2: legacy shapes stay DC cloud with the exact legacy {supabaseUrl, anonKey}', () => {
  const legacy = { supabaseUrl: SUPABASE, supabasePublishableKey: 'k' };
  for (const info of [
    legacy,
    { ...legacy, controlPlaneVersion: 1, deviceAuthMode: 'supabase_oauth_pkce_wrapper' },
    { ...RELAY_INFO, oauthClientId: '' },
    { ...RELAY_INFO, oauthClientId: undefined },
    { ...RELAY_INFO, controlPlaneVersion: 2 },
  ]) {
    const config = parseMcpInfo(info, RELAY);
    assert.equal(config.mode, 'dc_cloud');
    assert.equal(config.oauth, undefined);
    assert.equal(config.supabaseUrl, info.supabaseUrl);
    assert.equal(config.anonKey, info.supabasePublishableKey);
  }
});

await test('D2: registration endpoint resolves under a path-prefixed relay (/relay)', () => {
  const prefixed = parseMcpInfo({ ...RELAY_INFO, oauthRedirectUri: 'https://host.example/relay/device/callback' }, 'https://host.example/relay');
  assert.equal(prefixed.oauth.registrationUrl, 'https://host.example/relay/api/devices/register');
  assert.equal(resolveRelayEndpoint('https://host.example/relay/', '/api/devices/register'), 'https://host.example/relay/api/devices/register');
  assert.equal(resolveRelayEndpoint('https://host.example', '/api/devices/register'), 'https://host.example/api/devices/register');
  assert.equal(resolveRelayEndpoint('https://host.example/relay', 'https://other.example/reg'), 'https://other.example/reg');
  assert.equal(parseMcpInfo(RELAY_INFO, RELAY).oauth.registrationUrl, `${RELAY}/api/devices/register`, 'origin-root relay changed');
});

// ---------------------------------------------------------------- D1
await test('D1: auth-js refresh is rewritten to the OAuth token endpoint as a form with client_id', () => {
  const rewrite = rewriteRefreshRequest(`${SUPABASE}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=UTF-8', apikey: 'sb_publishable_x', Authorization: 'Bearer anon' },
    body: JSON.stringify({ refresh_token: 'rt-1' }),
  }, settings);
  assert.equal(rewrite.url, `${SUPABASE}/auth/v1/oauth/token`);
  assert.equal(rewrite.init.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(rewrite.init.headers.apikey, 'sb_publishable_x');
  assert.equal(rewrite.init.headers.authorization, undefined);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(rewrite.init.body)), { grant_type: 'refresh_token', refresh_token: 'rt-1', client_id: CLIENT_ID });
});
await test('D1: everything else passes through untouched', () => {
  const body = JSON.stringify({ refresh_token: 'rt' });
  assert.equal(rewriteRefreshRequest(`${SUPABASE}/auth/v1/token?grant_type=password`, { method: 'POST', body }, settings), null);
  assert.equal(rewriteRefreshRequest(`${SUPABASE}/auth/v1/user`, { method: 'GET' }, settings), null);
  assert.equal(rewriteRefreshRequest(`https://evil.example/auth/v1/token?grant_type=refresh_token`, { method: 'POST', body }, settings), null);
  assert.equal(rewriteRefreshRequest(`${SUPABASE}/rest/v1/mcp_devices`, { method: 'POST', body }, settings), null);
  assert.equal(rewriteRefreshRequest(`${SUPABASE}/auth/v1/token?grant_type=refresh_token`, { method: 'GET' }, settings), null);
});
await test('D1: rewritten refresh response is normalized with expires_at and the user', async () => {
  const calls = [];
  const base = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/auth/v1/oauth/token')) return json({ access_token: 'at-2', refresh_token: 'rt-2', token_type: 'bearer', expires_in: 3600 }, 200, { date: 'Thu, 24 Sep 2026 20:00:00 GMT' });
    if (String(url).endsWith('/auth/v1/user')) return json({ id: USER, email: 'j@example.com' });
    return json({}, 500);
  };
  const wrapped = oauthRelayFetch(base, settings, () => 1_000_000_000);
  const response = await wrapped(`${SUPABASE}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: {}, body: JSON.stringify({ refresh_token: 'rt-1' }) });
  const body = await response.json();
  assert.equal(body.access_token, 'at-2');
  assert.equal(body.refresh_token, 'rt-2');
  assert.equal(body.expires_at, 1_000_000 + 3600);
  assert.equal(body.user.id, USER);
  assert.equal(response.headers.get('date'), 'Thu, 24 Sep 2026 20:00:00 GMT', 'clock-skew Date header dropped');
  assert.equal(calls[1].init.headers.authorization, 'Bearer at-2');
  const passthrough = await wrapped(`${SUPABASE}/rest/v1/x`, { method: 'GET' });
  assert.equal(passthrough.status, 500);
  assert.equal(calls.at(-1).url, `${SUPABASE}/rest/v1/x`);
});
await test('D1: an OAuth refresh error is returned as-is for auth-js to classify', async () => {
  const wrapped = oauthRelayFetch(async () => json({ error: 'invalid_grant', error_description: 'Invalid Refresh Token: Already Used' }, 400), settings);
  const response = await wrapped(`${SUPABASE}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', body: JSON.stringify({ refresh_token: 'x' }) });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'invalid_grant');
});
await test('D1: normalize keeps an existing expires_at', () => {
  assert.equal(normalizeOAuthTokenResponse({ expires_in: 10, expires_at: 42 }, null, 0).expires_at, 42);
});

// ---------------------------------------------------------------- D5
await test('D5: authenticator exchanges the relayed code with its own verifier', async () => {
  const seen = [];
  let challenge;
  let polls = 0;
  const fetchImpl = async (url, init) => {
    const u = String(url);
    seen.push({ url: u, init });
    if (u === `${RELAY}/device/start`) {
      const body = JSON.parse(init.body);
      challenge = body.code_challenge;
      assert.equal(body.code_challenge_method, 'S256');
      return json({ session_id: 's'.repeat(43), user_code: 'ABCD-EFGH', expires_in: 900, interval: 1, device_code: 'd'.repeat(43) });
    }
    if (u === `${RELAY}/device/poll`) {
      polls++;
      if (polls === 1) return json({ error: 'authorization_pending' }, 400);
      return json({ authorization_code: 'auth-code-1', redirect_uri: `${RELAY}/device/callback` });
    }
    if (u === `${SUPABASE}/auth/v1/oauth/token`) {
      const form = Object.fromEntries(new URLSearchParams(init.body));
      assert.equal(form.grant_type, 'authorization_code');
      assert.equal(form.code, 'auth-code-1');
      assert.equal(form.client_id, CLIENT_ID);
      assert.equal(form.redirect_uri, `${RELAY}/device/callback`);
      assert.equal(crypto.createHash('sha256').update(form.code_verifier).digest('base64url'), challenge, 'verifier does not match the started challenge');
      return json({ access_token: 'at-1', refresh_token: 'rt-1', token_type: 'bearer', expires_in: 3600 });
    }
    return json({}, 404);
  };
  const auth = new DeviceAuthenticator(RELAY, { fetchImpl, openBrowser: async () => {}, sleep: async () => {}, oauth: settings });
  const session = await auth.authenticate();
  assert.deepEqual(session, { device_id: undefined, access_token: 'at-1', refresh_token: 'rt-1' });
  const pollBody = JSON.parse(seen.find((c) => c.url.endsWith('/device/poll')).init.body);
  assert.equal(pollBody.client_id, 'mcp-device');
});
await test('D5: relay redirect_uri mismatch is refused before exchange', async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/device/start')) return json({ session_id: 's'.repeat(43), user_code: 'ABCD-EFGH', expires_in: 900, interval: 1 });
    if (String(url).endsWith('/device/poll')) return json({ authorization_code: 'c', redirect_uri: 'https://evil.example/cb' });
    throw new Error(`unexpected ${url}`);
  };
  const auth = new DeviceAuthenticator(RELAY, { fetchImpl, openBrowser: async () => {}, sleep: async () => {}, oauth: settings });
  await assert.rejects(auth.authenticate(), /redirect_uri/);
});
await test('D5: exchange failure surfaces the OAuth error', async () => {
  await assert.rejects(exchangeAuthorizationCode(async () => json({ error: 'invalid_grant' }, 400), { ...settings, code: 'c', codeVerifier: 'v' }), /invalid_grant/);
});
await test('D5: registration posts the device token and falls back to a fresh id on 404', async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    assert.equal(url, `${RELAY}/api/devices/register`);
    assert.equal(init.headers.authorization, 'Bearer at-1');
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.device_id) return json({ error: 'not_found' }, 404);
    return json({ id: DEVICE, device_name: body.device_name });
  };
  const row = await registerWithRelay(fetchImpl, { registrationUrl: `${RELAY}/api/devices/register`, accessToken: 'at-1', deviceId: 'stale-id', deviceName: 'box', capabilities: { transport_broadcast_v1: true } });
  assert.equal(row.id, DEVICE);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].device_id, 'stale-id');
  assert.equal(bodies[1].device_id, undefined);
});
await test('D5/D6: relay capabilities carry transport_broadcast_v1 and fit the 8 KiB column', () => {
  const tools = { tools: Array.from({ length: 400 }, (_, i) => ({ name: `tool_${i}_${'x'.repeat(40)}`, inputSchema: { big: 'y'.repeat(2000) } })) };
  const caps = relayCapabilities(tools, '1.2.3', true);
  assert.equal(caps.transport_broadcast_v1, true);
  assert(Buffer.byteLength(JSON.stringify(caps)) < 8192);
  assert.equal(relayCapabilities(tools, '1', false).transport_broadcast_v1, undefined);
});

// ---------------------------------------------------------------- D6
function makeRelayClient({ claim = true, complete = { id: 'call-1' }, claimErrors = 0 } = {}) {
  const log = { rpc: [], channels: [], tracks: [], sends: [], selects: [] };
  let claimCalls = 0;
  const row = { id: 'call-1', device_id: DEVICE, tool_name: 'list_directory', tool_args: { path: '~/projects' }, status: 'executing' };
  const client = {
    supabaseUrl: SUPABASE,
    supabaseKey: 'sb_publishable_x',
    auth: { getSession: async () => ({ data: { session: { access_token: 'at-1', refresh_token: 'rt-1' } } }) },
    realtime: { setAuth() {}, disconnect: async () => {} },
    removeChannel: async () => {},
    rpc: async (name, args) => {
      log.rpc.push({ name, args });
      if (name === 'claim_mcp_remote_call') {
        claimCalls++;
        if (claimCalls <= claimErrors) return { data: null, error: { message: 'blip' } };
        return { data: claim, error: null };
      }
      if (name === 'complete_mcp_remote_call') return { data: complete, error: null };
      return { data: null, error: { message: 'unknown rpc' } };
    },
    from: (table) => {
      const filters = {};
      const builder = {
        select: () => builder,
        update: () => builder,
        lte: () => builder,
        eq: (col, value) => { filters[col] = value; return builder; },
        maybeSingle: async () => { log.selects.push({ table, filters: { ...filters } }); return { data: row, error: null }; },
        then: (resolve) => resolve({ data: null, error: null }),
      };
      return builder;
    },
    channel: (name, opts) => {
      const handlers = {};
      const channel = {
        state: 'joined',
        on: (_type, filter, cb) => { handlers[filter.event] = cb; return channel; },
        subscribe: (cb) => { setImmediate(() => cb('SUBSCRIBED')); return channel; },
        track: async (payload) => { log.tracks.push(payload); return 'ok'; },
        send: async (payload) => { log.sends.push(payload); return 'ok'; },
        untrack: async () => 'ok',
        unsubscribe: async () => 'ok',
        fire: (event, payload) => handlers[event]?.({ payload }),
      };
      log.channels.push({ name, opts, channel });
      return channel;
    },
  };
  return { client, log };
}
function makeRelayChannel(clientOpts, { localReady = true } = {}) {
  let ready = localReady;
  const rc = new RemoteChannel({ isLocalReady: () => ready, fetchImpl: async (url, init) => json({ id: DEVICE, device_name: JSON.parse(init.body).device_name }) });
  const { client, log } = makeRelayClient(clientOpts);
  rc.oauth = settings;
  rc.client = client;
  rc._user = { id: USER, email: 'j@example.com' };
  rc.lastKnownSession = { access_token: 'at-1', refresh_token: 'rt-1' };
  return { rc, log, setReady: (value) => { ready = value; } };
}

await test('D6: registration joins the per-device topic and tracks contract Presence meta', async () => {
  const { rc, log } = makeRelayChannel();
  const calls = [];
  const id = await rc.registerDevice({ tools: [{ name: 'list_directory' }] }, undefined, 'box', (payload) => calls.push(payload));
  assert.equal(id, DEVICE);
  assert.equal(log.channels.length, 1);
  assert.equal(log.channels[0].name, deviceTopic(USER, DEVICE));
  assert.equal(log.channels[0].name, `user:${USER}:device:${DEVICE}`);
  assert.equal(log.channels[0].opts.config.private, true);
  assert.equal(log.channels[0].opts.config.presence.key, DEVICE);
  assert.equal(log.tracks.length, 1);
  const meta = log.tracks[0];
  assert.deepEqual(Object.keys(meta).sort(), ['connection_generation', 'device_id', 'local_mcp_ready', 'transport']);
  assert.deepEqual(meta, presenceMeta(DEVICE, true, meta.connection_generation));
  assert.match(meta.connection_generation, /^[0-9a-f-]{36}$/);
});
await test('D6: every channel join gets a fresh connection_generation', async () => {
  const { rc, log } = makeRelayChannel();
  await rc.registerDevice({ tools: [] }, DEVICE, 'box', () => {});
  await rc.createChannel();
  assert.equal(log.tracks.length, 2);
  assert.notEqual(log.tracks[0].connection_generation, log.tracks[1].connection_generation);
});
await test('D6: doorbell claims via RPC with the current generation, then selects the row', async () => {
  const { rc, log } = makeRelayChannel();
  const calls = [];
  await rc.registerDevice({ tools: [] }, DEVICE, 'box', (payload) => calls.push(payload));
  log.channels[0].channel.fire('new_call', { call_id: 'call-1', device_id: DEVICE });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const claim = log.rpc.find((c) => c.name === 'claim_mcp_remote_call');
  assert.deepEqual(claim.args, { p_call_id: 'call-1', p_device_id: DEVICE, p_connection_generation: log.tracks[0].connection_generation });
  assert.equal(log.selects[0].table, 'mcp_remote_calls');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].claimed, true);
  assert.equal(calls[0].new.tool_name, 'list_directory');
});
await test('D6: an unclaimable call (false) is not executed', async () => {
  const { rc, log } = makeRelayChannel({ claim: false });
  const calls = [];
  await rc.registerDevice({ tools: [] }, DEVICE, 'box', (payload) => calls.push(payload));
  log.channels[0].channel.fire('new_call', { call_id: 'call-1', device_id: DEVICE });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 0);
  assert.equal(log.selects.length, 0);
});
await test('D6: completion uses the RPC; null (lost race) is not retried; no client result doorbell', async () => {
  const { rc, log } = makeRelayChannel({ complete: null });
  await rc.registerDevice({ tools: [] }, DEVICE, 'box', () => {});
  await rc.updateCallResult('call-1', 'completed', { content: [{ type: 'text', text: `a${String.fromCharCode(0)}b` }] });
  await rc.notifyResult('call-1');
  const completes = log.rpc.filter((c) => c.name === 'complete_mcp_remote_call');
  assert.equal(completes.length, 1, 'lost race was retried');
  assert.deepEqual(completes[0].args, {
    p_call_id: 'call-1', p_device_id: DEVICE, p_connection_generation: log.tracks[0].connection_generation,
    p_status: 'completed', p_result: { content: [{ type: 'text', text: 'ab' }] }, p_error_message: null,
  });
  assert.equal(log.sends.length, 0, 'client-side result doorbell sent in relay mode');
});
await test('D6: Presence is republished when local readiness changes', async () => {
  const { rc, log, setReady } = makeRelayChannel();
  await rc.registerDevice({ tools: [] }, DEVICE, 'box', () => {});
  rc.shuttingDown = true; // suppress status writes; Presence republish is independent
  setReady(false);
  rc.syncReachabilityStatus();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(log.tracks.length, 2);
  assert.equal(log.tracks[1].local_mcp_ready, false);
  assert.equal(log.tracks[1].connection_generation, log.tracks[0].connection_generation);
});

await test('gating: DC cloud mode keeps the per-user topic, legacy Presence payload, and client result doorbell', async () => {
  const rc = new RemoteChannel({ isLocalReady: () => true });
  const { client, log } = makeRelayClient();
  rc.client = client;
  rc._user = { id: USER, email: 'j@example.com' };
  rc.deviceId = DEVICE;
  rc.deviceName = 'box';
  rc.onToolCall = () => {};
  rc.shuttingDown = false;
  await rc.createChannel();
  assert.equal(rc.isOAuthRelay, false);
  assert.equal(log.channels[0].name, `user:${USER}`);
  assert.deepEqual(Object.keys(log.tracks[0]).sort(), ['app_version', 'device_id', 'device_name', 'platform']);
  await rc.notifyResult('call-1');
  assert.deepEqual(log.sends, [{ type: 'broadcast', event: 'result', payload: { call_id: 'call-1' } }]);
  assert.equal(log.rpc.length, 0, 'DC cloud mode called relay RPCs');
});

// ---------------------------------------------------------------- D3
await test('D3: TOKEN_REFRESHED hands the rotated pair to the owner', async () => {
  const rotated = [];
  const rc = new RemoteChannel({ onSessionTokens: (t) => rotated.push(t) });
  let listener;
  rc.client = {
    auth: {
      setSession: async () => ({ error: null }),
      getUser: async () => ({ data: { user: { id: USER, email: 'j@example.com' } }, error: null }),
      getSession: async () => ({ data: { session: { access_token: 'at-1', refresh_token: 'rt-1' } } }),
      onAuthStateChange: (cb) => { listener = cb; },
    },
    realtime: { setAuth() {} },
  };
  await rc.setSession({ access_token: 'at-1', refresh_token: 'rt-1' });
  listener('TOKEN_REFRESHED', { access_token: 'at-2', refresh_token: 'rt-2' });
  assert.deepEqual(rotated, [{ access_token: 'at-2', refresh_token: 'rt-2' }]);
});
await test('D3: persistence is atomic, 0600, serialized in call order', async () => {
  const device = new MCPDevice();
  device.deviceId = DEVICE;
  const writes = [];
  for (let i = 1; i <= 20; i++) writes.push(device.savePersistedConfig({ access_token: `at-${i}`, refresh_token: `rt-${i}` }));
  await Promise.all(writes);
  const file = process.env.DESKTOP_COMMANDER_DEVICE_CONFIG_PATH;
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(saved.session.refresh_token, 'rt-20', 'an older rotated token landed last');
  assert.equal(saved.deviceId, DEVICE);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const leftovers = (await fs.readdir(path.dirname(file))).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'temp files left behind');
});
await test('D3: --no-persist-session never writes a session', async () => {
  const device = new MCPDevice({ persistSession: false });
  device.deviceId = DEVICE;
  await device.savePersistedConfig({ access_token: 'at-x', refresh_token: 'rt-x' });
  const saved = JSON.parse(await fs.readFile(process.env.DESKTOP_COMMANDER_DEVICE_CONFIG_PATH, 'utf8'));
  assert.equal(saved.session, null);
});

// ---------------------------------------------------------------- D4
await test('D4: offline subprocess gets no token in argv and the access token only on stdin', async () => {
  const spawned = [];
  childProcess.spawnSync = (command, args, options) => {
    spawned.push({ command, args, options });
    return { status: 0, stdout: '', stderr: '' };
  };
  syncBuiltinESMExports();
  try {
    const rc = new RemoteChannel();
    rc.client = {
      supabaseUrl: SUPABASE, supabaseKey: 'sb_publishable_x',
      auth: { getSession: async () => ({ data: { session: { access_token: 'secret-at', refresh_token: 'secret-rt' } } }) },
    };
    await rc.setOffline(DEVICE);
  } finally {
    childProcess.spawnSync = realSpawnSync;
    syncBuiltinESMExports();
  }
  assert.equal(spawned.length, 1);
  const argv = spawned[0].args.join(' ');
  assert(!argv.includes('secret-at') && !argv.includes('secret-rt'), 'token leaked into argv');
  assert.deepEqual(JSON.parse(spawned[0].options.input), { access_token: 'secret-at' });
  assert(!spawned[0].options.input.includes('secret-rt'), 'refresh token passed to subprocess');
});
const script = fileURLToPath(new URL('../dist/remote-device/scripts/blocking-offline-update.js', import.meta.url));
await test('D4: expired access token exits 2 without any network write', () => {
  const token = jwt({ exp: Math.floor(Date.now() / 1000) - 60 });
  const result = realSpawnSync(process.execPath, [script, DEVICE, 'http://127.0.0.1:9', 'k', new Date().toISOString()], { input: JSON.stringify({ access_token: token }), encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 2, result.stderr);
});
await test('D4: missing stdin token exits 1', () => {
  const result = realSpawnSync(process.execPath, [script, DEVICE, 'http://127.0.0.1:9', 'k', new Date().toISOString()], { input: '', encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1);
});

await fs.rm(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} own-relay test(s) failed` : '\nAll own-relay tests passed');
process.exit(failures ? 1 : 0);
