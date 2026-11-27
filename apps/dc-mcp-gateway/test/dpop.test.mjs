import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  computeJwkThumbprint,
  createNonceManager,
  verifyDpopProof,
} from '../dpop.js';
import { createGatewayStore } from '../store.js';

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function genEd25519() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  return { publicKey, privateKey, jwk };
}

function genEs256() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  return { publicKey, privateKey, jwk };
}

function signProof({
  alg = 'EdDSA',
  typ = 'dpop+jwt',
  jwk,
  privateKey,
  htm = 'POST',
  htu = 'https://gw.test/token',
  jti = crypto.randomBytes(16).toString('base64url'),
  iat = Math.floor(Date.now() / 1000),
  nonce,
  ath,
  extraHeader = {},
  extraPayload = {},
}) {
  const header = { alg, ...(typ !== undefined ? { typ } : {}), ...(jwk !== undefined ? { jwk } : {}), ...extraHeader };
  const payload = {
    ...(htm !== undefined ? { htm } : {}),
    ...(htu !== undefined ? { htu } : {}),
    ...(jti !== undefined ? { jti } : {}),
    ...(iat !== undefined ? { iat } : {}),
    ...(nonce !== undefined ? { nonce } : {}),
    ...(ath !== undefined ? { ath } : {}),
    ...extraPayload,
  };
  const h = b64u(JSON.stringify(header));
  const p = b64u(JSON.stringify(payload));
  const input = Buffer.from(`${h}.${p}`, 'ascii');
  let sig;
  if (alg === 'EdDSA') {
    sig = crypto.sign(null, input, privateKey);
  } else if (alg === 'ES256') {
    sig = crypto.sign('sha256', input, { key: privateKey, dsaEncoding: 'ieee-p1363' });
  } else {
    sig = Buffer.from('sig');
  }
  return `${h}.${p}.${b64u(sig)}`;
}

function makeTempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpop-store-'));
  const dbPath = path.join(dir, 'gateway.db');
  const store = createGatewayStore(dbPath);
  t.after(() => {
    try {
      store.close();
    } catch {
      /* ignore */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, dbPath, store };
}

test('RFC 7638 thumbprint + EdDSA and ES256 DPoP proofs verify and persist jti across reopen', (t) => {
  const { dbPath, store } = makeTempStore(t);
  const nonces = createNonceManager({ signingKey: 'test-signing-key-32-bytes-minimum!' });
  const nowSec = Math.floor(Date.now() / 1000);
  const nonce = nonces.issue(nowSec);

  const ed = genEd25519();
  const edJkt = computeJwkThumbprint(ed.jwk);
  assert.match(edJkt, /^[A-Za-z0-9_-]{43}$/);

  const accessToken = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJqYWNlbiJ9.sig';
  const ath = b64u(crypto.createHash('sha256').update(accessToken, 'ascii').digest());
  const jti1 = crypto.randomBytes(16).toString('base64url');
  const proof1 = signProof({
    alg: 'EdDSA',
    jwk: ed.jwk,
    privateKey: ed.privateKey,
    htm: 'POST',
    htu: 'https://gw.test/jc/mcp',
    jti: jti1,
    iat: nowSec,
    nonce,
    ath,
  });

  const res1 = verifyDpopProof(proof1, {
    htm: 'POST',
    htu: 'https://gw.test/jc/mcp',
    accessToken,
    nowSec,
    nonceManager: nonces,
    nonceRequired: true,
    consumeJti: (jti, jkt, exp) => store.consumeJti(jti, jkt, exp, nowSec),
  });
  assert.equal(res1.ok, true, res1.reason);
  assert.equal(res1.jkt, edJkt);

  // Replay immediately rejected
  const replay = verifyDpopProof(proof1, {
    htm: 'POST',
    htu: 'https://gw.test/jc/mcp',
    accessToken,
    nowSec,
    nonceManager: nonces,
    nonceRequired: true,
    consumeJti: (jti, jkt, exp) => store.consumeJti(jti, jkt, exp, nowSec),
  });
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, 'replayed_jti');

  // Reopen SQLite DB (simulates gateway restart) -> still rejected
  store.close();
  const reopened = createGatewayStore(dbPath);
  t.after(() => reopened.close());
  const replayAfterRestart = verifyDpopProof(proof1, {
    htm: 'POST',
    htu: 'https://gw.test/jc/mcp',
    accessToken,
    nowSec,
    nonceManager: nonces,
    nonceRequired: true,
    consumeJti: (jti, jkt, exp) => reopened.consumeJti(jti, jkt, exp, nowSec),
  });
  assert.equal(replayAfterRestart.ok, false);
  assert.equal(replayAfterRestart.reason, 'replayed_jti');

  // ES256 proof also verifies
  const ec = genEs256();
  const ecProof = signProof({
    alg: 'ES256',
    jwk: ec.jwk,
    privateKey: ec.privateKey,
    htm: 'POST',
    htu: 'https://gw.test/token',
    iat: nowSec,
    nonce,
  });
  const resEc = verifyDpopProof(ecProof, {
    htm: 'POST',
    htu: 'https://gw.test/token',
    nowSec,
    nonceManager: nonces,
    nonceRequired: true,
    consumeJti: (jti, jkt, exp) => reopened.consumeJti(jti, jkt, exp, nowSec),
  });
  assert.equal(resEc.ok, true, resEc.reason);
  assert.equal(resEc.jkt, computeJwkThumbprint(ec.jwk));
});

test('DPoP verification rejects private JWK material, bad alg, bad typ, bad htm/htu/ath/iat/nonce', (t) => {
  const { store } = makeTempStore(t);
  const nonces = createNonceManager({ signingKey: 'test-signing-key-32-bytes-minimum!' });
  const nowSec = Math.floor(Date.now() / 1000);
  const nonce = nonces.issue(nowSec);
  const ed = genEd25519();
  const privJwk = ed.privateKey.export({ format: 'jwk' });
  const accessToken = 'tok-123';
  const ath = b64u(crypto.createHash('sha256').update(accessToken, 'ascii').digest());

  const check = (proof, opts = {}) => verifyDpopProof(proof, {
    htm: 'POST',
    htu: 'https://gw.test/jc/mcp',
    accessToken,
    nowSec,
    nonceManager: nonces,
    nonceRequired: true,
    consumeJti: (jti, jkt, exp) => store.consumeJti(jti, jkt, exp, nowSec),
    ...opts,
  });

  // Private key embedded in header jwk
  assert.equal(check(signProof({ jwk: privJwk, privateKey: ed.privateKey, htu: 'https://gw.test/jc/mcp', ath, nonce })).ok, false);
  // Unsupported alg / typ
  assert.equal(check(signProof({ alg: 'none', jwk: ed.jwk, privateKey: ed.privateKey, htu: 'https://gw.test/jc/mcp', ath, nonce })).ok, false);
  assert.equal(check(signProof({ typ: 'JWT', jwk: ed.jwk, privateKey: ed.privateKey, htu: 'https://gw.test/jc/mcp', ath, nonce })).ok, false);
  // Tampered signature
  const good = signProof({ jwk: ed.jwk, privateKey: ed.privateKey, htu: 'https://gw.test/jc/mcp', ath, nonce });
  const [h, p, s] = good.split('.');
  const badSig = `${h}.${p}.${s.slice(0, -2)}${s.endsWith('AA') ? 'BB' : 'AA'}`;
  assert.equal(check(badSig).ok, false);
  // Wrong htm / htu / query in htu / fragment in htu
  assert.equal(check(signProof({ jwk: ed.jwk, privateKey: ed.privateKey, htm: 'GET', htu: 'https://gw.test/jc/mcp', ath, nonce })).ok, false);
  assert.equal(check(signProof({ jwk: ed.jwk, privateKey: ed.privateKey, htu: 'https://evil.test/jc/mcp', ath, nonce })).ok, false);
  assert.equal(check(signProof({ jwk: ed.jwk, privateKey: ed.privateKey, htu: 'https://gw.test/jc/mcp?x=1', ath, nonce })).ok, false);
  assert.equal(check(signProof({ jwk: ed.jwk, privateKey: ed.privateKey, htu: 'https://gw.test/jc/mcp#frag', ath, nonce })).ok, false);
  // Missing or wrong ath
  assert.equal(check(signProof({ jwk: ed.jwk, privateKey: ed.privateKey, htu: 'https://gw.test/jc/mcp', nonce })).ok, false);
  assert.equal(check(signProof({ jwk: ed.jwk, privateKey: ed.privateKey, htu: 'https://gw.test/jc/mcp', ath: 'wrong', nonce })).ok, false);
  // Expired / future iat
  assert.equal(check(signProof({ jwk: ed.jwk, privateKey: ed.privateKey, htu: 'https://gw.test/jc/mcp', ath, nonce, iat: nowSec - 65 })).ok, false);
  assert.equal(check(signProof({ jwk: ed.jwk, privateKey: ed.privateKey, htu: 'https://gw.test/jc/mcp', ath, nonce, iat: nowSec + 65 })).ok, false);
  // Missing or invalid nonce -> use_dpop_nonce with freshNonce
  const missingNonce = check(signProof({ jwk: ed.jwk, privateKey: ed.privateKey, htu: 'https://gw.test/jc/mcp', ath }));
  assert.equal(missingNonce.ok, false);
  assert.equal(missingNonce.reason, 'use_dpop_nonce');
  assert.ok(missingNonce.freshNonce);

  // Even when nonceRequired: false, an invalid nonce is rejected
  const badOptionalNonce = check(signProof({ jwk: ed.jwk, privateKey: ed.privateKey, htu: 'https://gw.test/jc/mcp', ath, nonce: 'bogus.nonce' }), { nonceRequired: false });
  assert.equal(badOptionalNonce.ok, false);
  assert.equal(badOptionalNonce.reason, 'use_dpop_nonce');
});
