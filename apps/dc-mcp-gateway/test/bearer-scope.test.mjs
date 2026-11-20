#!/usr/bin/env node
/**
 * Resource-side scope enforcement for bearer tokens (auth-health.js classifyBearer).
 *
 * The consent flow lets a client ask for `openid email profile` without `mcp`. Such a token was accepted on /mcp, because
 * the resource checked only signature, issuer, audience and expiry. The advertised scope is `mcp`, so a token without it
 * must not authorize the MCP resource.
 *
 * Run: node --test test/bearer-scope.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { classifyBearer, bearerChallenge } from '../auth-health.js';

const KEY = 'test-signing-key-not-a-secret';
const ISS = 'https://gw.example.test';
const RES = 'https://gw.example.test/mcp';

function token(claims) {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = crypto.createHmac('sha256', KEY).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

const base = { iss: ISS, aud: RES, exp: 4102444800, client_id: 'c1', sub: 's1' };
const check = (claims) =>
  classifyBearer(`Bearer ${token({ ...base, ...claims })}`, { signingKey: KEY, issuer: ISS, resource: RES, nowSec: 1 });

test('a token that carries the mcp scope is accepted', () => {
  assert.equal(check({ scope: 'mcp' }).ok, true);
});

test('a token scoped to the mcp scope alongside identity scopes is accepted', () => {
  assert.equal(check({ scope: 'openid mcp' }).ok, true);
});

test('a token without the mcp scope does not authorize the MCP resource', () => {
  const result = check({ scope: 'openid email profile' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'insufficient_scope');
});

test('a token with no scope claim does not authorize the MCP resource', () => {
  const result = check({});
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'insufficient_scope');
});

test('an identity-only token keeps its client identity for attribution, but grants no access', () => {
  const result = check({ scope: 'openid' });
  assert.equal(result.ok, false);
  assert.equal(result.clientId, 'c1');
});

test('the insufficient_scope challenge names the error, not an unrelated reason', () => {
  const challenge = bearerChallenge('Bearer realm="x"', 'insufficient_scope');
  assert.match(challenge, /error="insufficient_scope"/);
});
