#!/usr/bin/env node
/**
 * CLI ACS device login against a fake ACS verifying:
 *  - Ed25519 device-code proof + DPoP header
 *  - ADR-0030 refresh_proof + proof_issued_at + DPoP header on refresh
 *  - SecretStore persistence (no plaintext device-key.pem or plaintext tokens in credentials.json)
 *  - acsAuthHeaders sending Authorization: DPoP + DPoP proof (or Bearer when JC_ACS_TOKEN is set)
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acsAccessToken, acsAuthHeaders, credentialsPath, deviceLogin, loadCredentials } from '../dist/device-login.js';
import { computeJwkThumbprint, hashAccessTokenAth } from '../dist/dpop.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-login-'));
const ACS = 'http://127.0.0.1:3999';
const headlessEnv = { JC_HEADLESS_KEYSTORE: '1', JC_SECRET_BACKEND: 'encrypted' };
let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`  ✓ ${name}`); };

function parseDpop(token) {
  const [h, p, s] = String(token ?? '').split('.');
  assert.ok(h && p && s, 'valid compact JWS');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  assert.equal(header.typ, 'dpop+jwt');
  assert.equal(header.alg, 'EdDSA');
  const pub = crypto.createPublicKey({ key: header.jwk, format: 'jwk' });
  assert.equal(crypto.verify(null, Buffer.from(`${h}.${p}`), pub, Buffer.from(s, 'base64url')), true);
  return { header, payload, jkt: computeJwkThumbprint(header.jwk) };
}

function fakeAcs({ pendingPolls = 2, finalError } = {}) {
  let publicKeyPem;
  let polls = 0;
  const calls = [];
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const headers = init.headers ?? {};
    calls.push({ url, body, headers });
    if (url === `${ACS}/oauth/device/code`) {
      assert.equal(body.client_id, 'acs-cli');
      publicKeyPem = body.device_public_key;
      return json(200, { device_code: 'dev-code-1', user_code: 'ABCD-EFGH', verification_uri: `${ACS}/device/verify`, verification_uri_complete: `${ACS}/device/verify?user_code=ABCD-EFGH`, expires_in: 600, interval: 1 });
    }
    if (url === `${ACS}/oauth/token` && body.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
      const valid = crypto.verify(null, Buffer.from(`acs-device-code-proof-v1\n${body.device_code}`), crypto.createPublicKey(publicKeyPem), Buffer.from(body.device_signature, 'base64url'));
      if (!valid) return json(400, { error: 'invalid_grant' });
      parseDpop(headers.DPoP ?? headers.dpop);
      polls += 1;
      if (polls <= pendingPolls) return json(400, { error: polls === 1 ? 'slow_down' : 'authorization_pending' });
      if (finalError) return json(400, { error: finalError });
      return json(200, { access_token: 'at-1', token_type: 'DPoP', expires_in: 900, refresh_token: 'rt-1', scope: 'acs:device', device_id: 'dev-1', principal: 'jace' });
    }
    if (url === `${ACS}/oauth/token` && body.grant_type === 'refresh_token') {
      assert.equal(body.refresh_token, 'rt-1');
      assert.equal(body.device_id, 'dev-1');
      assert.equal(typeof body.proof_issued_at, 'number');
      assert.equal(typeof body.refresh_proof, 'string');
      parseDpop(headers.DPoP ?? headers.dpop);
      return json(200, { access_token: 'at-2', token_type: 'DPoP', expires_in: 900, refresh_token: 'rt-2', scope: 'acs:device' });
    }
    return json(404, { error: 'not_found' });
  };
  return { fetchImpl, calls };
}

const sleeps = [];
const sleep = async (ms) => { sleeps.push(ms); };

await test('device flow: prompt, slow_down backoff, pending, success with valid PoP + DPoP; no plaintext secrets on disk', async () => {
  const acs = fakeAcs();
  let prompt;
  const creds = await deviceLogin({ acsUrl: ACS, stateDir: tmp, env: headlessEnv, fetchImpl: acs.fetchImpl, sleep, onPrompt: (p) => { prompt = p; } });
  assert.equal(prompt.userCode, 'ABCD-EFGH');
  assert.equal(creds.accessToken, 'at-1');
  assert.equal(creds.principal, 'jace');
  assert.equal(creds.tokenType, 'DPoP');
  assert.deepEqual(sleeps, [1000, 6000, 6000], 'slow_down adds 5s to the interval');
  assert.equal(fs.statSync(credentialsPath(tmp)).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(tmp, 'device-key.pem')), false, 'device-key.pem must not be left in plaintext');
  const rawMeta = fs.readFileSync(credentialsPath(tmp), 'utf8');
  assert.doesNotMatch(rawMeta, /at-1|rt-1|BEGIN PRIVATE KEY/);
});

await test('denied authorization surfaces the ACS error and stores nothing new', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-login-deny-'));
  const acs = fakeAcs({ pendingPolls: 0, finalError: 'access_denied' });
  await assert.rejects(deviceLogin({ acsUrl: ACS, stateDir: dir, env: headlessEnv, fetchImpl: acs.fetchImpl, sleep }), /access_denied/);
  assert.equal(loadCredentials(dir), undefined);
});

await test('token selection: env wins; foreign ACS origin never gets our token; refresh near expiry sends ADR-0030 refresh_proof', async () => {
  assert.equal(await acsAccessToken(ACS, tmp, { ...headlessEnv, JC_ACS_TOKEN: 'env-token' }), 'env-token');
  assert.equal(await acsAccessToken('http://127.0.0.1:4000', tmp, headlessEnv), undefined);
  assert.equal(await acsAccessToken(ACS, tmp, headlessEnv), 'at-1');
  const acs = fakeAcs();
  const later = () => Date.now() + 899_000;
  assert.equal(await acsAccessToken(ACS, tmp, headlessEnv, acs.fetchImpl, later), 'at-2');
  const dpopHeaders = await acsAuthHeaders({
    acsUrl: ACS,
    stateDir: tmp,
    method: 'POST',
    url: `${ACS}/work-items`,
    env: headlessEnv,
  });
  assert.equal(dpopHeaders.authorization, 'DPoP at-2');
  const parsed = parseDpop(dpopHeaders.DPoP);
  assert.equal(parsed.payload.htm, 'POST');
  assert.equal(parsed.payload.htu, `${ACS}/work-items`);
  assert.equal(parsed.payload.ath, hashAccessTokenAth('at-2'));

  const bearerHeaders = await acsAuthHeaders({
    acsUrl: ACS,
    stateDir: tmp,
    method: 'POST',
    url: `${ACS}/work-items`,
    env: { ...headlessEnv, JC_ACS_TOKEN: 'env-token' },
  });
  assert.deepEqual(bearerHeaders, { authorization: 'Bearer env-token' });
});

await test('token requests are time-bounded (abort signal attached)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-login-timeout-'));
  const acs = fakeAcs();
  const signals = [];
  const fetchImpl = async (url, init) => { signals.push(init.signal); return acs.fetchImpl(url, init); };
  await deviceLogin({ acsUrl: ACS, stateDir: dir, env: headlessEnv, fetchImpl, sleep: async () => {} });
  assert.ok(signals.length >= 2);
  assert.ok(signals.every((signal) => signal instanceof AbortSignal));
});

console.log(`\njace-commander device login: ${passed} passed`);
