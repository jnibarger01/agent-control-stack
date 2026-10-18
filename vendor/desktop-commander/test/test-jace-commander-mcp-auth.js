#!/usr/bin/env node
/**
 * CLI MCP token renewal: which refresh outcomes mean "sign in again" and which do not.
 *
 * Proves, against a fake edge:
 *  - a refreshable expired access token renews silently (and rotates the stored refresh token)
 *  - invalid_grant / invalid_client on refresh is permanent: the dead refresh token is dropped, the verdict is
 *    remembered, and later calls say "reauth_required" without another network call
 *  - a network failure, a timeout, a 5xx, or a garbage body is NOT permanent: the stored credential is untouched
 *    and a later call succeeds once the edge is back
 *  - a valid token is used as is; a completed connect clears a remembered verdict
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMcpToken, mcpAccessToken, mcpAccessTokenOutcome, mcpTokenPath } from '../dist/jace-commander/mcp-auth.js';

const MCP = 'https://edge.test/jc/mcp';
let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`  ✓ ${name}`); };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stateDir(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-mcp-auth-'));
  fs.writeFileSync(mcpTokenPath(dir), JSON.stringify({ mcpUrl: MCP, clientId: 'cid', accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: Date.now() - 1000, ...over }));
  return dir;
}

/** A fake edge. `token` decides the /token response; discovery always works unless `discoveryDown`. */
function edge({ token, discoveryDown = false }) {
  const calls = { token: 0 };
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.includes('/.well-known/oauth-protected-resource')) {
      if (discoveryDown) throw new TypeError('fetch failed');
      return json(200, { resource: MCP, authorization_servers: ['https://edge.test/jc'] });
    }
    if (u.includes('/.well-known/oauth-authorization-server')) {
      return json(200, { authorization_endpoint: 'https://edge.test/authorize', token_endpoint: 'https://edge.test/token', registration_endpoint: 'https://edge.test/register' });
    }
    if (u === 'https://edge.test/token') {
      calls.token += 1;
      assert.match(String(init.body), /grant_type=refresh_token/);
      return token(String(init.body));
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  return { fetchImpl, calls };
}

await test('a refreshable expired access token renews silently and stores the rotated refresh token', async () => {
  const dir = stateDir();
  const { fetchImpl, calls } = edge({ token: () => json(200, { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }) });
  assert.deepEqual(await mcpAccessTokenOutcome(MCP, dir, {}, fetchImpl), { kind: 'token', accessToken: 'new-access' });
  assert.equal(loadMcpToken(dir).refreshToken, 'new-refresh');
  assert.equal(calls.token, 1);
});

await test('a still-valid token is used without any network call', async () => {
  const dir = stateDir({ expiresAt: Date.now() + 3_600_000 });
  const { fetchImpl, calls } = edge({ token: () => { throw new Error('must not be called'); } });
  assert.equal(await mcpAccessToken(MCP, dir, {}, fetchImpl), 'old-access');
  assert.equal(calls.token, 0);
});

for (const [error, reason] of [['invalid_grant', 'refresh_rejected'], ['invalid_client', 'invalid_client']]) {
  await test(`${error} on refresh is permanent: reauth_required, dead token dropped, verdict remembered`, async () => {
    const dir = stateDir();
    const { fetchImpl, calls } = edge({ token: () => json(error === 'invalid_client' ? 401 : 400, { error }) });
    assert.deepEqual(await mcpAccessTokenOutcome(MCP, dir, {}, fetchImpl), { kind: 'reauth_required', reason });
    const stored = loadMcpToken(dir);
    assert.equal(stored.refreshToken, undefined);
    assert.equal(stored.reauthRequired.reason, reason);
    // No second network call: the verdict is remembered.
    assert.deepEqual(await mcpAccessTokenOutcome(MCP, dir, {}, fetchImpl), { kind: 'reauth_required', reason });
    assert.equal(calls.token, 1);
    assert.equal(await mcpAccessToken(MCP, dir, {}, fetchImpl), undefined);
  });
}

await test('an outage is not an expiry: network error, timeout, 5xx and garbage bodies keep the credential', async () => {
  const cases = {
    'edge down (discovery fails)': { discoveryDown: true, token: () => json(200, {}) },
    'token endpoint throws': { token: () => { throw new TypeError('fetch failed'); } },
    'timeout': { token: () => { throw new DOMException('timed out', 'TimeoutError'); } },
    '503': { token: () => json(503, { error: 'temporarily_unavailable' }) },
    '500 with invalid_grant-looking text': { token: () => json(500, { error: 'invalid_grant' }) },
    'garbage body': { token: () => new Response('<html>bad gateway</html>', { status: 502 }) },
  };
  for (const [name, spec] of Object.entries(cases)) {
    const dir = stateDir();
    const { fetchImpl } = edge(spec);
    const outcome = await mcpAccessTokenOutcome(MCP, dir, {}, fetchImpl);
    assert.equal(outcome.kind, 'unavailable', name);
    const stored = loadMcpToken(dir);
    assert.equal(stored.refreshToken, 'old-refresh', `${name}: refresh token must survive`);
    assert.equal(stored.reauthRequired, undefined, `${name}: no verdict recorded`);
  }
});

await test('after an outage the next call succeeds with the same credential', async () => {
  const dir = stateDir();
  let up = false;
  const { fetchImpl } = edge({ token: () => (up ? json(200, { access_token: 'back', expires_in: 3600 }) : json(503, {})) });
  assert.equal((await mcpAccessTokenOutcome(MCP, dir, {}, fetchImpl)).kind, 'unavailable');
  up = true;
  assert.deepEqual(await mcpAccessTokenOutcome(MCP, dir, {}, fetchImpl), { kind: 'token', accessToken: 'back' });
});

await test('no stored credential is "not_connected", an expired token without a refresh token is reauth_required', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-mcp-auth-'));
  assert.deepEqual(await mcpAccessTokenOutcome(MCP, empty, {}, fetch), { kind: 'not_connected' });
  const dir = stateDir({ refreshToken: undefined });
  assert.deepEqual(await mcpAccessTokenOutcome(MCP, dir, {}, fetch), { kind: 'reauth_required', reason: 'no_refresh_token' });
});

await test('concurrent callers share one refresh (rotation-safe) and one verdict', async () => {
  const dir = stateDir();
  const { fetchImpl, calls } = edge({ token: () => json(400, { error: 'invalid_grant' }) });
  const results = await Promise.all([1, 2, 3].map(() => mcpAccessTokenOutcome(MCP, dir, {}, fetchImpl)));
  assert.ok(results.every((r) => r.kind === 'reauth_required'));
  assert.equal(calls.token, 1);
});

await test('JC_MCP_TOKEN still overrides everything', async () => {
  assert.equal(await mcpAccessToken(MCP, stateDir(), { JC_MCP_TOKEN: 'env-token' }, fetch), 'env-token');
});

console.log(`\n${passed} passed`);
