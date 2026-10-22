#!/usr/bin/env node
/**
 * Edge authentication-health classification (RFC 6750 / RFC 9728 challenges, refresh-token outcomes).
 *
 * Proves:
 *  - a request with NO credential gets a bare discovery challenge (no `error`), so clients start a fresh sign-in
 *  - an expired / wrong-audience / wrong-issuer token gets `error="invalid_token"` so clients refresh or reconnect
 *  - the client id is reported only when the token's signature verified (an unverifiable token is never attributed)
 *  - refresh outcomes are classified, and rotation stays STRICT by default. There is no retry or cached-response path.
 *
 * Run: node --test test/auth-health.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DUPLICATE_REFRESH_WINDOW_S, REPORTABLE_REFRESH_FAILURES, bearerChallenge, classifyBearer, resolveRefresh } from '../auth-health.js';

const KEY = 'k'.repeat(32);
const ISSUER = 'https://gw.test';
const RESOURCE = 'https://gw.test/jc/mcp';
const NOW = 1_800_000_000;
const b64u = (buf) => Buffer.from(buf).toString('base64url');

function sign(payload, key = KEY) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify(payload));
  return `${h}.${p}.${crypto.createHmac('sha256', key).update(`${h}.${p}`).digest('base64url')}`;
}
const claims = (over = {}) => ({ iss: ISSUER, sub: 'jacen', aud: RESOURCE, client_id: 'client-chatgpt', scope: 'mcp', iat: NOW - 100, exp: NOW + 3500, ...over });
const classify = (header) => classifyBearer(header, { signingKey: KEY, issuer: ISSUER, resource: RESOURCE, nowSec: NOW });
const bearer = (token) => `Bearer ${token}`;

test('a valid token is accepted and carries the verified identity', () => {
  const result = classify(bearer(sign(claims())));
  assert.equal(result.ok, true);
  assert.equal(result.payload.client_id, 'client-chatgpt');
});

test('a missing credential is "missing": no client, no error code in the challenge', () => {
  for (const header of [undefined, '', 'Basic abc', 'Bearer']) {
    const result = classify(header);
    assert.deepEqual([result.ok, result.reason, result.clientId], [false, 'missing', undefined]);
  }
  const base = 'Bearer resource_metadata="https://gw.test/.well-known/oauth-protected-resource/jc/mcp", scope="mcp"';
  assert.equal(bearerChallenge(base, 'missing'), base);
});

test('an expired token is "expired" and still attributed to the client (signature verified)', () => {
  const result = classify(bearer(sign(claims({ exp: NOW - 5 }))));
  assert.deepEqual([result.ok, result.reason, result.clientId, result.subject], [false, 'expired', 'client-chatgpt', 'jacen']);
});

test('wrong audience and wrong issuer are attributed but distinct from expiry', () => {
  assert.equal(classify(bearer(sign(claims({ aud: 'https://gw.test/mcp' })))).reason, 'wrong_audience');
  assert.equal(classify(bearer(sign(claims({ iss: 'https://evil.test' })))).reason, 'wrong_issuer');
  assert.equal(classify(bearer(sign(claims({ aud: 'https://gw.test/mcp' })))).clientId, 'client-chatgpt');
});

test('a forged or malformed token is never attributed to any client', () => {
  const forged = classify(bearer(sign(claims({ client_id: 'victim' }), 'x'.repeat(32))));
  assert.deepEqual([forged.ok, forged.reason, forged.clientId], [false, 'bad_signature', undefined]);
  const garbage = classify(bearer('not-a-jwt'));
  assert.deepEqual([garbage.ok, garbage.reason, garbage.clientId], [false, 'malformed', undefined]);
});

test('every presented-but-unusable token gets error="invalid_token" while keeping discovery metadata', () => {
  const base = 'Bearer resource_metadata="https://gw.test/.well-known/oauth-protected-resource/jc/mcp", scope="mcp"';
  for (const reason of ['expired', 'wrong_audience', 'wrong_issuer', 'bad_signature', 'malformed']) {
    const challenge = bearerChallenge(base, reason);
    assert.ok(challenge.startsWith(base), reason);
    assert.match(challenge, /error="invalid_token"/, reason);
    assert.doesNotMatch(challenge, /sk-|eyJ/, 'challenge must never echo token material');
  }
  assert.match(bearerChallenge(base, 'expired'), /error_description="[^"]*expired/i);
});

const rec = (over = {}) => ({ client_id: 'client-chatgpt', exp: NOW + 1000, active: true, ...over });
const SECRET = crypto.randomBytes(16).toString('hex');

test('refresh: an active refresh token resolves', () => {
  assert.deepEqual(resolveRefresh({ r1: rec() }, 'r1', NOW), { ok: true, record: rec() });
});

test('refresh: unknown, expired and revoked tokens are permanent failures with a reason and client', () => {
  assert.deepEqual(resolveRefresh({}, 'nope', NOW), { ok: false, reason: 'refresh_unknown' });
  assert.deepEqual(resolveRefresh({ r1: rec({ exp: NOW - 1 }) }, 'r1', NOW), { ok: false, reason: 'refresh_expired', clientId: 'client-chatgpt' });
  assert.deepEqual(resolveRefresh({ r1: rec({ active: false, revoked: true }) }, 'r1', NOW), { ok: false, reason: 'revoked', clientId: 'client-chatgpt' });
});

test('refresh: a confidential client must authenticate; a stolen refresh token alone is not enough', () => {
  const wrong = resolveRefresh({ r1: rec() }, 'r1', NOW, { clientSecret: SECRET, presentedSecret: 'nope' });
  assert.deepEqual(wrong, { ok: false, reason: 'invalid_client', clientId: 'client-chatgpt' });
  assert.equal(resolveRefresh({ r1: rec() }, 'r1', NOW, { clientSecret: SECRET }).reason, 'invalid_client');
  assert.equal(resolveRefresh({ r1: rec() }, 'r1', NOW, { clientSecret: SECRET, presentedSecret: SECRET }).ok, true);
});

// --- Rotation is strict. There is no retry or cached-response path (it was removed). ---

test('strict rotation: reuse of a rotated token is refused, even for the authenticated owner', () => {
  const rotated = rec({ active: false, rotatedAt: NOW - 60, successor: 'next' });
  const records = { r1: rotated, next: rec({ active: true }) };
  const opts = { clientSecret: SECRET, presentedSecret: SECRET };
  assert.deepEqual(resolveRefresh(records, 'r1', NOW, opts), { ok: false, reason: 'refresh_reused', clientId: 'client-chatgpt' });
  // Legacy options and stale cached-response fields have no effect.
  const legacy = { r1: rec({ active: false, rotatedAt: NOW - 60, replay: { response: { access_token: 'A2', refresh_token: 'R2' } } }) };
  const result = resolveRefresh(legacy, 'r1', NOW, { ...opts, idempotentRetry: true });
  assert.deepEqual(result, { ok: false, reason: 'refresh_reused', clientId: 'client-chatgpt' });
  assert.equal(result.response, undefined);
});

test('refresh: a duplicate arriving within seconds of the rotation is refused but is not a lost authorization', () => {
  const records = { r1: rec({ active: false, rotatedAt: NOW - 2, successor: 'next' }), next: rec({ active: true }) };
  assert.deepEqual(resolveRefresh(records, 'r1', NOW), { ok: false, reason: 'refresh_superseded', clientId: 'client-chatgpt' });
  records.r1.rotatedAt = NOW - DUPLICATE_REFRESH_WINDOW_S - 1;
  assert.equal(resolveRefresh(records, 'r1', NOW).reason, 'refresh_reused');
});

test('refresh: a rotated token is never resurrected when expired or revoked', () => {
  assert.equal(resolveRefresh({ r1: rec({ active: false, exp: NOW - 1 }) }, 'r1', NOW).reason, 'refresh_expired');
  assert.equal(resolveRefresh({ r1: rec({ active: false, revoked: true }) }, 'r1', NOW).reason, 'revoked');
});

test('refresh: bound to its client, and own properties only', () => {
  assert.deepEqual(resolveRefresh({ r1: rec() }, 'r1', NOW, { presentedClientId: 'someone-else' }), { ok: false, reason: 'client_mismatch' });
  assert.equal(resolveRefresh({ r1: rec() }, 'r1', NOW, { presentedClientId: 'client-chatgpt' }).ok, true);
  for (const key of ['__proto__', 'constructor', 'toString']) assert.deepEqual(resolveRefresh({}, key, NOW), { ok: false, reason: 'refresh_unknown' });
});

test('refresh: reuse of a token whose successor is already in use is a stale duplicate, not a lost authorization', () => {
  const records = { old: rec({ active: false, rotatedAt: NOW - 100, successor: 'next' }), next: rec({ active: false }) };
  assert.deepEqual(resolveRefresh(records, 'old', NOW), { ok: false, reason: 'refresh_superseded', clientId: 'client-chatgpt' });
  // Successor still unused: ambiguous (duplicate request vs lost response), so it stays a reuse.
  const ambiguous = { old: records.old, next: rec({ active: true }) };
  assert.equal(resolveRefresh(ambiguous, 'old', NOW).reason, 'refresh_reused');
});

test('only failures that mean the client\'s own authorization is gone are reportable (a stranger must not be able to flag it)', () => {
  assert.deepEqual([...REPORTABLE_REFRESH_FAILURES].sort(), ['refresh_expired', 'refresh_reused', 'revoked']);
  for (const reason of ['invalid_client', 'client_mismatch', 'refresh_superseded', 'refresh_unknown']) assert.equal(REPORTABLE_REFRESH_FAILURES.has(reason), false, reason);
});

test('an expired token minted for the other lane is a lane error, not an expiry on this lane', () => {
  const token = sign(claims({ aud: 'https://gw.test/mcp', exp: NOW - 5 }));
  const result = classify(bearer(token));
  assert.equal(result.reason, 'wrong_audience');
  assert.equal(classifyBearer(bearer(sign(claims({ iss: 'https://other.test', exp: NOW - 5 }))), { signingKey: KEY, issuer: ISSUER, resource: RESOURCE, nowSec: NOW }).reason, 'wrong_issuer');
});

test('refresh: a confidential client proves itself BEFORE the record\'s state is revealed or reportable', () => {
  const secret = 'client-secret-for-order-test';
  for (const state of [{ revoked: true }, { exp: NOW - 1 }, { active: false }]) {
    const result = resolveRefresh({ r1: rec(state) }, 'r1', NOW, { clientSecret: secret, presentedSecret: 'wrong' });
    assert.deepEqual(result, { ok: false, reason: 'invalid_client', clientId: 'client-chatgpt' }, JSON.stringify(state));
  }
  assert.equal(resolveRefresh({ r1: rec({ revoked: true }) }, 'r1', NOW, { clientSecret: secret, presentedSecret: secret }).reason, 'revoked');
});
