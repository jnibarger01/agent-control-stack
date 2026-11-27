#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../dist/cli.js';
import { computeJwkThumbprint, hashAccessTokenAth } from '../dist/dpop.js';
import {
  connect,
  connectDevice,
  listJcDevices,
  loadMcpAuthStatus,
  mcpAuthProvider,
  revokeJcDevice,
} from '../dist/mcp-auth.js';
import { JC_EXIT, McpHttpClient } from '../dist/mcp-http-client.js';
import { acsAuthHeaders, deviceLogin, refreshAcsCredentials } from '../dist/device-login.js';
import { createSecretStore } from '../dist/secret-store.js';

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function verifyDpopHeader(dpopJwt, expectedHtm, expectedHtu, expectedAccessToken, expectedNonce) {
  assert.equal(typeof dpopJwt, 'string', 'DPoP header missing');
  const [h, p, s] = dpopJwt.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  assert.equal(header.typ, 'dpop+jwt');
  assert.equal(header.alg, 'EdDSA');
  assert.equal('d' in header.jwk, false);
  const pub = crypto.createPublicKey({ key: header.jwk, format: 'jwk' });
  assert.equal(crypto.verify(null, Buffer.from(`${h}.${p}`, 'ascii'), pub, Buffer.from(s, 'base64url')), true);
  assert.equal(payload.htm, expectedHtm);
  assert.equal(payload.htu, expectedHtu);
  if (expectedAccessToken !== undefined) {
    assert.equal(payload.ath, hashAccessTokenAth(expectedAccessToken));
  } else {
    assert.equal('ath' in payload, false);
  }
  if (expectedNonce !== undefined) {
    assert.equal(payload.nonce, expectedNonce);
  }
  return { jkt: computeJwkThumbprint(header.jwk), header, payload };
}

await test('browser OAuth 2.1 connect enforces PKCE S256, state, iss (RFC 9207), DPoP + nonce retry, and SecretStore', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-v2-browser-'));
  const MCP = 'https://edge.test/jc/mcp';
  const ISSUER = 'https://edge.test/jc';
  let tokenAttempt = 0;
  let capturedAuthParams;
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/.well-known/oauth-protected-resource/jc/mcp')) {
      return json(200, { resource: MCP, authorization_servers: [ISSUER] });
    }
    if (u === `${ISSUER}/.well-known/oauth-authorization-server`) {
      return json(200, {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth/authorize`,
        token_endpoint: `${ISSUER}/oauth/token`,
        device_authorization_endpoint: `${ISSUER}/oauth/device/code`,
        dpop_signing_alg_values_supported: ['EdDSA', 'ES256'],
      });
    }
    if (u === `${ISSUER}/oauth/token`) {
      tokenAttempt += 1;
      const dpop = init.headers?.dpop ?? init.headers?.DPoP;
      if (tokenAttempt === 1) {
        verifyDpopHeader(dpop, 'POST', `${ISSUER}/oauth/token`, undefined);
        return json(400, { error: 'use_dpop_nonce' }, { 'DPoP-Nonce': 'nonce-1' });
      }
      const { jkt } = verifyDpopHeader(dpop, 'POST', `${ISSUER}/oauth/token`, undefined, 'nonce-1');
      const params = new URLSearchParams(String(init.body));
      assert.equal(params.get('grant_type'), 'authorization_code');
      assert.equal(params.get('client_id'), 'jace-commander-cli');
      assert.equal(params.get('resource'), MCP);
      assert.equal(jkt, capturedAuthParams.get('dpop_jkt'));
      return json(200, {
        access_token: 'at-dpop-1',
        refresh_token: 'rt-dpop-1',
        token_type: 'DPoP',
        expires_in: 600,
        scope: 'mcp',
        device_id: 'dev-browser-1',
        sub: 'user@example.com',
      });
    }
    throw new Error(`unexpected fetch ${u}`);
  };

  // First verify wrong iss on loopback callback is rejected.
  await assert.rejects(
    () =>
      connect({
        mcpUrl: MCP,
        stateDir: dir,
        env: { JC_HEADLESS_KEYSTORE: '1', JC_SECRET_BACKEND: 'encrypted' },
        fetchImpl,
        onAuthorizeUrl: (authUrl) => {
          const parsed = new URL(authUrl);
          const cb = new URL(parsed.searchParams.get('redirect_uri'));
          cb.searchParams.set('code', 'c-bad-iss');
          cb.searchParams.set('state', parsed.searchParams.get('state'));
          cb.searchParams.set('iss', 'https://evil.example/jc');
          fetch(cb).catch(() => {});
        },
      }),
    /issuer mismatch|iss/i,
  );

  // Valid callback with matching iss + state.
  const stored = await connect({
    mcpUrl: MCP,
    stateDir: dir,
    env: { JC_HEADLESS_KEYSTORE: '1', JC_SECRET_BACKEND: 'encrypted' },
    fetchImpl,
    onAuthorizeUrl: (authUrl) => {
      const parsed = new URL(authUrl);
      capturedAuthParams = parsed.searchParams;
      assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
      assert.ok(parsed.searchParams.get('dpop_jkt'));
      const cb = new URL(parsed.searchParams.get('redirect_uri'));
      cb.searchParams.set('code', 'c-good');
      cb.searchParams.set('state', parsed.searchParams.get('state'));
      cb.searchParams.set('iss', ISSUER);
      fetch(cb).catch(() => {});
    },
  });

  assert.equal(stored.tokenType, 'DPoP');
  assert.equal(stored.deviceId, 'dev-browser-1');
  assert.equal(stored.sub, 'user@example.com');
  assert.equal(fs.existsSync(path.join(dir, 'mcp-token.json')), false, 'secrets must not be stored in plaintext mcp-token.json');

  const status = await loadMcpAuthStatus(MCP, dir, { JC_HEADLESS_KEYSTORE: '1', JC_SECRET_BACKEND: 'encrypted' });
  assert.equal(status.authMode, 'dpop');
  assert.equal(status.storageBackend, 'encrypted-file');
  assert.equal(status.deviceId, 'dev-browser-1');
});

await test('headless RFC 8628 device flow connectDevice registers dpop_jkt and stores DPoP session', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-v2-device-'));
  const MCP = 'https://edge.test/jc/mcp';
  const ISSUER = 'https://edge.test/jc';
  let polls = 0;
  let registeredJkt;
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/.well-known/oauth-protected-resource/jc/mcp')) {
      return json(200, { resource: MCP, authorization_servers: [ISSUER] });
    }
    if (u === `${ISSUER}/.well-known/oauth-authorization-server`) {
      return json(200, {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth/authorize`,
        token_endpoint: `${ISSUER}/oauth/token`,
        device_authorization_endpoint: `${ISSUER}/oauth/device/code`,
      });
    }
    if (u === `${ISSUER}/oauth/device/code`) {
      const body = new URLSearchParams(String(init.body));
      registeredJkt = body.get('dpop_jkt');
      assert.ok(registeredJkt);
      assert.equal(body.get('client_id'), 'jace-commander-cli');
      return json(200, {
        device_code: 'dc-1',
        user_code: 'WXYZ-1234',
        verification_uri: `${ISSUER}/device`,
        verification_uri_complete: `${ISSUER}/device?user_code=WXYZ-1234`,
        expires_in: 600,
        interval: 1,
      });
    }
    if (u === `${ISSUER}/oauth/token`) {
      const dpop = init.headers?.dpop ?? init.headers?.DPoP;
      const { jkt } = verifyDpopHeader(dpop, 'POST', `${ISSUER}/oauth/token`, undefined);
      assert.equal(jkt, registeredJkt);
      polls += 1;
      if (polls === 1) return json(400, { error: 'authorization_pending' });
      return json(200, {
        access_token: 'at-dev-1',
        refresh_token: 'rt-dev-1',
        token_type: 'DPoP',
        expires_in: 600,
        scope: 'mcp',
        device_id: 'dev-headless-1',
        sub: 'headless-user',
      });
    }
    throw new Error(`unexpected ${u}`);
  };

  let prompted;
  const stored = await connectDevice({
    mcpUrl: MCP,
    stateDir: dir,
    label: 'ci-runner',
    env: { JC_HEADLESS_KEYSTORE: '1', JC_SECRET_BACKEND: 'encrypted' },
    fetchImpl,
    sleep: async () => {},
    onPrompt: (p) => { prompted = p; },
  });
  assert.equal(prompted.userCode, 'WXYZ-1234');
  assert.equal(stored.deviceId, 'dev-headless-1');
  assert.equal(stored.tokenType, 'DPoP');
});

await test('McpHttpClient with DPoP AuthProvider handles use_dpop_nonce retry and refuses Bearer downgrade', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-v2-client-'));
  const MCP = 'https://edge.test/jc/mcp';
  const ISSUER = 'https://edge.test/jc';
  const env = { JC_HEADLESS_KEYSTORE: '1', JC_SECRET_BACKEND: 'encrypted' };

  await connectDevice({
    mcpUrl: MCP,
    stateDir: dir,
    env,
    sleep: async () => {},
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.endsWith('/.well-known/oauth-protected-resource/jc/mcp')) return json(200, { resource: MCP, authorization_servers: [ISSUER] });
      if (u === `${ISSUER}/.well-known/oauth-authorization-server`) return json(200, { issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, device_authorization_endpoint: `${ISSUER}/device/code` });
      if (u === `${ISSUER}/device/code`) return json(200, { device_code: 'dc', user_code: 'U', verification_uri: `${ISSUER}/device`, expires_in: 600, interval: 1 });
      if (u === `${ISSUER}/token`) return json(200, { access_token: 'at-client-1', refresh_token: 'rt-client-1', token_type: 'DPoP', expires_in: 600, device_id: 'd1', sub: 'u1' });
      throw new Error(`unexpected ${u}`);
    },
  });

  let callCount = 0;
  const mcpFetch = async (url, init) => {
    const body = JSON.parse(String(init.body));
    const authz = init.headers.authorization;
    const dpop = init.headers.dpop ?? init.headers.DPoP;
    assert.equal(authz, 'DPoP at-client-1', 'must send Authorization: DPoP, never Bearer');
    if (body.method === 'initialize') {
      const { payload } = verifyDpopHeader(dpop, 'POST', MCP, 'at-client-1');
      if (!payload.nonce) {
        return new Response('', {
          status: 401,
          headers: { 'DPoP-Nonce': 'mcp-nonce-1', 'WWW-Authenticate': 'DPoP error="use_dpop_nonce"' },
        });
      }
      assert.equal(payload.nonce, 'mcp-nonce-1');
      return json(200, { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'edge', version: '1' } } });
    }
    if (body.method === 'notifications/initialized') {
      return new Response('', { status: 202 });
    }
    if (body.method === 'tools/call') {
      callCount += 1;
      verifyDpopHeader(dpop, 'POST', MCP, 'at-client-1');
      return json(200, { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '{}' }], structuredContent: { ok: true } } });
    }
    return new Response('', { status: 200 });
  };

  const client = new McpHttpClient({
    url: MCP,
    auth: mcpAuthProvider(MCP, dir, env),
    fetchImpl: mcpFetch,
  });
  const outcome = await client.callTool('ping', {});
  assert.equal(outcome.kind, 'ok');
  assert.equal(callCount, 1);
});

await test('crash recovery replays pending-refresh refresh_request_id without triggering refresh_reused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-v2-crash-'));
  const MCP = 'https://edge.test/jc/mcp';
  const ISSUER = 'https://edge.test/jc';
  const env = { JC_HEADLESS_KEYSTORE: '1', JC_SECRET_BACKEND: 'encrypted' };

  // Seed a session via device flow.
  await connectDevice({
    mcpUrl: MCP,
    stateDir: dir,
    env,
    sleep: async () => {},
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.endsWith('/.well-known/oauth-protected-resource/jc/mcp')) return json(200, { resource: MCP, authorization_servers: [ISSUER] });
      if (u === `${ISSUER}/.well-known/oauth-authorization-server`) return json(200, { issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, device_authorization_endpoint: `${ISSUER}/device/code` });
      if (u === `${ISSUER}/device/code`) return json(200, { device_code: 'dc', user_code: 'U', verification_uri: `${ISSUER}/device`, expires_in: 600, interval: 1 });
      if (u === `${ISSUER}/token`) return json(200, { access_token: 'at-1', refresh_token: 'rt-1', token_type: 'DPoP', expires_in: 1, device_id: 'd1', sub: 'u1' });
      throw new Error(`unexpected ${u}`);
    },
  });

  // Force expiry + simulate crash after server saw req-1 but before client wrote rt-2.
  const seenRequests = [];
  const crashFetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/.well-known/oauth-protected-resource/jc/mcp')) return json(200, { resource: MCP, authorization_servers: [ISSUER] });
    if (u === `${ISSUER}/.well-known/oauth-authorization-server`) return json(200, { issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token` });
    if (u === `${ISSUER}/token`) {
      const body = new URLSearchParams(String(init.body));
      seenRequests.push(body.get('refresh_request_id'));
      // Server rotated rt-1 -> rt-2 on first call, but client crashes before saving!
      if (seenRequests.length === 1) {
        throw new Error('simulated crash before commit');
      }
      // On recovery call, server checks same refresh_request_id and returns same successor.
      assert.equal(seenRequests[1], seenRequests[0]);
      return json(200, { access_token: 'at-2', refresh_token: 'rt-2', token_type: 'DPoP', expires_in: 600, device_id: 'd1', sub: 'u1' });
    }
    throw new Error(`unexpected ${u}`);
  };

  const provider = mcpAuthProvider(MCP, dir, env, crashFetch, () => Date.now() + 120_000);
  const first = await provider.getAuthHeaders({ method: 'POST', url: MCP });
  assert.equal(first.ok, false);
  assert.equal(fs.existsSync(path.join(dir, 'pending-refresh.json')), true, 'pending-refresh must remain after pre-commit failure');

  const second = await provider.getAuthHeaders({ method: 'POST', url: MCP });
  assert.equal(second.ok, true);
  assert.equal(second.headers.authorization, 'DPoP at-2');
  assert.equal(fs.existsSync(path.join(dir, 'pending-refresh.json')), false, 'pending-refresh cleared after commit');
});

await test('jace auth CLI commands (status, devices, revoke, logout) work without leaking secrets', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-v2-cli-'));
  const MCP = 'https://edge.test/jc/mcp';
  const ISSUER = 'https://edge.test/jc';
  const env = { HOME: dir, JC_STATE_DIR: dir, JC_MCP_URL: MCP, JC_HEADLESS_KEYSTORE: '1', JC_SECRET_BACKEND: 'encrypted' };

  await connectDevice({
    mcpUrl: MCP,
    stateDir: dir,
    env,
    sleep: async () => {},
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.endsWith('/.well-known/oauth-protected-resource/jc/mcp')) return json(200, { resource: MCP, authorization_servers: [ISSUER] });
      if (u === `${ISSUER}/.well-known/oauth-authorization-server`) return json(200, { issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, device_authorization_endpoint: `${ISSUER}/device/code` });
      if (u === `${ISSUER}/device/code`) return json(200, { device_code: 'dc', user_code: 'U', verification_uri: `${ISSUER}/device`, expires_in: 600, interval: 1 });
      if (u === `${ISSUER}/token`) return json(200, { access_token: 'at-secret-xyz', refresh_token: 'rt-secret-xyz', token_type: 'DPoP', expires_in: 3600, device_id: 'dev-99', sub: 'alice' });
      throw new Error(`unexpected ${u}`);
    },
  });

  const out = [];
  const code = await main(['auth', 'status', '--json'], env, { stdout: (t) => out.push(t), stderr: () => {} });
  assert.equal(code, JC_EXIT.ok);
  assert.equal(out[0].includes('at-secret-xyz'), false);
  assert.equal(out[0].includes('rt-secret-xyz'), false);
  const parsed = JSON.parse(out[0]);
  assert.equal(parsed.sub, 'alice');
  assert.equal(parsed.device_id, 'dev-99');
  assert.equal(parsed.auth_mode, 'dpop');
  assert.equal(parsed.storage_backend, 'encrypted-file');

  // Test devices & revoke endpoints via exported helpers + CLI dispatch
  let revokedId;
  const devFetch = async (url, init) => {
    const dpop = init.headers?.dpop ?? init.headers?.DPoP;
    assert.equal(init.headers?.authorization, 'DPoP at-secret-xyz');
    if (String(url) === `${ISSUER}/devices`) {
      verifyDpopHeader(dpop, 'GET', `${ISSUER}/devices`, 'at-secret-xyz');
      return json(200, { devices: [{ device_id: 'dev-99', status: 'active' }] });
    }
    if (String(url) === `${ISSUER}/devices/dev-99/revoke`) {
      verifyDpopHeader(dpop, 'POST', `${ISSUER}/devices/dev-99/revoke`, 'at-secret-xyz');
      revokedId = 'dev-99';
      return json(200, { revoked: true, device_id: 'dev-99' });
    }
    throw new Error(`unexpected ${url}`);
  };
  const devices = await listJcDevices(MCP, dir, env, devFetch);
  assert.equal(devices.length, 1);
  const revoked = await revokeJcDevice(MCP, dir, 'dev-99', env, devFetch);
  assert.equal(revoked.revoked, true);
  assert.equal(revokedId, 'dev-99');

  const logoutOut = [];
  const logoutCode = await main(['auth', 'logout'], env, { stdout: (t) => logoutOut.push(t), stderr: () => {} });
  assert.equal(logoutCode, JC_EXIT.ok);
  assert.match(logoutOut[0], /local-only|remote devices remain active/i);
  assert.match(logoutOut[0], /auth revoke/i);

  const store = await createSecretStore({ stateDir: dir, env });
  assert.equal(await store.get(`jc-mcp:${MCP}:secrets`), undefined);
});

await test('ACS device-login v2 sends refresh_proof + DPoP on token refresh and DPoP headers on ACS requests', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-v2-acs-'));
  const ACS = 'http://127.0.0.1:3999';
  const env = { JC_HEADLESS_KEYSTORE: '1', JC_SECRET_BACKEND: 'encrypted' };
  let publicKeyPem;
  const acsFetch = async (url, init) => {
    const body = JSON.parse(String(init.body));
    if (url === `${ACS}/oauth/device/code`) {
      publicKeyPem = body.device_public_key;
      return json(200, { device_code: 'd-1', user_code: 'ABCD-1234', verification_uri: `${ACS}/verify`, expires_in: 600, interval: 1 });
    }
    if (url === `${ACS}/oauth/token` && body.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
      verifyDpopHeader(init.headers?.DPoP ?? init.headers?.dpop, 'POST', `${ACS}/oauth/token`, undefined);
      return json(200, { access_token: 'acs-at-1', refresh_token: 'acs-rt-1', token_type: 'DPoP', expires_in: 1, device_id: 'acs-dev-1', principal: 'jace', scope: 'acs:device' });
    }
    if (url === `${ACS}/oauth/token` && body.grant_type === 'refresh_token') {
      assert.equal(body.device_id, 'acs-dev-1');
      assert.ok(body.proof_issued_at);
      assert.ok(body.refresh_proof);
      verifyDpopHeader(init.headers?.DPoP ?? init.headers?.dpop, 'POST', `${ACS}/oauth/token`, undefined);
      const rtSha = crypto.createHash('sha256').update('acs-rt-1', 'utf8').digest('hex');
      const msg = [
        'acs-device-refresh-proof-v1',
        `client_id=${body.client_id}`,
        `device_id=${body.device_id}`,
        `refresh_token_sha256=${rtSha}`,
        'operation=refresh_token',
        `issued_at=${body.proof_issued_at}`,
      ].join('\n');
      assert.equal(crypto.verify(null, Buffer.from(msg, 'utf8'), crypto.createPublicKey(publicKeyPem), Buffer.from(body.refresh_proof, 'base64url')), true);
      return json(200, { access_token: 'acs-at-2', refresh_token: 'acs-rt-2', token_type: 'DPoP', expires_in: 900, device_id: 'acs-dev-1', principal: 'jace', scope: 'acs:device' });
    }
    return json(404, {});
  };

  await deviceLogin({ acsUrl: ACS, stateDir: dir, env, fetchImpl: acsFetch, sleep: async () => {} });
  const refreshed = await refreshAcsCredentials(ACS, dir, env, acsFetch, () => Date.now() + 120_000);
  assert.equal(refreshed.accessToken, 'acs-at-2');

  const hdrs = await acsAuthHeaders({ acsUrl: ACS, stateDir: dir, method: 'POST', url: `${ACS}/work-items`, env, fetchImpl: acsFetch });
  assert.equal(hdrs.authorization, 'DPoP acs-at-2');
  verifyDpopHeader(hdrs.DPoP, 'POST', `${ACS}/work-items`, 'acs-at-2');
});

await test('McpHttpClient tools/call 401 (non-nonce) does NOT replay; tools/list 401 refreshes and retries once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-v2-401-'));
  const MCP = 'https://edge.test/jc/mcp';
  const ISSUER = 'https://edge.test/jc';
  const env = { JC_HEADLESS_KEYSTORE: '1', JC_SECRET_BACKEND: 'encrypted' };

  let refreshCount = 0;
  const authFetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/.well-known/oauth-protected-resource/jc/mcp')) return json(200, { resource: MCP, authorization_servers: [ISSUER] });
    if (u === `${ISSUER}/.well-known/oauth-authorization-server`) return json(200, { issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, device_authorization_endpoint: `${ISSUER}/device/code` });
    if (u === `${ISSUER}/device/code`) return json(200, { device_code: 'dc', user_code: 'U', verification_uri: `${ISSUER}/device`, expires_in: 600, interval: 1 });
    if (u === `${ISSUER}/token`) {
      const body = new URLSearchParams(String(init.body));
      if (body.get('grant_type') === 'refresh_token') {
        refreshCount += 1;
        return json(200, { access_token: `at-refreshed-${refreshCount}`, refresh_token: `rt-${refreshCount + 1}`, token_type: 'DPoP', expires_in: 600, device_id: 'd1', sub: 'u1' });
      }
      return json(200, { access_token: 'at-initial', refresh_token: 'rt-1', token_type: 'DPoP', expires_in: 600, device_id: 'd1', sub: 'u1' });
    }
    throw new Error(`unexpected ${u}`);
  };

  await connectDevice({ mcpUrl: MCP, stateDir: dir, env, sleep: async () => {}, fetchImpl: authFetch });

  let listCalls = 0;
  let toolCalls = 0;
  const mcpFetch = async (_url, init) => {
    const body = JSON.parse(String(init.body));
    const authz = init.headers.authorization;
    if (body.method === 'initialize') {
      return json(200, { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'edge', version: '1' } } });
    }
    if (body.method === 'notifications/initialized') return new Response('', { status: 202 });
    if (body.method === 'tools/list') {
      listCalls += 1;
      if (listCalls === 1) {
        assert.equal(authz, 'DPoP at-initial');
        return new Response('', { status: 401, headers: { 'WWW-Authenticate': 'DPoP error="invalid_token"' } });
      }
      assert.equal(authz, 'DPoP at-refreshed-1');
      return json(200, { jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'ping' }] } });
    }
    if (body.method === 'tools/call') {
      toolCalls += 1;
      return new Response('', { status: 401, headers: { 'WWW-Authenticate': 'DPoP error="invalid_token"' } });
    }
    return new Response('', { status: 200 });
  };

  const client = new McpHttpClient({
    url: MCP,
    auth: mcpAuthProvider(MCP, dir, env, authFetch),
    fetchImpl: mcpFetch,
  });

  const tools = await client.listTools();
  assert.equal(tools.length, 1);
  assert.equal(listCalls, 2, 'idempotent tools/list retries once after token refresh');
  assert.equal(refreshCount, 1);

  const callOutcome = await client.callTool('ping', {});
  assert.equal(callOutcome.kind, 'not_connected');
  assert.equal(callOutcome.exitCode, JC_EXIT.notConnected);
  assert.equal(toolCalls, 1, 'non-idempotent tools/call must NOT replay on non-nonce 401');
  assert.equal(refreshCount, 1);
});

await test('JC_MCP_TOKEN legacy Bearer override works in McpHttpClient and jace auth status', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-v2-legacy-'));
  const MCP = 'https://edge.test/jc/mcp';
  const env = {
    HOME: dir,
    JC_STATE_DIR: dir,
    JC_MCP_URL: MCP,
    JC_MCP_TOKEN: 'legacy-static-secret-token',
    JC_HEADLESS_KEYSTORE: '1',
    JC_SECRET_BACKEND: 'encrypted',
  };

  const out = [];
  const code = await main(['auth', 'status', '--json'], env, { stdout: (t) => out.push(t), stderr: () => {} });
  assert.equal(code, JC_EXIT.ok);
  assert.equal(out[0].includes('legacy-static-secret-token'), false);
  const parsed = JSON.parse(out[0]);
  assert.equal(parsed.connected, true);
  assert.equal(parsed.auth_mode, 'legacy-bearer-env');
  assert.equal(parsed.storage_backend, 'env:JC_MCP_TOKEN');

  let seenAuthz;
  let seenDpop;
  const client = new McpHttpClient({
    url: MCP,
    auth: mcpAuthProvider(MCP, dir, env),
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init.body));
      seenAuthz = init.headers.authorization;
      seenDpop = init.headers.DPoP ?? init.headers.dpop;
      if (body.method === 'initialize') {
        return json(200, { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'edge', version: '1' } } });
      }
      if (body.method === 'notifications/initialized') return new Response('', { status: 202 });
      return json(200, { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '{}' }], structuredContent: { ok: true } } });
    },
  });
  const outcome = await client.callTool('ping', {});
  assert.equal(outcome.kind, 'ok');
  assert.equal(seenAuthz, 'Bearer legacy-static-secret-token');
  assert.equal(seenDpop, undefined);
});

await test('jace auth login --device and jace auth refresh CLI commands work end-to-end via main()', async () => {
  const http = await import('node:http');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-v2-e2e-cli-'));
  let baseUrl = '';
  let refreshCalls = 0;

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, baseUrl);
    res.setHeader('content-type', 'application/json');

    if (url.pathname === '/.well-known/oauth-protected-resource/jc/mcp') {
      res.end(JSON.stringify({ resource: `${baseUrl}/jc/mcp`, authorization_servers: [`${baseUrl}/jc`] }));
      return;
    }
    if (url.pathname === '/jc/.well-known/oauth-authorization-server') {
      res.end(JSON.stringify({
        issuer: `${baseUrl}/jc`,
        authorization_endpoint: `${baseUrl}/jc/oauth/authorize`,
        token_endpoint: `${baseUrl}/jc/oauth/token`,
        device_authorization_endpoint: `${baseUrl}/jc/oauth/device/code`,
      }));
      return;
    }
    if (url.pathname === '/jc/oauth/device/code') {
      res.end(JSON.stringify({
        device_code: 'cli-dc-1',
        user_code: 'CLI-1234',
        verification_uri: `${baseUrl}/jc/device`,
        expires_in: 600,
        interval: 0.05,
      }));
      return;
    }
    if (url.pathname === '/jc/oauth/token') {
      const params = new URLSearchParams(body);
      const grant = params.get('grant_type');
      verifyDpopHeader(req.headers.dpop, 'POST', `${baseUrl}/jc/oauth/token`, undefined);
      if (grant === 'refresh_token') {
        refreshCalls += 1;
        res.end(JSON.stringify({
          access_token: 'cli-at-2',
          refresh_token: 'cli-rt-2',
          token_type: 'DPoP',
          expires_in: 600,
          device_id: 'cli-dev-1',
          sub: 'cli-user',
        }));
        return;
      }
      res.end(JSON.stringify({
        access_token: 'cli-at-1',
        refresh_token: 'cli-rt-1',
        token_type: 'DPoP',
        expires_in: 600,
        device_id: 'cli-dev-1',
        sub: 'cli-user',
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
    const env = {
      HOME: dir,
      JC_STATE_DIR: dir,
      JC_MCP_URL: `${baseUrl}/jc/mcp`,
      JC_HEADLESS_KEYSTORE: '1',
      JC_SECRET_BACKEND: 'encrypted',
    };

    const loginOut = [];
    const loginErr = [];
    const loginCode = await main(['auth', 'login', '--device', '--json'], env, {
      stdout: (t) => loginOut.push(t),
      stderr: (t) => loginErr.push(t),
    });
    assert.equal(loginCode, JC_EXIT.ok);
    assert.match(loginErr.join('\n'), /CLI-1234/);
    const loginJson = JSON.parse(loginOut[0]);
    assert.equal(loginJson.connected, true);
    assert.equal(loginJson.auth_mode, 'dpop');
    assert.equal(loginJson.device_id, 'cli-dev-1');

    const refreshOut = [];
    const refreshCode = await main(['auth', 'refresh', '--json'], env, {
      stdout: (t) => refreshOut.push(t),
      stderr: () => {},
    });
    assert.equal(refreshCode, JC_EXIT.ok);
    assert.equal(refreshCalls, 1);
    const refreshJson = JSON.parse(refreshOut[0]);
    assert.equal(refreshJson.refreshed, true);
    assert.equal(refreshJson.auth_mode, 'dpop');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

console.log(`\njace-commander auth-v2: ${passed} passed`);
