#!/usr/bin/env node
import assert from 'node:assert/strict';
import { redactSecrets } from '../dist/secret-redaction.js';

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};

await test('redactSecrets masks JWTs, Authorization/DPoP headers, PEM keys, and known secrets', () => {
  const jwt = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl';
  const pem = '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEINsecretkeybytes\n-----END PRIVATE KEY-----';
  const raw = [
    `Authorization: DPoP ${jwt}`,
    `DPoP: ${jwt}`,
    `refresh_token=rt_secret_12345&code_verifier=cv_secret_987`,
    `{"access_token":"at_1","refresh_token":"rt_2","refresh_proof":"rp_3"}`,
    pem,
    'explicit=my-runtime-secret',
  ].join('\n');

  const redacted = redactSecrets(raw, ['my-runtime-secret']);
  assert.equal(redacted.includes(jwt), false);
  assert.equal(redacted.includes('rt_secret_12345'), false);
  assert.equal(redacted.includes('cv_secret_987'), false);
  assert.equal(redacted.includes('at_1'), false);
  assert.equal(redacted.includes('rt_2'), false);
  assert.equal(redacted.includes('rp_3'), false);
  assert.equal(redacted.includes('MC4CAQAwBQYDK2VwBCIEINsecretkeybytes'), false);
  assert.equal(redacted.includes('my-runtime-secret'), false);
});

console.log(`\njace-commander secret-redaction: ${passed} passed`);
