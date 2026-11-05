#!/usr/bin/env node
/**
 * Passphrase brute-force protection.
 *
 * The configured consent passphrase must meet a minimum strength. Failed
 * attempts are bounded per trusted client identity, per OAuth client, and
 * globally. Forwarded headers are not a client identity. Registration of a
 * new client does not reset the budget. Logs never contain the passphrase,
 * the transaction id, or the request body.
 *
 * Run: node --test test/consent-lockout.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  CONSENT_CLIENT_MAX_FAILURES,
  CONSENT_GLOBAL_MAX_FAILURES,
  CONSENT_LOCKOUT_MS,
  CONSENT_SOURCE_MAX_FAILURES,
  ConsentStoreUnavailable,
  INGRESS_CLIENT_HEADER,
  INGRESS_PROOF_HEADER,
  consentSource,
  consentSourceKey,
  createConsentLimiter,
  passphraseStrengthError,
  resolveConsentLockoutMs,
  stampIngressIdentity,
} from '../consent-guard.js';

const KEY = 'k'.repeat(32);
const IDENTITY_KEY = 'i'.repeat(32);
const ORIGIN = 'https://gw.test';
const JC_RESOURCE = `${ORIGIN}/jc/mcp`;
const PASS = 'consent-test-pass-1';
const WRONG_PASS = 'not-the-passphrase';
const gatewayDir = fileURLToPath(new URL('..', import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('passphrase strength fails closed and the lock duration cannot be turned off', () => {
  assert.equal(passphraseStrengthError(PASS), null);
  assert.equal(passphraseStrengthError('replay-test-passphrase'), null);
  assert.equal(passphraseStrengthError('cert-e2e-passphrase'), null);
  assert.equal(passphraseStrengthError('e2e-consent-pass-1'), null);
  assert.equal(passphraseStrengthError('lab-000000000000A1'), null);
  assert.match(passphraseStrengthError('x'), /at least 16 characters/);
  assert.match(passphraseStrengthError('pass-phrase'), /at least 16 characters/);
  assert.match(passphraseStrengthError('a'.repeat(16)), /two of lowercase/);
  assert.match(passphraseStrengthError('consent test pass 1'), /whitespace/);
  assert.match(passphraseStrengthError(`consent-test-${String.fromCharCode(0)}pass`), /whitespace|control/);
  assert.match(passphraseStrengthError(`consent-test-pass-1${'a'.repeat(300)}`), /at most 256/);
  assert.match(passphraseStrengthError('aa-11111111111111'), /4 distinct/);
  assert.equal(passphraseStrengthError('x').includes('x'), false);

  assert.equal(resolveConsentLockoutMs({ testMode: false, raw: '50' }), CONSENT_LOCKOUT_MS);
  assert.equal(resolveConsentLockoutMs({ testMode: true, raw: '0' }), CONSENT_LOCKOUT_MS);
  assert.equal(resolveConsentLockoutMs({ testMode: true, raw: '49' }), CONSENT_LOCKOUT_MS);
  assert.equal(resolveConsentLockoutMs({ testMode: true, raw: '' }), CONSENT_LOCKOUT_MS);
  assert.equal(resolveConsentLockoutMs({ testMode: true, raw: '50' }), 50);
  assert.equal(resolveConsentLockoutMs({ testMode: true, raw: '2000' }), 2000);
  assert.equal(resolveConsentLockoutMs({ testMode: true, raw: String(CONSENT_LOCKOUT_MS + 5) }), CONSENT_LOCKOUT_MS);
  assert.throws(() => createConsentLimiter({ lockoutMs: 0 }), /positive/);
  assert.throws(() => createConsentLimiter({ sourceMax: 0 }), /positive/);
});

test('spoofed identity headers are rejected and a proven ingress stamp is accepted', () => {
  const stamped = stampIngressIdentity('203.0.113.10', IDENTITY_KEY);
  const forwarded = {
    'x-forwarded-for': '203.0.113.9',
    'x-real-ip': '198.51.100.9',
    forwarded: 'for=192.0.2.9',
    ...stamped,
  };
  assert.deepEqual(consentSource('127.0.0.1', stamped, { identityKey: IDENTITY_KEY }), { ok: true, source: { kind: 'ingress', id: '203.0.113.10' } });
  assert.deepEqual(consentSource('::ffff:127.0.0.1', stampIngressIdentity('[::1]', IDENTITY_KEY), { identityKey: IDENTITY_KEY }), { ok: true, source: { kind: 'ingress', id: '::1' } });
  assert.equal(consentSource('127.0.0.1', forwarded, { identityKey: IDENTITY_KEY }).ok, false);
  assert.equal(consentSource('127.0.0.1', { [INGRESS_CLIENT_HEADER]: '203.0.113.10' }, { identityKey: IDENTITY_KEY }).ok, false);
  assert.equal(consentSource('203.0.113.8', stamped, { identityKey: IDENTITY_KEY }).ok, false);
  assert.equal(consentSource('127.0.0.1', { [INGRESS_CLIENT_HEADER]: ['203.0.113.10', '198.51.100.10'] }, { identityKey: IDENTITY_KEY }).ok, false);
  assert.equal(consentSource('127.0.0.1', { [INGRESS_CLIENT_HEADER]: '203.0.113.10, 198.51.100.10' }, { identityKey: IDENTITY_KEY }).ok, false);
  assert.equal(consentSource('127.0.0.1', { 'x-real-ip': '198.51.100.9' }, { identityKey: IDENTITY_KEY }).ok, false);
  assert.equal(consentSource('127.0.0.1', { forwarded: 'for=192.0.2.9' }, { identityKey: IDENTITY_KEY }).ok, false);
  assert.deepEqual(consentSource('127.0.0.1', {}, { identityKey: IDENTITY_KEY }), { ok: true, source: { kind: 'peer', id: '127.0.0.1' } });
  const wrong = stampIngressIdentity('203.0.113.10', `${IDENTITY_KEY}other-key-material`);
  assert.equal(consentSource('127.0.0.1', wrong, { identityKey: IDENTITY_KEY }).ok, false);
  const missingKey = consentSource('127.0.0.1', stamped, { identityKey: '' });
  assert.equal(missingKey.ok, false);
  assert.equal(JSON.stringify(missingKey).includes(IDENTITY_KEY), false);
});

test('lockout expires, does not slide, and keeps source, client, and global buckets apart', () => {
  let clock = 0;
  const limiter = createConsentLimiter({ now: () => clock, lockoutMs: 10_000, sourceMax: 5, clientMax: 5, globalMax: 50 });
  const source = 'source-a';
  for (let i = 0; i < 3; i += 1) limiter.recordFailure({ sourceKey: source });
  assert.equal(limiter.snapshot({ sourceKey: source }).locked, false);
  clock = 10_000;
  for (let i = 0; i < 4; i += 1) limiter.recordFailure({ sourceKey: source });
  assert.equal(limiter.snapshot({ sourceKey: source }).locked, false, 'an elapsed window must not keep old failures');
  const tripped = limiter.recordFailure({ sourceKey: source });
  assert.equal(tripped.locked, true);
  assert.equal(tripped.retryAfterSec, 10);

  clock = 0;
  const sliding = createConsentLimiter({ now: () => clock, lockoutMs: 10_000, sourceMax: 5, clientMax: 5, globalMax: 50 });
  for (let i = 0; i < 5; i += 1) sliding.recordFailure({ sourceKey: 'held' });
  assert.equal(sliding.snapshot({ sourceKey: 'held' }).retryAfterSec, 10);
  clock = 3_000;
  sliding.recordFailure({ sourceKey: 'held' });
  assert.equal(sliding.snapshot({ sourceKey: 'held' }).retryAfterSec, 7, 'attempts during a lock must not extend it');

  clock = 0;
  const split = createConsentLimiter({ now: () => clock, lockoutMs: 5_000, sourceMax: 10, clientMax: 2, globalMax: 50 });
  split.recordFailure({ sourceKey: 'a', clientKey: 'client' });
  split.recordFailure({ sourceKey: 'b', clientKey: 'client' });
  assert.equal(split.snapshot({ sourceKey: 'c', clientKey: 'client' }).clientLocked, true);
  assert.equal(split.snapshot({ sourceKey: 'c', clientKey: 'other' }).locked, false);

  const global = createConsentLimiter({ now: () => clock, lockoutMs: 5_000, sourceMax: 5, clientMax: 5, globalMax: 3 });
  global.recordFailure({ sourceKey: 'a', clientKey: 'c1' });
  global.recordFailure({ sourceKey: 'b', clientKey: 'c2' });
  assert.equal(global.snapshot({ sourceKey: 'c', clientKey: 'c3' }).locked, false);
  global.recordFailure({ sourceKey: 'c', clientKey: 'c3' });
  const blocked = global.snapshot({ sourceKey: 'd', clientKey: 'c4' });
  assert.equal(blocked.globalLocked, true);
  assert.equal(blocked.sourceLocked, false);

  const capped = createConsentLimiter({ cap: 1, sourceMax: 5, clientMax: 5, globalMax: 50, lockoutMs: 5_000, now: () => 0 });
  capped.recordFailure({ sourceKey: 'a' });
  assert.equal(capped.snapshot({ sourceKey: 'b' }).saturated, true);
  assert.equal(capped.snapshot({ sourceKey: 'a' }).locked, false);
});

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: b64u(crypto.createHash('sha256').update(verifier).digest()) };
};

function hiddenFields(html) {
  const fields = {};
  for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)) fields[match[1]] = match[2];
  return fields;
}

function clientRecord(name) {
  return {
    client_name: name,
    redirect_uris: ['https://app.test/cb'],
    token_endpoint_auth_method: 'none',
    oauth_lane: 'jc',
    scope: 'mcp',
  };
}

let nextPort = 24140;
async function boot(extraEnv = {}, clients = null, options = {}) {
  const acs = http.createServer((_req, res) => { res.writeHead(202); res.end('{}'); });
  const upstream = http.createServer((_req, res) => { res.writeHead(200); res.end('{}'); });
  const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  const [acsPort, upPort] = [await listen(acs), await listen(upstream)];
  const port = nextPort++;
  const dir = options.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), `consent-lockout-${port}-`));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'clients.json'), JSON.stringify(clients ?? {
    'jc-one': clientRecord('Trusted App'),
    'jc-two': clientRecord('Other App'),
  }));
  fs.writeFileSync(path.join(dir, 'tokens.json'), '{}');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: gatewayDir,
    env: {
      PATH: process.env.PATH,
      GATEWAY_PORT: String(port),
      PUBLIC_ORIGIN: ORIGIN,
      CONSENT_PASSPHRASE: PASS,
      SIGNING_KEY: KEY,
      JC_INGRESS_IDENTITY_KEY: IDENTITY_KEY,
      DATA_DIR: dir,
      UPSTREAM: `http://127.0.0.1:${upPort}`,
      JC_ENABLED: '1',
      JC_UPSTREAM: `http://127.0.0.1:${upPort}`,
      ACS_GATEWAY_URL: `http://127.0.0.1:${acsPort}`,
      ACS_JC_GATEWAY_TOKEN: 'jc-bridge-token',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const close = async () => {
    child.kill('SIGKILL');
    acs.close();
    upstream.close();
    if (!options.keep) fs.rmSync(dir, { recursive: true, force: true });
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', resolve);
    });
  };
  let up = false;
  for (let i = 0; i < 60 && !up; i += 1) {
    if (child.exitCode !== null) break;
    try { up = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch { await delay(100); }
  }
  if (!up) {
    const logged = output;
    await close();
    assert.fail(`gateway failed to start: ${logged}`);
  }
  return { base: `http://127.0.0.1:${port}`, dir, output: () => output, close };
}

async function withGateway(fn, options = {}) {
  const gw = await boot(options.env, options.clients, options);
  try { await fn(gw); } finally { await gw.close(); }
}

function authorizeUrl(base, params) {
  return `${base}/authorize?${new URLSearchParams(params).toString()}`;
}

const jcAuthorize = (clientId, challenge) => ({
  oauth_lane: 'jc',
  resource: JC_RESOURCE,
  client_id: clientId,
  redirect_uri: 'https://app.test/cb',
  response_type: 'code',
  scope: 'mcp',
  state: 's1',
  code_challenge: challenge,
  code_challenge_method: 'S256',
});

async function authorize(gw, clientId) {
  const response = await fetch(authorizeUrl(gw.base, jcAuthorize(clientId, pkce().challenge)), { redirect: 'manual' });
  const html = await response.text();
  assert.equal(response.status, 200, html.slice(0, 200));
  const fields = hiddenFields(html);
  assert.equal(typeof fields.consent_txn, 'string');
  return fields;
}

function consent(gw, fields, headers = {}) {
  return fetch(`${gw.base}/authorize/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

function assertNoSecrets(gw, extras = []) {
  const output = gw.output();
  for (const secret of [PASS, WRONG_PASS, 'passphrase=', ...extras]) {
    assert.equal(output.includes(secret), false, `log contained ${secret}`);
  }
}

async function register(gw, name) {
  const response = await fetch(`${gw.base}/register?oauth_lane=jc&resource=${encodeURIComponent(JC_RESOURCE)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: ['https://app.test/cb'],
      grant_types: ['authorization_code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.client_id;
}

test('a weak consent passphrase refuses startup and is not logged', async () => {
  const weak = 'weak-zz';
  const port = nextPort++;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `consent-weak-${port}-`));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: gatewayDir,
    env: {
      PATH: process.env.PATH,
      GATEWAY_PORT: String(port),
      PUBLIC_ORIGIN: ORIGIN,
      CONSENT_PASSPHRASE: weak,
      SIGNING_KEY: KEY,
      DATA_DIR: dir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const code = await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(4000).then(() => 'timeout'),
  ]);
  if (code === 'timeout') child.kill('SIGKILL');
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(code, 1);
  assert.match(output, /at least 16 characters/);
  assert.equal(output.includes(weak), false);
});

test('repeated failures lock the source, including a later correct passphrase', () =>
  withGateway(async (gw) => {
    const fields = await authorize(gw, 'jc-one');
    for (let i = 0; i < CONSENT_SOURCE_MAX_FAILURES; i += 1) {
      const denied = await consent(gw, { ...fields, passphrase: WRONG_PASS });
      assert.equal(denied.status, 401);
    }
    const locked = await consent(gw, { ...fields, passphrase: PASS });
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get('retry-after')) >= 1);
    assertNoSecrets(gw, [fields.consent_txn]);
    assert.match(gw.output(), /auth: consent refused reason=passphrase_invalid client=jc-one source=peer:[0-9a-f]{12} /);
    assert.match(gw.output(), /auth: consent refused reason=locked client=jc-one /);
  }));

test('concurrent wrong guesses cannot exceed the attempt budget', () =>
  withGateway(async (gw) => {
    const fields = await authorize(gw, 'jc-one');
    const extra = 7;
    const responses = await Promise.all(Array.from({ length: CONSENT_SOURCE_MAX_FAILURES + extra }, () =>
      consent(gw, { ...fields, passphrase: WRONG_PASS })));
    const statuses = responses.map((response) => response.status);
    assert.ok(statuses.every((status) => status === 401 || status === 429), statuses.join(','));
    assert.equal(statuses.filter((status) => status === 401).length, CONSENT_SOURCE_MAX_FAILURES);
    assert.equal(statuses.filter((status) => status === 429).length, extra);
    const correct = await consent(gw, { ...fields, passphrase: PASS });
    assert.equal(correct.status, 429);
    assertNoSecrets(gw, [fields.consent_txn]);
  }));

test('a lock expires and further locked guesses do not extend it', () =>
  withGateway(async (gw) => {
    const started = Date.now();
    const fields = await authorize(gw, 'jc-one');
    for (let i = 0; i < CONSENT_SOURCE_MAX_FAILURES; i += 1) {
      assert.equal((await consent(gw, { ...fields, passphrase: WRONG_PASS })).status, 401);
    }
    const locked = await consent(gw, { ...fields, passphrase: PASS });
    assert.equal(locked.status, 429);
    let opened = locked;
    while (opened.status !== 302 && Date.now() - started < 8_000) {
      await delay(100);
      opened = await consent(gw, { ...fields, passphrase: PASS });
    }
    assert.equal(opened.status, 302);
    assert.ok(Date.now() - started >= 1_500, 'the correct passphrase was accepted before the lock expired');
    assertNoSecrets(gw, [fields.consent_txn]);
  }, { env: { EDGE_TEST_MODE: '1', EDGE_TEST_CONSENT_LOCKOUT_MS: '2000' } }));

test('a zero or production-ignored lockout override stays locked', async () => {
  for (const env of [
    { EDGE_TEST_MODE: '1', EDGE_TEST_CONSENT_LOCKOUT_MS: '0' },
    { EDGE_TEST_CONSENT_LOCKOUT_MS: '50' },
  ]) {
    await withGateway(async (gw) => {
      const fields = await authorize(gw, 'jc-one');
      for (let i = 0; i < CONSENT_SOURCE_MAX_FAILURES; i += 1) {
        assert.equal((await consent(gw, { ...fields, passphrase: WRONG_PASS })).status, 401);
      }
      assert.equal((await consent(gw, { ...fields, passphrase: PASS })).status, 429);
      await delay(400);
      const still = await consent(gw, { ...fields, passphrase: PASS });
      assert.equal(still.status, 429);
      assertNoSecrets(gw, [fields.consent_txn]);
    }, { env });
  }
});

test('unknown transactions are counted, do not check the passphrase, and cannot target a posted client', () =>
  withGateway(async (gw) => {
    for (let i = 0; i < CONSENT_SOURCE_MAX_FAILURES; i += 1) {
      const response = await consent(gw, {
        consent_txn: `missing-${i}`,
        client_id: 'jc-one',
        resource: JC_RESOURCE,
        passphrase: WRONG_PASS,
      });
      assert.equal(response.status, 400);
    }
    const lockedUnknown = await consent(gw, {
      consent_txn: 'missing-locked',
      client_id: 'jc-one',
      resource: JC_RESOURCE,
      passphrase: PASS,
    });
    assert.equal(lockedUnknown.status, 429);
    const fields = await authorize(gw, 'jc-one');
    const lockedReal = await consent(gw, { ...fields, passphrase: PASS });
    assert.equal(lockedReal.status, 429);
    assert.match(gw.output(), /reason=unknown_txn client=- /);
    assert.doesNotMatch(gw.output(), /reason=unknown_txn client=jc-one/);
    assertNoSecrets(gw, [fields.consent_txn]);
  }));

test('unknown transactions posted against another client do not lock that client', () =>
  withGateway(async (gw) => {
    for (let i = 0; i < CONSENT_CLIENT_MAX_FAILURES; i += 1) {
      const response = await consent(gw, {
        consent_txn: `missing-${i}`,
        client_id: 'jc-one',
        resource: JC_RESOURCE,
        passphrase: WRONG_PASS,
      }, stampIngressIdentity(`192.0.2.${i + 1}`, IDENTITY_KEY));
      assert.equal(response.status, 400);
    }
    const fields = await authorize(gw, 'jc-one');
    const ok = await consent(gw, { ...fields, passphrase: PASS }, stampIngressIdentity('192.0.2.20', IDENTITY_KEY));
    assert.equal(ok.status, 302);
    assert.match(gw.output(), /reason=unknown_txn client=- /);
    assert.doesNotMatch(gw.output(), /reason=unknown_txn client=jc-one/);
    assertNoSecrets(gw, [fields.consent_txn, '192.0.2.1']);
  }));

test('a new client registration and forwarded headers do not reset a source lock', () =>
  withGateway(async (gw) => {
    for (let i = 0; i < CONSENT_SOURCE_MAX_FAILURES; i += 1) {
      const clientId = await register(gw, `registered-${i}`);
      const fields = await authorize(gw, clientId);
      const denied = await consent(gw, { ...fields, passphrase: WRONG_PASS });
      assert.equal(denied.status, 401);
    }
    const blockedId = await register(gw, 'registered-blocked');
    const blockedFields = await authorize(gw, blockedId);
    const blocked = await consent(gw, { ...blockedFields, passphrase: PASS }, {
      'x-forwarded-for': '203.0.113.77',
      'x-real-ip': '203.0.113.78',
      forwarded: 'for=203.0.113.79',
    });
    assert.equal(blocked.status, 429);
    const freshId = await register(gw, 'registered-fresh-source');
    const freshFields = await authorize(gw, freshId);
    const fresh = await consent(gw, { ...freshFields, passphrase: PASS }, stampIngressIdentity('203.0.113.40', IDENTITY_KEY));
    assert.equal(fresh.status, 302);
    assertNoSecrets(gw, [blockedFields.consent_txn, freshFields.consent_txn, '203.0.113.77']);
  }));

test('distinct ingress peers still share the per-client budget', () =>
  withGateway(async (gw) => {
    let fields = null;
    for (let i = 0; i < CONSENT_CLIENT_MAX_FAILURES; i += 1) {
      fields = await authorize(gw, 'jc-one');
      const denied = await consent(gw, { ...fields, passphrase: WRONG_PASS }, stampIngressIdentity(`198.51.100.${i + 1}`, IDENTITY_KEY));
      assert.equal(denied.status, 401);
    }
    const locked = await consent(gw, { ...fields, passphrase: PASS }, stampIngressIdentity('198.51.100.20', IDENTITY_KEY));
    assert.equal(locked.status, 429);
    const otherFields = await authorize(gw, 'jc-two');
    const other = await consent(gw, { ...otherFields, passphrase: PASS }, stampIngressIdentity('198.51.100.21', IDENTITY_KEY));
    assert.equal(other.status, 302);
    assertNoSecrets(gw, [fields.consent_txn, otherFields.consent_txn, '198.51.100.1']);
  }));

test('rotating the ingress identity does not defeat the global ceiling', () => {
  const clients = {};
  for (let i = 0; i < CONSENT_GLOBAL_MAX_FAILURES + 1; i += 1) clients[`jc-${i}`] = clientRecord(`Client ${i}`);
  return withGateway(async (gw) => {
    for (let i = 0; i < CONSENT_GLOBAL_MAX_FAILURES; i += 1) {
      const fields = await authorize(gw, `jc-${i}`);
      const denied = await consent(gw, { ...fields, passphrase: WRONG_PASS }, stampIngressIdentity(`203.0.113.${i + 1}`, IDENTITY_KEY));
      assert.equal(denied.status, 401, `global attempt ${i}`);
    }
    const fields = await authorize(gw, `jc-${CONSENT_GLOBAL_MAX_FAILURES}`);
    const locked = await consent(gw, { ...fields, passphrase: PASS }, stampIngressIdentity('203.0.113.250', IDENTITY_KEY));
    assert.equal(locked.status, 429);
    assertNoSecrets(gw, [fields.consent_txn, '203.0.113.1']);
  }, { clients });
});

test('a spoofed ingress header is rejected and does not spend the claimed address', () =>
  withGateway(async (gw) => {
    const fields = await authorize(gw, 'jc-one');
    const spoof = await consent(gw, { ...fields, passphrase: WRONG_PASS }, {
      [INGRESS_CLIENT_HEADER]: '203.0.113.77',
      'x-forwarded-for': '198.51.100.77',
      'x-real-ip': '192.0.2.77',
      forwarded: 'for=192.0.2.78',
    });
    assert.equal(spoof.status, 400);
    assert.match(gw.output(), /reason=spoofed_identity /);
    assert.equal(gw.output().includes('203.0.113.77'), false);
    const claimed = await consent(gw, { ...fields, passphrase: PASS }, stampIngressIdentity('203.0.113.77', IDENTITY_KEY));
    assert.equal(claimed.status, 302);
    assertNoSecrets(gw, [fields.consent_txn, IDENTITY_KEY]);
  }));

test('lockout state survives a gateway restart, including a correct passphrase', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consent-restart-'));
  const env = { EDGE_TEST_MODE: '1', EDGE_TEST_CONSENT_LOCKOUT_MS: '4000' };
  const first = await boot(env, null, { dir, keep: true });
  try {
    const fields = await authorize(first, 'jc-one');
    for (let i = 0; i < CONSENT_SOURCE_MAX_FAILURES; i += 1) {
      assert.equal((await consent(first, { ...fields, passphrase: WRONG_PASS })).status, 401);
    }
    assert.equal((await consent(first, { ...fields, passphrase: PASS })).status, 429);
  } finally {
    await first.close();
  }
  const second = await boot(env, null, { dir, keep: true });
  try {
    const fields = await authorize(second, 'jc-one');
    const locked = await consent(second, { ...fields, passphrase: PASS });
    assert.equal(locked.status, 429);
    let opened = locked;
    const started = Date.now();
    while (opened.status !== 302 && Date.now() - started < 8_000) {
      await delay(100);
      opened = await consent(second, { ...fields, passphrase: PASS });
    }
    assert.equal(opened.status, 302);
    assertNoSecrets(second, [fields.consent_txn]);
  } finally {
    await second.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('two gateway processes share one global failure ceiling', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consent-shared-'));
  const clients = {};
  for (let i = 0; i < CONSENT_GLOBAL_MAX_FAILURES + 1; i += 1) clients[`jc-${i}`] = clientRecord(`Client ${i}`);
  const left = await boot({}, clients, { dir, keep: true });
  const right = await boot({}, clients, { dir, keep: true });
  try {
    for (let i = 0; i < CONSENT_GLOBAL_MAX_FAILURES; i += 1) {
      const gw = i % 2 === 0 ? left : right;
      const fields = await authorize(gw, `jc-${i}`);
      const denied = await consent(gw, { ...fields, passphrase: WRONG_PASS }, stampIngressIdentity(`203.0.113.${i + 1}`, IDENTITY_KEY));
      assert.equal(denied.status, 401, `shared attempt ${i}`);
    }
    const fields = await authorize(right, `jc-${CONSENT_GLOBAL_MAX_FAILURES}`);
    const locked = await consent(left, { ...fields, passphrase: PASS }, stampIngressIdentity('203.0.113.250', IDENTITY_KEY));
    assert.equal(locked.status, 429);
  } finally {
    await left.close();
    await right.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt lockout file fails closed and is left in place', () =>
  withGateway(async (gw) => {
    const file = path.join(gw.dir, 'consent-lockout.json');
    const fields = await authorize(gw, 'jc-one');
    assert.equal((await consent(gw, { ...fields, passphrase: WRONG_PASS })).status, 401);
    fs.writeFileSync(file, '{');
    const down = await consent(gw, { ...fields, passphrase: PASS });
    assert.equal(down.status, 503);
    assert.equal(down.headers.get('retry-after'), '60');
    assert.equal(fs.readFileSync(file, 'utf8'), '{');
    assert.match(gw.output(), /reason=store_unavailable /);
    assert.equal(gw.output().includes(PASS), false);
  }));

test('new identities cannot grow the table or escape a full one after tracked entries expire', () => {
  let clock = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consent-cap-'));
  const filePath = path.join(dir, 'consent-lockout.json');
  const key = (ip) => consentSourceKey({ kind: 'ingress', id: ip });
  const open = () => createConsentLimiter({
    filePath, now: () => clock, cap: 2, sourceMax: 5, clientMax: 5, globalMax: 500, lockoutMs: 10_000,
  });
  open().recordFailure({ sourceKey: key('203.0.113.1') });
  open().recordFailure({ sourceKey: key('203.0.113.2') });
  clock = 9_000;
  const fresh = key('203.0.113.3');
  for (let i = 0; i < 5; i += 1) open().recordFailure({ sourceKey: fresh });
  assert.equal(open().snapshot({ sourceKey: fresh }).overflowLocked, true);
  clock = 10_000;
  const expired = open().snapshot({ sourceKey: fresh });
  assert.equal(expired.locked, true);
  assert.equal(expired.overflowLocked, true);
  const newer = key('203.0.113.4');
  open().recordFailure({ sourceKey: newer });
  const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(stored.sources[fresh], undefined);
  assert.equal(stored.sources[newer], undefined);
  assert.ok(Object.keys(stored.sources).length <= 2);
  const lockedUntil = stored.sourceOverflow.lockedUntilMs;
  clock = 11_000;
  open().recordFailure({ sourceKey: newer });
  const held = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(held.sourceOverflow.lockedUntilMs, lockedUntil);
  assert.equal(held.sources[newer], undefined);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('concurrent processes do not lose failure increments', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consent-race-'));
  const filePath = path.join(dir, 'consent-lockout.json');
  const sourceKey = consentSourceKey({ kind: 'peer', id: '198.51.100.8' });
  const guard = path.join(gatewayDir, 'consent-guard.js');
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { createConsentLimiter } from ${JSON.stringify(guard)};
      const limiter = createConsentLimiter({
        filePath: process.argv[1],
        sourceMax: 50,
        clientMax: 50,
        globalMax: 50,
        lockoutMs: 60000,
        cap: 8,
        lockTimeoutMs: 5000,
      });
      for (let i = 0; i < 8; i += 1) limiter.recordFailure({ sourceKey: process.argv[2] });
    `, filePath, sourceKey], { stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child ${code}`))));
  });
  await Promise.all([run(), run()]);
  const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(stored.sources[sourceKey].failures, 16);
  assert.equal(stored.global.failures, 16);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a forged proof, a rebound proof, and a non-loopback replay are rejected; the socket peer stays the fallback', () => {
  const stamped = stampIngressIdentity('203.0.113.10', IDENTITY_KEY);
  const forged = { ...stamped, [INGRESS_PROOF_HEADER]: 'ab'.repeat(32) };
  const forgedDecision = consentSource('127.0.0.1', forged, { identityKey: IDENTITY_KEY });
  assert.equal(forgedDecision.ok, false);
  assert.equal(forgedDecision.reason, 'spoofed_identity');
  assert.equal(forgedDecision.peer, '127.0.0.1');
  const rebound = {
    [INGRESS_CLIENT_HEADER]: '203.0.113.11',
    [INGRESS_PROOF_HEADER]: stamped[INGRESS_PROOF_HEADER],
  };
  assert.equal(consentSource('127.0.0.1', rebound, { identityKey: IDENTITY_KEY }).ok, false);
  assert.equal(consentSource('203.0.113.10', stamped, { identityKey: IDENTITY_KEY }).ok, false);
  assert.deepEqual(consentSource('192.0.2.10', {}, { identityKey: IDENTITY_KEY }), {
    ok: true,
    source: { kind: 'peer', id: '192.0.2.10' },
  });
  assert.equal(consentSource('192.0.2.10', { 'x-forwarded-for': '203.0.113.77' }, { identityKey: IDENTITY_KEY }).ok, false);
});

test('the lockout file is private, and restoring it after a corrupt copy keeps the lock', () =>
  withGateway(async (gw) => {
    const file = path.join(gw.dir, 'consent-lockout.json');
    const fields = await authorize(gw, 'jc-one');
    assert.equal((await consent(gw, { ...fields, passphrase: WRONG_PASS })).status, 401);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
    for (let i = 1; i < CONSENT_SOURCE_MAX_FAILURES; i += 1) {
      assert.equal((await consent(gw, { ...fields, passphrase: WRONG_PASS })).status, 401);
    }
    const lockedBytes = fs.readFileSync(file);
    assert.equal((await consent(gw, { ...fields, passphrase: PASS })).status, 429);
    fs.writeFileSync(file, '{');
    const down = await consent(gw, { ...fields, passphrase: PASS });
    assert.equal(down.status, 503);
    assert.equal(fs.readFileSync(file, 'utf8'), '{');
    fs.writeFileSync(file, lockedBytes, { mode: 0o600 });
    assert.equal((await consent(gw, { ...fields, passphrase: PASS })).status, 429);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }));

test('an unreadable lockout file is an unavailable store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consent-link-'));
  const filePath = path.join(dir, 'consent-lockout.json');
  const real = path.join(dir, 'real.json');
  fs.writeFileSync(real, '{}');
  fs.symlinkSync(real, filePath);
  const limiter = createConsentLimiter({ filePath, lockoutMs: 1000 });
  assert.throws(() => limiter.snapshot({ sourceKey: consentSourceKey({ kind: 'peer', id: '127.0.0.1' }) }), ConsentStoreUnavailable);
  assert.equal(fs.readFileSync(real, 'utf8'), '{}');
  fs.rmSync(dir, { recursive: true, force: true });
});
