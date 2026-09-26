#!/usr/bin/env node
/**
 * CLI device login against a fake ACS that verifies the Ed25519 device-code
 * proof exactly as ACS apps/gateway/src/device-auth-store.ts does.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acsAccessToken, credentialsPath, deviceLogin, loadCredentials } from '../dist/jace-commander/device-login.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-login-'));
const ACS = 'http://127.0.0.1:3999';
let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`  ✓ ${name}`); };

function fakeAcs({ pendingPolls = 2, finalError } = {}) {
  let publicKeyPem;
  let polls = 0;
  const calls = [];
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    if (url === `${ACS}/oauth/device/code`) {
      assert.equal(body.client_id, 'acs-cli');
      publicKeyPem = body.device_public_key;
      return json(200, { device_code: 'dev-code-1', user_code: 'ABCD-EFGH', verification_uri: `${ACS}/device/verify`, verification_uri_complete: `${ACS}/device/verify?user_code=ABCD-EFGH`, expires_in: 600, interval: 1 });
    }
    if (url === `${ACS}/oauth/token` && body.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
      const valid = crypto.verify(null, Buffer.from(`acs-device-code-proof-v1\n${body.device_code}`), crypto.createPublicKey(publicKeyPem), Buffer.from(body.device_signature, 'base64url'));
      if (!valid) return json(400, { error: 'invalid_grant' });
      polls += 1;
      if (polls <= pendingPolls) return json(400, { error: polls === 1 ? 'slow_down' : 'authorization_pending' });
      if (finalError) return json(400, { error: finalError });
      return json(200, { access_token: 'at-1', token_type: 'Bearer', expires_in: 900, refresh_token: 'rt-1', scope: 'acs:device', device_id: 'dev-1', principal: 'jace' });
    }
    if (url === `${ACS}/oauth/token` && body.grant_type === 'refresh_token') {
      assert.equal(body.refresh_token, 'rt-1');
      return json(200, { access_token: 'at-2', expires_in: 900, refresh_token: 'rt-2', scope: 'acs:device' });
    }
    return json(404, { error: 'not_found' });
  };
  return { fetchImpl, calls };
}

const sleeps = [];
const sleep = async (ms) => { sleeps.push(ms); };

await test('device flow: prompt, slow_down backoff, pending, success with valid PoP; credentials stored 0600', async () => {
  const acs = fakeAcs();
  let prompt;
  const creds = await deviceLogin({ acsUrl: ACS, stateDir: tmp, fetchImpl: acs.fetchImpl, sleep, onPrompt: (p) => { prompt = p; } });
  assert.equal(prompt.userCode, 'ABCD-EFGH');
  assert.equal(creds.accessToken, 'at-1');
  assert.equal(creds.principal, 'jace');
  assert.deepEqual(sleeps, [1000, 6000, 6000], 'slow_down adds 5s to the interval');
  assert.equal(fs.statSync(credentialsPath(tmp)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(tmp, 'device-key.pem')).mode & 0o777, 0o600);
});

await test('denied authorization surfaces the ACS error and stores nothing new', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-login-deny-'));
  const acs = fakeAcs({ pendingPolls: 0, finalError: 'access_denied' });
  await assert.rejects(deviceLogin({ acsUrl: ACS, stateDir: dir, fetchImpl: acs.fetchImpl, sleep }), /access_denied/);
  assert.equal(loadCredentials(dir), undefined);
});

await test('token selection: env wins; foreign ACS origin never gets our token; refresh near expiry', async () => {
  assert.equal(await acsAccessToken(ACS, tmp, { JC_ACS_TOKEN: 'env-token' }), 'env-token');
  assert.equal(await acsAccessToken('http://127.0.0.1:4000', tmp, {}), undefined);
  assert.equal(await acsAccessToken(ACS, tmp, {}), 'at-1');
  const acs = fakeAcs();
  const later = () => Date.now() + 899_000;
  assert.equal(await acsAccessToken(ACS, tmp, {}, acs.fetchImpl, later), 'at-2');
  assert.equal(loadCredentials(tmp).refreshToken, 'rt-2');
});

console.log(`\njace-commander device login: ${passed} passed`);
