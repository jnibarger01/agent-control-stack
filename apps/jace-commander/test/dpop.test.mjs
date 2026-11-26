#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  computeJwkThumbprint,
  createDpopProof,
  extractDpopNonceChallenge,
  generateDpopKeyPair,
  hashAccessTokenAth,
  normalizeHtu,
} from '../dist/dpop.js';

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};

function decodeSegment(seg) {
  return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
}

await test('generateDpopKeyPair exports Ed25519 OKP public JWK with zero private fields and valid RFC 7638 jkt', () => {
  const kp = generateDpopKeyPair();
  assert.equal(kp.publicJwk.kty, 'OKP');
  assert.equal(kp.publicJwk.crv, 'Ed25519');
  assert.equal(typeof kp.publicJwk.x, 'string');
  assert.equal('d' in kp.publicJwk, false);
  const expected = crypto
    .createHash('sha256')
    .update(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x: kp.publicJwk.x }), 'utf8')
    .digest('base64url');
  assert.equal(kp.jkt, expected);
  assert.equal(computeJwkThumbprint(kp.publicJwk), expected);
});

await test('normalizeHtu strips query and fragment while preserving origin and pathname', () => {
  assert.equal(normalizeHtu('https://edge.example:8443/jc/mcp?foo=1#bar'), 'https://edge.example:8443/jc/mcp');
  assert.equal(normalizeHtu('http://127.0.0.1:8010/jc/oauth/token'), 'http://127.0.0.1:8010/jc/oauth/token');
});

await test('createDpopProof produces verifiable RFC 9449 EdDSA compact JWS with jti>=128b, htm, htu, ath, nonce', () => {
  const kp = generateDpopKeyPair();
  const accessToken = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.sig';
  const proof1 = createDpopProof({
    privateKey: kp.privateKey,
    publicJwk: kp.publicJwk,
    htm: 'post',
    htu: 'https://edge.example/jc/mcp?ignore=1#frag',
    accessToken,
    nonce: 'srv-nonce-1',
    nowMs: 1_700_000_000_000,
  });
  const proof2 = createDpopProof({
    privateKey: kp.privateKey,
    publicJwk: kp.publicJwk,
    htm: 'post',
    htu: 'https://edge.example/jc/mcp',
    accessToken,
    nonce: 'srv-nonce-1',
    nowMs: 1_700_000_000_000,
  });

  const parts = proof1.split('.');
  assert.equal(parts.length, 3);
  const [h, p, s] = parts;
  const header = decodeSegment(h);
  const payload = decodeSegment(p);

  assert.equal(header.typ, 'dpop+jwt');
  assert.equal(header.alg, 'EdDSA');
  assert.deepEqual(header.jwk, kp.publicJwk);
  assert.equal('d' in header.jwk, false);

  assert.equal(payload.htm, 'POST');
  assert.equal(payload.htu, 'https://edge.example/jc/mcp');
  assert.equal(payload.iat, 1_700_000_000);
  assert.equal(payload.nonce, 'srv-nonce-1');
  assert.equal(payload.ath, hashAccessTokenAth(accessToken));
  assert.ok(Buffer.from(payload.jti, 'base64url').length >= 16);

  const payload2 = decodeSegment(proof2.split('.')[1]);
  assert.notEqual(payload.jti, payload2.jti, 'each DPoP proof must have a fresh jti');

  const pubKey = crypto.createPublicKey({ key: header.jwk, format: 'jwk' });
  const verified = crypto.verify(null, Buffer.from(`${h}.${p}`, 'ascii'), pubKey, Buffer.from(s, 'base64url'));
  assert.equal(verified, true);
});

await test('createDpopProof omits ath and nonce when not supplied (token endpoint)', () => {
  const kp = generateDpopKeyPair();
  const proof = createDpopProof({
    privateKey: kp.privateKey,
    publicJwk: kp.publicJwk,
    htm: 'POST',
    htu: 'https://edge.example/jc/oauth/token',
    nowMs: 1_700_000_123_000,
  });
  const payload = decodeSegment(proof.split('.')[1]);
  assert.equal('ath' in payload, false);
  assert.equal('nonce' in payload, false);
});

await test('extractDpopNonceChallenge detects 401 WWW-Authenticate use_dpop_nonce and 400 token challenge', () => {
  const res401 = new Response('', {
    status: 401,
    headers: {
      'DPoP-Nonce': 'n-401',
      'WWW-Authenticate': 'DPoP error="use_dpop_nonce", algs="EdDSA ES256"',
    },
  });
  assert.deepEqual(extractDpopNonceChallenge(res401), { useDpopNonce: true, nonce: 'n-401' });

  const res401NoErr = new Response('', { status: 401, headers: { 'WWW-Authenticate': 'DPoP error="invalid_token"' } });
  assert.deepEqual(extractDpopNonceChallenge(res401NoErr), { useDpopNonce: false, nonce: undefined });

  const res400 = new Response(JSON.stringify({ error: 'use_dpop_nonce' }), {
    status: 400,
    headers: { 'DPoP-Nonce': 'n-400', 'content-type': 'application/json' },
  });
  assert.deepEqual(extractDpopNonceChallenge(res400, { error: 'use_dpop_nonce' }), { useDpopNonce: true, nonce: 'n-400' });
});

console.log(`\njace-commander dpop: ${passed} passed`);
