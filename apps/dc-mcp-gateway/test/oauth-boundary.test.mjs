#!/usr/bin/env node
/**
 * OAuth boundary tests against the real server.js (child process, stub upstreams, no external network).
 *
 * Covers: registration-time redirect validation, redirect matching at authorize, PKCE S256 enforced on both
 * /authorize and the consent POST, PKCE verifier format and correctness at /token, authorization-code single use,
 * and CIMD client metadata refused for non-public hosts before any socket is opened.
 *
 * Run: node --test test/oauth-boundary.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const KEY = 'k'.repeat(32);
const ORIGIN = 'https://gw.test';
const JC_RESOURCE = `${ORIGIN}/jc/mcp`;
const PASS = 'pass-phrase';
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: b64u(crypto.createHash('sha256').update(verifier).digest()) };
};

function stub() {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  return { server, listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))) };
}

let nextPort = 19400;
async function boot() {
  const acs = stub();
  const dc = stub();
  const [acsPort, dcPort] = [await acs.listen(), await dc.listen()];
  const port = nextPort++;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `oauth-boundary-${port}-`));
  fs.writeFileSync(path.join(dir, 'clients.json'), JSON.stringify({
    'public-app': { client_name: 'public', redirect_uris: ['https://app.test/cb', 'http://127.0.0.1:9/cb'], token_endpoint_auth_method: 'none', oauth_lane: 'jc', scope: 'mcp' },
  }));
  fs.writeFileSync(path.join(dir, 'tokens.json'), '{}');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      PATH: process.env.PATH, GATEWAY_PORT: String(port), PUBLIC_ORIGIN: ORIGIN, CONSENT_PASSPHRASE: PASS, SIGNING_KEY: KEY, DATA_DIR: dir,
      UPSTREAM: `http://127.0.0.1:${dcPort}`, JC_ENABLED: '1', JC_UPSTREAM: `http://127.0.0.1:${dcPort}`,
      ACS_GATEWAY_URL: `http://127.0.0.1:${acsPort}`, ACS_JC_GATEWAY_TOKEN: 'jc-bridge-token',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  let up = false;
  for (let i = 0; i < 60 && !up; i += 1) {
    if (child.exitCode !== null) break;
    try { up = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  assert.ok(up, `gateway failed to start: ${output}`);
  const base = `http://127.0.0.1:${port}`;
  const authorizeUrl = (params) => `${base}/authorize?${new URLSearchParams({ oauth_lane: 'jc', resource: JC_RESOURCE, response_type: 'code', scope: 'mcp', state: 's1', ...params }).toString()}`;
  return {
    base,
    get: (url) => fetch(url, { redirect: 'manual' }),
    register: (body) => fetch(`${base}/register?oauth_lane=jc&resource=${encodeURIComponent(JC_RESOURCE)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
    authorize: (params) => fetch(authorizeUrl(params), { redirect: 'manual' }),
    consent: (fields) => fetch(`${base}/authorize/consent?oauth_lane=jc`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
      body: new URLSearchParams({ oauth_lane: 'jc', resource: JC_RESOURCE, scope: 'mcp', state: 's1', passphrase: PASS, ...fields }).toString(),
    }),
    token: (fields) => fetch(`${base}/token?oauth_lane=jc`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ resource: JC_RESOURCE, ...fields }).toString(),
    }),
    output: () => output,
    close: () => { child.kill('SIGKILL'); acs.server.close(); dc.server.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

async function withGateway(fn) {
  const gw = await boot();
  try { await fn(gw); } finally { gw.close(); }
}

const location = (res) => new URL(res.headers.get('location'));

// ---------------------------------------------------------------------------
// Registration-time redirect validation
// ---------------------------------------------------------------------------

test('registration accepts https and loopback redirects and rejects custom schemes, fragments, and userinfo', () =>
  withGateway(async (gw) => {
    const ok = await gw.register({ redirect_uris: ['https://app.example.com/cb', 'http://127.0.0.1:0/cb'], token_endpoint_auth_method: 'none' });
    assert.equal(ok.status, 201);
    for (const uri of ['myapp://cb', 'https://app.example.com/cb#x', 'https://u:p@app.example.com/cb', 'http://evil.example/cb', 'javascript:alert(1)']) {
      const r = await gw.register({ redirect_uris: [uri], token_endpoint_auth_method: 'none' });
      assert.equal(r.status, 400, `${uri} must be refused at registration`);
    }
  }));

// ---------------------------------------------------------------------------
// /authorize: redirect matching and PKCE
// ---------------------------------------------------------------------------

test('authorize refuses an unregistered redirect URI and an unregistered loopback path', () =>
  withGateway(async (gw) => {
    const { challenge } = pkce();
    const bad = await gw.authorize({ client_id: 'public-app', redirect_uri: 'https://attacker.example/cb', code_challenge: challenge, code_challenge_method: 'S256' });
    assert.equal(bad.status, 400);
    const badPath = await gw.authorize({ client_id: 'public-app', redirect_uri: 'http://127.0.0.1:9/other', code_challenge: challenge, code_challenge_method: 'S256' });
    assert.equal(badPath.status, 400);
  }));

test('authorize with a registered loopback port (any port) and valid S256 PKCE shows consent', () =>
  withGateway(async (gw) => {
    const { challenge } = pkce();
    const r = await gw.authorize({ client_id: 'public-app', redirect_uri: 'http://127.0.0.1:55555/cb', code_challenge: challenge, code_challenge_method: 'S256' });
    assert.equal(r.status, 200);
  }));

test('authorize refuses a request without S256 PKCE', () =>
  withGateway(async (gw) => {
    const { challenge } = pkce();
    const plain = await gw.authorize({ client_id: 'public-app', redirect_uri: 'https://app.test/cb', code_challenge: challenge, code_challenge_method: 'plain' });
    assert.equal(plain.status, 302);
    assert.equal(location(plain).searchParams.get('error'), 'invalid_request');
    const none = await gw.authorize({ client_id: 'public-app', redirect_uri: 'https://app.test/cb' });
    assert.equal(location(none).searchParams.get('error'), 'invalid_request');
  }));

test('CIMD client_id for a non-public host is refused before any connection (unknown client)', () =>
  withGateway(async (gw) => {
    const { challenge } = pkce();
    for (const clientId of ['https://127.0.0.1/client.json', 'https://169.254.169.254/latest/meta-data/', 'https://localhost/client.json', 'https://[::1]/client.json']) {
      const r = await gw.authorize({ client_id: clientId, redirect_uri: 'https://app.test/cb', code_challenge: challenge, code_challenge_method: 'S256' });
      assert.equal(r.status, 400, `${clientId} must be refused`);
      assert.match(await r.text(), /Unknown client/);
    }
    assert.match(gw.output(), /client metadata rejected/);
  }));

// ---------------------------------------------------------------------------
// Consent POST: the second entry point must enforce the same rules
// ---------------------------------------------------------------------------

test('consent refuses a POST with no PKCE, a non-S256 method, or a malformed challenge', () =>
  withGateway(async (gw) => {
    const { challenge } = pkce();
    const base = { client_id: 'public-app', redirect_uri: 'https://app.test/cb', code_challenge: challenge, code_challenge_method: 'S256' };
    const none = await gw.consent({ ...base, code_challenge: '', code_challenge_method: '' });
    assert.equal(none.status, 400);
    const plain = await gw.consent({ ...base, code_challenge_method: 'plain' });
    assert.equal(plain.status, 400);
    const short = await gw.consent({ ...base, code_challenge: 'abc' });
    assert.equal(short.status, 400);
  }));

test('consent refuses a wrong passphrase', () =>
  withGateway(async (gw) => {
    const { challenge } = pkce();
    const r = await gw.consent({ client_id: 'public-app', redirect_uri: 'https://app.test/cb', code_challenge: challenge, code_challenge_method: 'S256', passphrase: 'nope' });
    assert.equal(r.status, 401);
  }));

// ---------------------------------------------------------------------------
// Token endpoint: PKCE verification, verifier format, single-use codes
// ---------------------------------------------------------------------------

async function issueCode(gw, { redirect = 'https://app.test/cb' } = {}) {
  const { verifier, challenge } = pkce();
  const consent = await gw.consent({ client_id: 'public-app', redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256' });
  assert.equal(consent.status, 302, `consent must issue a code: ${consent.status}`);
  const code = location(consent).searchParams.get('code');
  assert.ok(code, 'consent redirect carries a code');
  return { code, verifier, redirect };
}

test('valid PKCE exchange issues tokens; the same code cannot be replayed', () =>
  withGateway(async (gw) => {
    const { code, verifier, redirect } = await issueCode(gw);
    const ok = await gw.token({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirect, client_id: 'public-app' });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(typeof body.access_token, 'string');
    assert.equal(typeof body.refresh_token, 'string');
    const replay = await gw.token({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirect, client_id: 'public-app' });
    assert.equal(replay.status, 400);
    assert.equal((await replay.json()).error, 'invalid_grant');
  }));

test('a wrong verifier is refused and burns the code', () =>
  withGateway(async (gw) => {
    const { code, redirect } = await issueCode(gw);
    const wrong = await gw.token({ grant_type: 'authorization_code', code, code_verifier: 'x'.repeat(43), redirect_uri: redirect, client_id: 'public-app' });
    assert.equal(wrong.status, 400);
    assert.equal((await wrong.json()).error, 'invalid_grant');
    const after = await gw.token({ grant_type: 'authorization_code', code, code_verifier: 'x'.repeat(43), redirect_uri: redirect, client_id: 'public-app' });
    assert.equal(after.status, 400);
  }));

test('a verifier outside RFC 7636 length or alphabet is refused', () =>
  withGateway(async (gw) => {
    const { code, redirect } = await issueCode(gw);
    for (const bad of ['short', 'a'.repeat(129), 'has space ' + 'a'.repeat(40), 'bad/char' + 'a'.repeat(40)]) {
      const r = await gw.token({ grant_type: 'authorization_code', code, code_verifier: bad, redirect_uri: redirect, client_id: 'public-app' });
      assert.equal(r.status, 400, `verifier ${JSON.stringify(bad).slice(0, 20)} must be refused`);
    }
  }));

test('a code redeemed with a different redirect_uri is refused', () =>
  withGateway(async (gw) => {
    const { code, verifier } = await issueCode(gw);
    const r = await gw.token({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: 'http://127.0.0.1:9/cb', client_id: 'public-app' });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'invalid_grant');
  }));
