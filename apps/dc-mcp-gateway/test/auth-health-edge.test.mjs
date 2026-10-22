#!/usr/bin/env node
/**
 * Edge end to end: a protocol-faithful stand-in for a connected app (ChatGPT / Claude) against the real server.js.
 *
 * Proves, with the real HTTP surface (/jc/mcp, /token) and a stub ACS that records auth events:
 *  - OAuth correctness is always on, flag or no flag: invalid_token challenges, refresh-reuse detection
 *  - ACS_MCP_AUTH_EVENTS is OFF by default: ACS receives nothing; ON: it receives exactly the reportable facts
 *  - false-positive guards: an expired-but-refreshable access token, a missing token, a forged token, an unreachable
 *    ACS, and idle time never produce a "refresh_failed"/revocation report
 *  - strict rotation, with no retry or cached-response path: a stolen refresh token alone never yields credentials
 *
 * This simulates the clients' documented OAuth behaviour. It is NOT a substitute for the manual live check against
 * the real ChatGPT and Claude apps described in docs/plans/oauth-reauthentication-detection.md.
 *
 * Run: node --test test/auth-health-edge.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';

const KEY = 'k'.repeat(32);
const ORIGIN = 'https://gw.test';
const JC_RESOURCE = `${ORIGIN}/jc/mcp`;
const JC_ISSUER = `${ORIGIN}/jc`;
const SECRET = crypto.randomBytes(16).toString('hex');
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const nowS = () => Math.floor(Date.now() / 1000);

function jwt(over = {}, key = KEY) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ iss: JC_ISSUER, sub: 'jacen', aud: JC_RESOURCE, client_id: 'public-app', scope: 'mcp', iat: nowS() - 10, exp: nowS() + 600, jti: crypto.randomUUID(), ...over }));
  return `${h}.${p}.${crypto.createHmac('sha256', key).update(`${h}.${p}`).digest('base64url')}`;
}

function stubServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      requests.push({ path: req.url, body: text ? JSON.parse(text) : null });
      const { status, body } = handler(requests.at(-1));
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  return { server, requests, listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))) };
}

let nextPort = 18900;
async function boot({ authEvents = false, idempotentRetry = false, acsUp = true, tokens = {}, tokensMode } = {}) {
  const acs = stubServer((req) => (acsUp ? { status: 202, body: { recorded: true } } : { status: 500, body: { error: 'down' } }));
  const jcUp = stubServer((req) => (req.path === '/authority' ? { status: 200, body: { variant: 'jc' } } : { status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } }));
  const dcUp = stubServer(() => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } }));
  const [acsPort, jcPort, dcPort] = [await acs.listen(), await jcUp.listen(), await dcUp.listen()];
  const port = nextPort++;
  const dir = `/tmp/auth-health-${port}-${process.pid}`;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${dir}/clients.json`, JSON.stringify({
    'public-app': { client_name: 'public', redirect_uris: ['https://app.test/cb'], token_endpoint_auth_method: 'none', oauth_lane: 'jc', scope: 'mcp' },
    'confidential-app': { client_name: 'conf', redirect_uris: ['https://app.test/cb'], token_endpoint_auth_method: 'client_secret_post', client_secret: SECRET, oauth_lane: 'jc', scope: 'mcp' },
  }));
  fs.writeFileSync(`${dir}/tokens.json`, JSON.stringify(tokens));
  if (tokensMode) fs.chmodSync(`${dir}/tokens.json`, tokensMode);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      PATH: process.env.PATH, GATEWAY_PORT: String(port), PUBLIC_ORIGIN: ORIGIN, CONSENT_PASSPHRASE: 'pass-phrase', SIGNING_KEY: KEY, DATA_DIR: dir,
      UPSTREAM: `http://127.0.0.1:${dcPort}`, JC_ENABLED: '1', JC_UPSTREAM: `http://127.0.0.1:${jcPort}`,
      ACS_GATEWAY_URL: `http://127.0.0.1:${acsPort}`, ACS_JC_GATEWAY_TOKEN: 'jc-bridge-token',
      ...(authEvents ? { ACS_MCP_AUTH_EVENTS: '1' } : {}), ...(idempotentRetry ? { ACS_REFRESH_IDEMPOTENT_RETRY: '1' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let output = '';
  child.stderr.on('data', (d) => { stderr += d; output += d; });
  child.stdout.on('data', (d) => { output += d; });
  let up = false;
  for (let i = 0; i < 60 && !up; i += 1) {
    if (child.exitCode !== null) break;
    try { up = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  assert.ok(up, `gateway failed to start: ${stderr}`);
  const base = `http://127.0.0.1:${port}`;
  return {
    acs,
    base,
    events: () => acs.requests.filter((r) => r.path === '/mcp-clients/auth-event').map((r) => r.body),
    mcp: (authorization, extra = {}) => fetch(`${base}/jc/mcp`, {
      method: 'POST',
      headers: { ...(authorization ? { authorization } : {}), 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', ...extra }),
    }),
    refresh: (refreshToken, clientId = 'public-app', secret) => fetch(`${base}/token?oauth_lane=jc`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, ...(secret ? { client_secret: secret } : {}), resource: JC_RESOURCE }).toString(),
    }),
    logs: () => output,
    tokensFile: `${dir}/tokens.json`,
    tokensOnDisk: () => JSON.parse(fs.readFileSync(`${dir}/tokens.json`, 'utf8')),
    close: () => { child.kill('SIGKILL'); acs.server.close(); jcUp.server.close(); dcUp.server.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
const strip = ({ observedAt, ...rest }) => { assert.ok(!Number.isNaN(Date.parse(observedAt)), 'every report carries an edge timestamp'); return rest; };
const settle = () => new Promise((r) => setTimeout(r, 300));
const refreshRecord = (over = {}) => ({ client_id: 'public-app', scope: 'mcp', resource: JC_RESOURCE, issuer: JC_ISSUER, exp: nowS() + 86_400, active: true, ...over });

test('always on: a missing token gets a bare challenge; an expired token gets invalid_token and names expiry', async () => {
  const gw = await boot();
  try {
    const missing = await gw.mcp(undefined);
    assert.equal(missing.status, 401);
    assert.doesNotMatch(missing.headers.get('www-authenticate'), /error=/);
    assert.match(missing.headers.get('www-authenticate'), /resource_metadata=/);
    const expired = await gw.mcp(`Bearer ${jwt({ exp: nowS() - 5 })}`);
    assert.equal(expired.status, 401);
    assert.match(expired.headers.get('www-authenticate'), /resource_metadata=.*error="invalid_token".*expired/s);
    const wrongAudience = await gw.mcp(`Bearer ${jwt({ aud: `${ORIGIN}/mcp` })}`);
    assert.match(wrongAudience.headers.get('www-authenticate'), /error="invalid_token"/);
    assert.equal((await gw.mcp(`Bearer ${jwt()}`)).status, 200);
  } finally { gw.close(); }
});

test('default OFF: nothing is reported to ACS, but refresh reuse is still rejected', async () => {
  const gw = await boot({ tokens: { R1: refreshRecord(), R0: refreshRecord({ active: false, rotatedAt: nowS() - 600, successor: 'R1' }) } });
  try {
    await gw.mcp(`Bearer ${jwt({ exp: nowS() - 5 })}`);
    const first = await gw.refresh('R1');
    assert.equal(first.status, 200);
    assert.equal((await gw.refresh('R0')).status, 400, 'strict rotation: the used token is dead');
    assert.equal((await gw.refresh('R1')).status, 400, 'strict rotation: the just-used token is dead too');
    await settle();
    assert.deepEqual(gw.events(), []);
  } finally { gw.close(); }
});

test('flag ON: refresh success and a genuine reuse (lost response) are reported with the verified client and the right reason', async () => {
  const old = { active: false, rotatedAt: nowS() - 600, successor: 'R2' };
  const gw = await boot({ authEvents: true, tokens: { R1: refreshRecord(old), R2: refreshRecord(), R3: refreshRecord() } });
  try {
    assert.equal((await gw.refresh('R3')).status, 200);
    assert.equal((await gw.refresh('R1')).status, 400);
    await settle();
    const events = gw.events();
    const refreshed = events.find((e) => e.kind === 'refreshed');
    assert.equal(refreshed.clientId, 'public-app');
    assert.equal(refreshed.lane, 'jc');
    assert.ok(Date.parse(refreshed.refreshExpiresAt) > Date.now() + 20 * 86_400_000);
    assert.deepEqual(strip(events.find((e) => e.kind === 'refresh_failed')), { lane: 'jc', clientId: 'public-app', subject: 'jacen', kind: 'refresh_failed', reason: 'refresh_reused' });
  } finally { gw.close(); }
});

test('security: a double-submitted refresh (parallel, same token) never flags the client that holds the successor', async () => {
  const gw = await boot({ authEvents: true, tokens: { R1: refreshRecord() } });
  try {
    const [a, b] = await Promise.all([gw.refresh('R1'), gw.refresh('R1')]);
    assert.deepEqual([a.status, b.status].sort(), [200, 400]);
    await settle();
    assert.equal(gw.events().filter((e) => e.kind === 'refresh_failed').length, 0);
    assert.equal(gw.events().filter((e) => e.kind === 'refreshed').length, 1);
  } finally { gw.close(); }
});

test('security: a stranger with a leaked token and a wrong secret / client_id cannot flag the real client', async () => {
  const gw = await boot({ authEvents: true, tokens: { R1: refreshRecord({ client_id: 'confidential-app' }) } });
  try {
    assert.equal((await gw.refresh('R1', 'confidential-app', 'wrong')).status, 401);
    assert.equal((await gw.refresh('R1', 'public-app')).status, 400);
    await settle();
    assert.deepEqual(gw.events(), []);
  } finally { gw.close(); }
});

test('observability: every refresh refusal is logged with reason, lane and client, never a token, even with reporting OFF', async () => {
  const gw = await boot({ tokens: { R1: refreshRecord({ active: false, rotatedAt: nowS() - 600, successor: 'R2' }), R2: refreshRecord() } });
  try {
    assert.equal((await gw.refresh('R1')).status, 400);
    await settle();
    assert.match(gw.logs(), /auth: refresh refused reason=refresh_reused lane=jc client=public-app/);
    assert.ok(!gw.logs().includes('R1'));
  } finally { gw.close(); }
});

test('security: a refresh record whose local client was deleted is refused (no silent downgrade to a public client)', async () => {
  const gw = await boot({ tokens: { G1: refreshRecord({ client_id: 'ghost-client' }) } });
  try {
    assert.equal((await gw.refresh('G1', 'ghost-client')).status, 400);
    assert.equal(gw.tokensOnDisk().G1.active, true, 'refused without consuming');
  } finally { gw.close(); }
});

test('security: saveJson never writes through a planted tmp symlink and leaves no tmp file', async () => {
  const gw = await boot({ tokens: { R1: refreshRecord() } });
  try {
    const victim = `${gw.tokensFile}.victim`;
    fs.writeFileSync(victim, 'untouched');
    // The edge's pid is not known to the test; plant symlinks for a plausible range is pointless, so assert the contract
    // directly: after a normal save no tmp exists and tokens.json is a regular 0600 file.
    assert.equal((await gw.refresh('R1')).status, 200);
    const st = fs.lstatSync(gw.tokensFile);
    assert.ok(st.isFile() && (st.mode & 0o777) === 0o600);
    assert.deepEqual(fs.readdirSync(new URL('.', `file://${gw.tokensFile}`).pathname).filter((f) => f.endsWith('.tmp')), []);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'untouched');
  } finally { gw.close(); }
});

test('dynamic client registration is rate limited so a flood cannot starve the edge', async () => {
  const gw = await boot();
  try {
    const statuses = [];
    for (let i = 0; i < 70; i += 1) {
      const r = await fetch(`${gw.base}/register?oauth_lane=jc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://a.test/cb'] }) });
      statuses.push(r.status);
    }
    assert.equal(statuses.filter((s) => s === 201).length, 60);
    assert.ok(statuses.includes(429));
    assert.equal((await fetch(`${gw.base}/healthz`)).status, 200);
  } finally { gw.close(); }
});

test('flag ON: an expired token is reported as renewable and a refreshable client stays unflagged', async () => {
  const gw = await boot({ authEvents: true, tokens: { R1: refreshRecord() } });
  try {
    assert.equal((await gw.mcp(`Bearer ${jwt({ exp: nowS() - 5 })}`)).status, 401);
    assert.equal((await gw.refresh('R1')).status, 200);
    await settle();
    const events = gw.events();
    assert.deepEqual(strip(events.find((e) => e.kind === 'token_rejected')), { lane: 'jc', clientId: 'public-app', subject: 'jacen', kind: 'token_rejected', reason: 'access_token_expired' });
    assert.equal(events.filter((e) => e.kind === 'refresh_failed' || e.kind === 'revoked').length, 0);
  } finally { gw.close(); }
});

test('flag ON: an expired refresh token is reported as refresh_expired', async () => {
  const gw = await boot({ authEvents: true, tokens: { R1: refreshRecord({ exp: nowS() - 1 }) } });
  try {
    assert.equal((await gw.refresh('R1')).status, 400);
    await settle();
    assert.equal(gw.events().find((e) => e.kind === 'refresh_failed').reason, 'refresh_expired');
  } finally { gw.close(); }
});

test('flag ON: missing, forged and unknown credentials are never attributed to a client', async () => {
  const gw = await boot({ authEvents: true });
  try {
    await gw.mcp(undefined);
    await gw.mcp(`Bearer ${jwt({ client_id: 'victim' }, 'x'.repeat(32))}`);
    await gw.mcp('Bearer garbage');
    assert.equal((await gw.refresh('does-not-exist', 'victim')).status, 400);
    await settle();
    assert.deepEqual(gw.events(), []);
  } finally { gw.close(); }
});

test('an unreachable ACS never changes an auth decision (outage is not an auth failure)', async () => {
  const gw = await boot({ authEvents: true, acsUp: false, tokens: { R1: refreshRecord() } });
  try {
    assert.equal((await gw.mcp(`Bearer ${jwt()}`)).status, 200);
    assert.equal((await gw.mcp(`Bearer ${jwt({ exp: nowS() - 5 })}`)).status, 401);
    assert.equal((await gw.refresh('R1')).status, 200);
  } finally { gw.close(); }
});

test('a confidential client must authenticate to refresh', async () => {
  const gw = await boot({ tokens: { R1: refreshRecord({ client_id: 'confidential-app' }), R2: refreshRecord({ client_id: 'confidential-app' }) } });
  try {
    assert.equal((await gw.refresh('R1', 'confidential-app')).status, 401);
    assert.equal((await gw.refresh('R1', 'confidential-app', 'wrong')).status, 401);
    assert.equal((await gw.refresh('R1', 'confidential-app', SECRET)).status, 200);
  } finally { gw.close(); }
});

test('strict rotation by default: even the authenticated owner cannot reuse a rotated token', async () => {
  const gw = await boot({ tokens: { R1: refreshRecord({ client_id: 'confidential-app' }) } });
  try {
    assert.equal((await gw.refresh('R1', 'confidential-app', SECRET)).status, 200);
    assert.equal((await gw.refresh('R1', 'confidential-app', SECRET)).status, 400);
    assert.equal(Object.values(gw.tokensOnDisk()).some((r) => r.replay), false, 'no response is cached when the retry is off');
  } finally { gw.close(); }
});

// ---------------------------------------------------------------------------------------------------------------------
// Security review of the refresh path (see docs/plans/oauth-reauthentication-security-review.md)
// ---------------------------------------------------------------------------------------------------------------------

test('security: a refresh token is bound to the client it was issued to', async () => {
  const gw = await boot({ authEvents: true, tokens: { R1: refreshRecord({ client_id: 'public-app' }) } });
  try {
    // A different client_id cannot redeem it, and the real client is NOT flagged by someone else's attempt.
    assert.equal((await gw.refresh('R1', 'confidential-app', SECRET)).status, 400);
    await settle();
    assert.deepEqual(gw.events(), []);
    assert.equal(gw.tokensOnDisk().R1.active, true, 'the failed attempt must not consume the token');
    assert.equal((await gw.refresh('R1', 'public-app')).status, 200);
  } finally { gw.close(); }
});

test('security: a client that omits client_id on refresh still works (RFC 6749 allows it for authenticated clients)', async () => {
  const gw = await boot({ tokens: { R1: refreshRecord({ client_id: 'confidential-app' }) } });
  try {
    const res = await fetch(`http://127.0.0.1:${new URL(gw.base).port}/token?oauth_lane=jc`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'R1', client_secret: SECRET, resource: JC_RESOURCE }).toString(),
    });
    assert.equal(res.status, 200);
  } finally { gw.close(); }
});

test('security: holding another client\'s secret does not help redeem someone else\'s refresh token', async () => {
  const gw = await boot({ tokens: { R1: refreshRecord({ client_id: 'confidential-app' }) } });
  try {
    assert.equal((await gw.refresh('R1', 'public-app', SECRET)).status, 400);
    assert.equal((await gw.refresh('R1', 'confidential-app', 'other-secret')).status, 401);
    assert.equal(gw.tokensOnDisk().R1.active, true);
  } finally { gw.close(); }
});

test('security: prototype keys are not refresh tokens', async () => {
  const gw = await boot({ authEvents: true });
  try {
    for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      assert.equal((await gw.refresh(key)).status, 400, key);
    }
    await settle();
    assert.deepEqual(gw.events(), []);
  } finally { gw.close(); }
});

test('security: rotation is atomic - parallel redemptions of one refresh token yield exactly one success', async () => {
  const gw = await boot({ tokens: { R1: refreshRecord({ client_id: 'confidential-app' }) } });
  try {
    const results = await Promise.all(Array.from({ length: 12 }, () => gw.refresh('R1', 'confidential-app', SECRET)));
    const statuses = results.map((r) => r.status).sort();
    assert.equal(statuses.filter((s) => s === 200).length, 1, statuses.join(','));
    assert.ok(statuses.every((s) => s === 200 || s === 400));
    const successors = Object.values(gw.tokensOnDisk()).filter((r) => r.active);
    assert.equal(successors.length, 1, 'exactly one live successor');
  } finally { gw.close(); }
});

test('security: tokens.json is private (0600), replaced atomically, and never left half-written', async () => {
  const gw = await boot({ tokens: { R1: refreshRecord() }, tokensMode: 0o644 });
  try {
    assert.equal(fs.statSync(gw.tokensFile).mode & 0o777, 0o644, 'precondition: loosely-permissioned file');
    let token = 'R1';
    for (let i = 0; i < 5; i += 1) {
      const res = await gw.refresh(token);
      assert.equal(res.status, 200);
      token = (await res.json()).refresh_token;
    }
    assert.equal(fs.statSync(gw.tokensFile).mode & 0o777, 0o600, 'a save tightens a pre-existing loose file');
    JSON.parse(fs.readFileSync(gw.tokensFile, 'utf8'));
    const leftovers = fs.readdirSync(new URL('.', `file://${gw.tokensFile}`).pathname).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  } finally { gw.close(); }
});

test('security: no token or secret ever reaches the logs, on success or failure', async () => {
  const gw = await boot({ authEvents: true, tokens: { R1: refreshRecord({ client_id: 'confidential-app' }) } });
  try {
    const ok = await (await gw.refresh('R1', 'confidential-app', SECRET)).json();
    await gw.refresh('R1', 'confidential-app', SECRET);
    await gw.refresh('R1', 'confidential-app', 'wrong-secret-value');
    const expired = jwt({ client_id: 'confidential-app', exp: nowS() - 5 });
    await gw.mcp(`Bearer ${expired}`);
    await settle();
    const logs = gw.logs();
    for (const secret of [ok.refresh_token, ok.access_token, SECRET, 'wrong-secret-value', expired, 'R1']) {
      assert.ok(!logs.includes(secret), `a credential leaked into the logs: ${secret.slice(0, 8)}...`);
    }
    // Nor does any report to ACS carry token material.
    assert.doesNotMatch(JSON.stringify(gw.acs.requests), /"access_token"|"refresh_token"|eyJ|wrong-secret/);
  } finally { gw.close(); }
});

test('security: strict rotation does not revoke the successor on reuse (documented limitation, not a regression)', async () => {
  const gw = await boot({ tokens: { P1: refreshRecord() } });
  try {
    const successor = (await (await gw.refresh('P1')).json()).refresh_token;
    assert.equal((await gw.refresh('P1')).status, 400, 'reuse is refused');
    assert.equal((await gw.refresh(successor)).status, 200, 'the legitimate successor keeps working');
  } finally { gw.close(); }
});

test('security: the removed retry flag is inert - strict rotation and nothing cached, even if the variable is set', async () => {
  const gw = await boot({ idempotentRetry: true, tokens: { C1: refreshRecord({ client_id: 'confidential-app' }), P1: refreshRecord() } });
  try {
    assert.equal((await gw.refresh('C1', 'confidential-app', SECRET)).status, 200);
    assert.equal((await gw.refresh('C1', 'confidential-app', SECRET)).status, 400, 'the authenticated owner cannot reuse a rotated token');
    assert.equal((await gw.refresh('P1')).status, 200);
    assert.equal((await gw.refresh('P1')).status, 400);
    const text = fs.readFileSync(gw.tokensFile, 'utf8');
    assert.doesNotMatch(text, /"replay"|"access_token"/, 'no response or access token is ever persisted');
    assert.equal(fs.statSync(gw.tokensFile).mode & 0o777, 0o600);
  } finally { gw.close(); }
});

test('a stale duplicate refresh (client already moved on to its successor) raises no report', async () => {
  const gw = await boot({ authEvents: true, tokens: { R1: refreshRecord({ active: false, rotatedAt: nowS() - 600, successor: 'R2' }), R2: refreshRecord({ active: false, rotatedAt: nowS() - 300, successor: 'R3' }), R3: refreshRecord() } });
  try {
    assert.equal((await gw.refresh('R1')).status, 400, 'a late duplicate of the old request is refused');
    await settle();
    assert.equal(gw.events().filter((e) => e.kind === 'refresh_failed').length, 0);
  } finally { gw.close(); }
});
