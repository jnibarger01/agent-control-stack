#!/usr/bin/env node
/**
 * Jace Commander lane (/jc/mcp) at the gateway boundary.
 *
 * Proves:
 *  - JC lane refuses to start without its own ACS bridge credential, or when
 *    that credential equals the Desktop Commander one
 *  - disabled lane is not routable (404)
 *  - RFC 8707 audience separation: a /mcp token cannot call /jc/mcp and a
 *    /jc/mcp token cannot call /mcp; the OAuth flow mints jc-audience tokens
 *  - tools/call goes to ACS POST /jc/capability/issue with the jc bridge
 *    credential, spoofed client _meta is stripped, and the ACS envelope is
 *    forwarded to the jc upstream only (never to the DC upstream)
 *  - require_approval (privileged_exec) fails closed with the approval
 *    challenge surfaced, nothing forwarded
 *  - capability version/audience binding: a dc (acs.dc.v1) envelope on the jc
 *    route is rejected (acs_capability_wrong_audience), nothing forwarded
 *  - a JSON-RPC batch containing tools/call is rejected fail-closed
 *    (batched_tools_call_rejected): the gateway cannot attribute ACS issuance
 *    or strip spoofed authority fields per batch element
 *
 * Run: node --test test/jc-route.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const KEY = 'k'.repeat(32);
const ORIGIN = 'https://gw.test';
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

function token(aud, iss = ORIGIN) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ iss, sub: 'jacen', client_id: 'c1', aud, scope: 'mcp', iat: now(), exp: now() + 600, jti: crypto.randomUUID() }));
  return `${h}.${p}.${crypto.createHmac('sha256', KEY).update(`${h}.${p}`).digest('base64url')}`;
}
const jcToken = (aud = `${ORIGIN}/jc/mcp`, iss = `${ORIGIN}/jc`) => token(aud, iss);

function recorder(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      requests.push({ path: req.url, auth: req.headers.authorization, actor: req.headers['x-dc-actor'], jcActor: req.headers['x-jc-actor'], body: text ? JSON.parse(text) : null });
      const { status, body } = handler(requests.at(-1));
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  return { server, requests, listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))) };
}

const allowCapability = (req) => ({
  status: 200,
  body: {
    decision: 'allow',
    capability: { payload: { version: 'acs.jc.v1', audience: 'jace-commander', toolName: req.body.tool, normalizedArguments: JSON.parse(req.body.argsSummary) }, signature: 'acs-sig', keyId: 'acs-jc-1' },
    claimActionHash: 'claim', inputHash: 'input', workerId: 'acs-jc-bridge',
  },
});

let nextPort = 18300;
async function startGateway(env) {
  const port = nextPort++;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { PATH: process.env.PATH, GATEWAY_PORT: String(port), PUBLIC_ORIGIN: ORIGIN, CONSENT_PASSPHRASE: 'pass-phrase', SIGNING_KEY: KEY, DATA_DIR: `/tmp/jc-gw-${port}-${process.pid}`, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  for (let i = 0; i < 50; i += 1) {
    if (child.exitCode !== null) return { port, child, exitCode: child.exitCode, stderr };
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) return { port, child, exited, stderr: () => stderr };
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 500))]);
  return { port, child, exitCode: code, stderr };
}

async function lane({ acsHandler = allowCapability, jcVariant = 'jc', env = {} } = {}) {
  const acs = recorder(acsHandler);
  const dcUp = recorder(() => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result: { lane: 'dc' } } }));
  const jcUp = recorder((req) => (req.path === '/authority'
    ? { status: 200, body: { variant: jcVariant } }
    : { status: 200, body: { jsonrpc: '2.0', id: 1, result: { lane: 'jc' } } }));
  const [acsPort, dcPort, jcPort] = [await acs.listen(), await dcUp.listen(), await jcUp.listen()];
  const gw = await startGateway({
    UPSTREAM: `http://127.0.0.1:${dcPort}`,
    JC_ENABLED: '1',
    JC_UPSTREAM: `http://127.0.0.1:${jcPort}`,
    ACS_GATEWAY_URL: `http://127.0.0.1:${acsPort}`,
    ACS_JC_GATEWAY_TOKEN: 'jc-bridge-token',
    ...env,
  });
  assert.equal(gw.exitCode, undefined, `gateway failed to start: ${typeof gw.stderr === 'function' ? gw.stderr() : gw.stderr}`);
  const close = () => { gw.child.kill('SIGKILL'); acs.server.close(); dcUp.server.close(); jcUp.server.close(); };
  return { gw, acs, dcUp, jcUp, close };
}

const mcpRequests = (rec) => rec.requests.filter((r) => r.path !== '/authority');

const call = (port, path, bearer, body) => fetch(`http://127.0.0.1:${port}${path}`, {
  method: 'POST',
  headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify(body),
});

test('jc lane refuses to start without its own ACS bridge credential', async () => {
  const missing = await startGateway({ JC_ENABLED: '1', ACS_GATEWAY_URL: 'http://127.0.0.1:1' });
  assert.equal(missing.exitCode, 1);
  const shared = await startGateway({ JC_ENABLED: '1', ACS_GATEWAY_URL: 'http://127.0.0.1:1', ACS_GATEWAY_TOKEN: 'same', ACS_JC_GATEWAY_TOKEN: 'same' });
  assert.equal(shared.exitCode, 1);
});

test('jc lane disabled: /jc/mcp and its metadata are not routable', async () => {
  const gw = await startGateway({});
  try {
    const r = await call(gw.port, '/jc/mcp', jcToken(), { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(r.status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${gw.port}/.well-known/oauth-protected-resource/jc/mcp`)).status, 404);
  } finally { gw.child.kill('SIGKILL'); }
});

test('RFC 8707 audience separation between /mcp and /jc/mcp', async () => {
  const { gw, dcUp, jcUp, close } = await lane();
  try {
    const dcToken = token(`${ORIGIN}/mcp`);
    const jcTok = jcToken();
    const listTools = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

    const crossToJc = await call(gw.port, '/jc/mcp', dcToken, listTools);
    assert.equal(crossToJc.status, 401);
    assert.match(crossToJc.headers.get('www-authenticate'), /oauth-protected-resource\/jc\/mcp/);
    const crossToDc = await call(gw.port, '/mcp', jcTok, listTools);
    assert.equal(crossToDc.status, 401);

    const ok = await call(gw.port, '/jc/mcp', jcTok, listTools);
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).result, { lane: 'jc' });
    assert.equal(mcpRequests(jcUp).length, 1);
    assert.equal(mcpRequests(jcUp)[0].path, '/mcp');
    assert.equal(dcUp.requests.length, 0);

    const meta = await (await fetch(`http://127.0.0.1:${gw.port}/.well-known/oauth-protected-resource/jc/mcp`)).json();
    assert.equal(meta.resource, `${ORIGIN}/jc/mcp`);
  } finally { close(); }
});

test('5. JC OAuth discovery endpoints consistently advertise JC issuer and endpoints', async () => {
  const { gw, close } = await lane();
  try {
    const base = `http://127.0.0.1:${gw.port}`;
    const resourceMeta = await (await fetch(`${base}/.well-known/oauth-protected-resource/jc/mcp`)).json();
    assert.equal(resourceMeta.resource, `${ORIGIN}/jc/mcp`);
    assert.deepEqual(resourceMeta.authorization_servers, [`${ORIGIN}/jc`]);

    for (const metadataPath of [
      '/.well-known/oauth-authorization-server/jc',
      '/jc/.well-known/oauth-authorization-server',
      '/jc/.well-known/openid-configuration',
    ]) {
      const res = await fetch(`${base}${metadataPath}`);
      assert.equal(res.status, 200);
      const meta = await res.json();
      assert.equal(meta.issuer, `${ORIGIN}/jc`);
      assert.equal(meta.authorization_endpoint, `${ORIGIN}/jc/authorize`);
      assert.equal(meta.token_endpoint, `${ORIGIN}/jc/token`);
      assert.equal(meta.registration_endpoint, `${ORIGIN}/jc/register`);
      assert.equal(meta.resource, `${ORIGIN}/jc/mcp`);
      assert.equal(meta.authorization_response_iss_parameter_supported, true);
    }
  } finally { close(); }
});

test('6A. Dedicated JC success path: /jc/authorize -> consent -> redirect -> /jc/token', async () => {
  const { gw, close } = await lane();
  try {
    const base = `http://127.0.0.1:${gw.port}`;
    const reg = await (await fetch(`${base}/jc/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:9/jc-cb'], grant_types: ['authorization_code', 'refresh_token'] }),
    })).json();
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const params = {
      client_id: reg.client_id, redirect_uri: 'http://127.0.0.1:9/jc-cb', response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp', state: 'state-6a',
    };

    const authRes = await fetch(`${base}/jc/authorize?${new URLSearchParams(params)}`);
    assert.equal(authRes.status, 200);
    const html = await authRes.text();
    assert.match(html, /Jace Commander access/);
    assert.match(html, /action="\/jc\/authorize\/consent"/);

    const consentRes = await fetch(`${base}/jc/authorize/consent`, {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, passphrase: 'pass-phrase' }).toString(),
    });
    assert.equal(consentRes.status, 302);
    const loc = new URL(consentRes.headers.get('location'));
    assert.equal(loc.searchParams.get('state'), 'state-6a');
    assert.equal(loc.searchParams.get('iss'), `${ORIGIN}/jc`);
    const code = loc.searchParams.get('code');
    assert.ok(code, 'authorization code must be present in redirect');

    const tokenRes = await fetch(`${base}/jc/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, code_verifier: verifier,
        redirect_uri: params.redirect_uri, client_id: reg.client_id,
      }).toString(),
    });
    assert.equal(tokenRes.status, 200);
    const tokenData = await tokenRes.json();
    const claims = JSON.parse(Buffer.from(tokenData.access_token.split('.')[1], 'base64url').toString('utf8'));
    assert.equal(claims.iss, `${ORIGIN}/jc`);
    assert.equal(claims.aud, `${ORIGIN}/jc/mcp`);

    assert.equal((await call(gw.port, '/jc/mcp', tokenData.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 200);
    assert.equal((await call(gw.port, '/mcp', tokenData.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401);
  } finally { close(); }
});

test('6B. Dedicated JC authorization error path: invalid request redirects with error + state + correct JC iss', async () => {
  const { gw, close } = await lane();
  try {
    const base = `http://127.0.0.1:${gw.port}`;
    const reg = await (await fetch(`${base}/jc/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:9/jc-err-cb'] }),
    })).json();
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const baseParams = {
      client_id: reg.client_id, redirect_uri: 'http://127.0.0.1:9/jc-err-cb', response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp', state: 'state-6b',
    };

    // 1. Unsupported response_type
    const errRes1 = await fetch(`${base}/jc/authorize?${new URLSearchParams({ ...baseParams, response_type: 'token' })}`, { redirect: 'manual' });
    assert.equal(errRes1.status, 302);
    const loc1 = new URL(errRes1.headers.get('location'));
    assert.equal(loc1.searchParams.get('error'), 'unsupported_response_type');
    assert.equal(loc1.searchParams.get('state'), 'state-6b');
    assert.equal(loc1.searchParams.get('iss'), `${ORIGIN}/jc`);

    // 2. Missing/invalid PKCE
    const errRes2 = await fetch(`${base}/jc/authorize?${new URLSearchParams({ ...baseParams, code_challenge_method: 'plain' })}`, { redirect: 'manual' });
    assert.equal(errRes2.status, 302);
    const loc2 = new URL(errRes2.headers.get('location'));
    assert.equal(loc2.searchParams.get('error'), 'invalid_request');
    assert.equal(loc2.searchParams.get('state'), 'state-6b');
    assert.equal(loc2.searchParams.get('iss'), `${ORIGIN}/jc`);

    // 3. Invalid scope
    const errRes3 = await fetch(`${base}/jc/authorize?${new URLSearchParams({ ...baseParams, scope: 'invalid_scope' })}`, { redirect: 'manual' });
    assert.equal(errRes3.status, 302);
    const loc3 = new URL(errRes3.headers.get('location'));
    assert.equal(loc3.searchParams.get('error'), 'invalid_scope');
    assert.equal(loc3.searchParams.get('state'), 'state-6b');
    assert.equal(loc3.searchParams.get('iss'), `${ORIGIN}/jc`);

    // 4. Mismatched resource
    const errRes4 = await fetch(`${base}/jc/authorize?${new URLSearchParams({ ...baseParams, resource: `${ORIGIN}/mcp` })}`, { redirect: 'manual' });
    assert.equal(errRes4.status, 302);
    const loc4 = new URL(errRes4.headers.get('location'));
    assert.equal(loc4.searchParams.get('error'), 'invalid_target');
    assert.equal(loc4.searchParams.get('state'), 'state-6b');
    assert.equal(loc4.searchParams.get('iss'), `${ORIGIN}/jc`);

    // 5. Mismatched incoming iss
    const errRes5 = await fetch(`${base}/jc/authorize?${new URLSearchParams({ ...baseParams, iss: 'https://attacker.com' })}`, { redirect: 'manual' });
    assert.equal(errRes5.status, 302);
    const loc5 = new URL(errRes5.headers.get('location'));
    assert.equal(loc5.searchParams.get('error'), 'invalid_request');
    assert.equal(loc5.searchParams.get('state'), 'state-6b');
    assert.equal(loc5.searchParams.get('iss'), `${ORIGIN}/jc`);
  } finally { close(); }
});

test('6C. Legacy /authorize with JC resource selects JC issuer semantics and issues JC-only code', async () => {
  const { gw, close } = await lane();
  try {
    const base = `http://127.0.0.1:${gw.port}`;
    const reg = await (await fetch(`${base}/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:9/leg-cb'] }),
    })).json();
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const params = {
      client_id: reg.client_id, redirect_uri: 'http://127.0.0.1:9/leg-cb', response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp', state: 'state-6c',
      resource: `${ORIGIN}/jc/mcp`,
    };

    const authRes = await fetch(`${base}/authorize?${new URLSearchParams(params)}`);
    assert.equal(authRes.status, 200);
    const html = await authRes.text();
    assert.match(html, /Jace Commander access/);

    const consentRes = await fetch(`${base}/authorize/consent`, {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, passphrase: 'pass-phrase' }).toString(),
    });
    assert.equal(consentRes.status, 302);
    const loc = new URL(consentRes.headers.get('location'));
    assert.equal(loc.searchParams.get('state'), 'state-6c');
    assert.equal(loc.searchParams.get('iss'), `${ORIGIN}/jc`, 'must include JC issuer, not DC issuer');
    const code = loc.searchParams.get('code');

    // Code must exchange into JC resource
    const tokenRes = await fetch(`${base}/jc/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, code_verifier: verifier,
        redirect_uri: params.redirect_uri, client_id: reg.client_id,
      }).toString(),
    });
    assert.equal(tokenRes.status, 200);
    const tokenData = await tokenRes.json();
    const claims = JSON.parse(Buffer.from(tokenData.access_token.split('.')[1], 'base64url').toString('utf8'));
    assert.equal(claims.iss, `${ORIGIN}/jc`);
    assert.equal(claims.aud, `${ORIGIN}/jc/mcp`);
  } finally { close(); }
});

test('6D. Legacy /token with valid JC code succeeds under JC lane', async () => {
  const { gw, close } = await lane();
  try {
    const base = `http://127.0.0.1:${gw.port}`;
    const reg = await (await fetch(`${base}/jc/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:9/leg-tok-cb'] }),
    })).json();
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const params = {
      client_id: reg.client_id, redirect_uri: 'http://127.0.0.1:9/leg-tok-cb', response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp', state: 'state-6d',
    };

    const consentRes = await fetch(`${base}/jc/authorize/consent`, {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, passphrase: 'pass-phrase' }).toString(),
    });
    assert.equal(consentRes.status, 302);
    const code = new URL(consentRes.headers.get('location')).searchParams.get('code');

    // Exchange via legacy /token
    const tokenRes = await fetch(`${base}/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, code_verifier: verifier,
        redirect_uri: params.redirect_uri, client_id: reg.client_id,
      }).toString(),
    });
    assert.equal(tokenRes.status, 200);
    const tokenData = await tokenRes.json();
    const claims = JSON.parse(Buffer.from(tokenData.access_token.split('.')[1], 'base64url').toString('utf8'));
    assert.equal(claims.iss, `${ORIGIN}/jc`);
    assert.equal(claims.aud, `${ORIGIN}/jc/mcp`);
    assert.equal((await call(gw.port, '/jc/mcp', tokenData.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 200);
    assert.equal((await call(gw.port, '/mcp', tokenData.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401);
  } finally { close(); }
});

test('6E. Cross-lane rejection: isolation between DC and JC codes, parameters, and tokens', async () => {
  const { gw, close } = await lane();
  try {
    const base = `http://127.0.0.1:${gw.port}`;
    const reg = await (await fetch(`${base}/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:9/iso-cb'] }),
    })).json();

    async function makeGrant(lanePrefix = '') {
      const verifier = crypto.randomBytes(32).toString('base64url');
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      const p = {
        client_id: reg.client_id, redirect_uri: 'http://127.0.0.1:9/iso-cb', response_type: 'code',
        code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp', state: crypto.randomUUID(),
      };
      const consentUrl = lanePrefix ? `${base}${lanePrefix}/authorize/consent` : `${base}/authorize/consent`;
      const consent = await fetch(consentUrl, {
        method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ...p, passphrase: 'pass-phrase' }).toString(),
      });
      const code = new URL(consent.headers.get('location')).searchParams.get('code');
      return { code, verifier, redirect_uri: p.redirect_uri, client_id: reg.client_id };
    }

    // 1. Default (DC) code cannot exchange as JC on /jc/token
    const dcGrant1 = await makeGrant('');
    const dcAtJcToken = await fetch(`${base}/jc/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: dcGrant1.code, code_verifier: dcGrant1.verifier,
        redirect_uri: dcGrant1.redirect_uri, client_id: dcGrant1.client_id,
      }).toString(),
    });
    assert.equal(dcAtJcToken.status, 400);
    assert.equal((await dcAtJcToken.json()).error, 'invalid_target');

    // 2. Default (DC) code cannot exchange for JC resource on /token
    const dcGrant2 = await makeGrant('');
    const dcWithJcResource = await fetch(`${base}/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: dcGrant2.code, code_verifier: dcGrant2.verifier,
        redirect_uri: dcGrant2.redirect_uri, client_id: dcGrant2.client_id, resource: `${ORIGIN}/jc/mcp`,
      }).toString(),
    });
    assert.equal(dcWithJcResource.status, 400);
    assert.equal((await dcWithJcResource.json()).error, 'invalid_target');

    // 3. JC code cannot exchange for default (DC) resource on /token or /jc/token
    const jcGrant1 = await makeGrant('/jc');
    const jcWithDcResource = await fetch(`${base}/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: jcGrant1.code, code_verifier: jcGrant1.verifier,
        redirect_uri: jcGrant1.redirect_uri, client_id: jcGrant1.client_id, resource: `${ORIGIN}/mcp`,
      }).toString(),
    });
    assert.equal(jcWithDcResource.status, 400);
    assert.equal((await jcWithDcResource.json()).error, 'invalid_target');

    // 4. Mismatched PKCE verifier fails
    const jcGrant2 = await makeGrant('/jc');
    const badPkce = await fetch(`${base}/jc/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: jcGrant2.code, code_verifier: 'wrong-verifier'.repeat(4),
        redirect_uri: jcGrant2.redirect_uri, client_id: jcGrant2.client_id,
      }).toString(),
    });
    assert.equal(badPkce.status, 400);
    assert.equal((await badPkce.json()).error, 'invalid_grant');

    // 5. Mismatched client_id fails
    const jcGrant3 = await makeGrant('/jc');
    const badClient = await fetch(`${base}/jc/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: jcGrant3.code, code_verifier: jcGrant3.verifier,
        redirect_uri: jcGrant3.redirect_uri, client_id: 'other-client-id',
      }).toString(),
    });
    assert.equal(badClient.status, 400);
    assert.equal((await badClient.json()).error, 'invalid_grant');

    // 6. One-time code use (replaying used code fails)
    const replay = await fetch(`${base}/jc/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: jcGrant3.code, code_verifier: jcGrant3.verifier,
        redirect_uri: jcGrant3.redirect_uri, client_id: jcGrant3.client_id,
      }).toString(),
    });
    assert.equal(replay.status, 400);
    assert.equal((await replay.json()).error, 'invalid_grant');
  } finally { close(); }
});

test('6F. Refresh token path: JC refresh works on /jc/token and legacy /token, cross-lane is rejected', async () => {
  const { gw, close } = await lane();
  try {
    const base = `http://127.0.0.1:${gw.port}`;
    const reg = await (await fetch(`${base}/jc/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:9/ref-cb'], grant_types: ['authorization_code', 'refresh_token'] }),
    })).json();

    // Mint JC tokens
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const p = {
      client_id: reg.client_id, redirect_uri: 'http://127.0.0.1:9/ref-cb', response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp', state: 's-ref',
    };
    const consent = await fetch(`${base}/jc/authorize/consent`, {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...p, passphrase: 'pass-phrase' }).toString(),
    });
    const code = new URL(consent.headers.get('location')).searchParams.get('code');
    const tokRes = await fetch(`${base}/jc/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, code_verifier: verifier,
        redirect_uri: p.redirect_uri, client_id: reg.client_id,
      }).toString(),
    });
    const tokens = await tokRes.json();
    assert.ok(tokens.refresh_token);

    // 1. Legitimate JC refresh works on legacy /token
    const legRefreshRes = await fetch(`${base}/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: reg.client_id,
      }).toString(),
    });
    assert.equal(legRefreshRes.status, 200);
    const legTokens = await legRefreshRes.json();
    const claims1 = JSON.parse(Buffer.from(legTokens.access_token.split('.')[1], 'base64url').toString('utf8'));
    assert.equal(claims1.iss, `${ORIGIN}/jc`);
    assert.equal(claims1.aud, `${ORIGIN}/jc/mcp`);

    // 2. Legitimate JC refresh works on /jc/token
    const jcRefreshRes = await fetch(`${base}/jc/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: legTokens.refresh_token, client_id: reg.client_id,
      }).toString(),
    });
    assert.equal(jcRefreshRes.status, 200);
    const jcTokens = await jcRefreshRes.json();
    const claims2 = JSON.parse(Buffer.from(jcTokens.access_token.split('.')[1], 'base64url').toString('utf8'));
    assert.equal(claims2.iss, `${ORIGIN}/jc`);
    assert.equal(claims2.aud, `${ORIGIN}/jc/mcp`);

    // 3. Replaying an already-rotated refresh token fails
    const replayed = await fetch(`${base}/jc/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: reg.client_id,
      }).toString(),
    });
    assert.equal(replayed.status, 400);
    assert.equal((await replayed.json()).error, 'invalid_grant');

    // 4. Cross-lane refresh rejection: mint a DC token and try to refresh at /jc/token
    const dcVerifier = crypto.randomBytes(32).toString('base64url');
    const dcChallenge = crypto.createHash('sha256').update(dcVerifier).digest('base64url');
    const dcConsent = await fetch(`${base}/authorize/consent`, {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: reg.client_id, redirect_uri: 'http://127.0.0.1:9/ref-cb',
        code_challenge: dcChallenge, scope: 'mcp', passphrase: 'pass-phrase',
      }).toString(),
    });
    const dcCode = new URL(dcConsent.headers.get('location')).searchParams.get('code');
    const dcTokRes = await fetch(`${base}/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: dcCode, code_verifier: dcVerifier,
        redirect_uri: 'http://127.0.0.1:9/ref-cb', client_id: reg.client_id,
      }).toString(),
    });
    const dcTokens = await dcTokRes.json();

    const crossDcRefresh = await fetch(`${base}/jc/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: dcTokens.refresh_token, client_id: reg.client_id,
      }).toString(),
    });
    assert.equal(crossDcRefresh.status, 400);
    assert.equal((await crossDcRefresh.json()).error, 'invalid_target');

    // 5. Cross-resource refresh request fails
    const crossResRefresh = await fetch(`${base}/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: jcTokens.refresh_token, client_id: reg.client_id,
        resource: `${ORIGIN}/mcp`,
      }).toString(),
    });
    assert.equal(crossResRefresh.status, 400);
    assert.equal((await crossResRefresh.json()).error, 'invalid_target');
  } finally { close(); }
});

test('6G. Historical issuer-less refresh records resolve by resource and fail closed when ambiguous', async () => {
  // Compatibility policy under test:
  //  - legacy record (no `issuer`) + resource === JC_RESOURCE -> JC lane
  //  - legacy record (no `issuer`) + resource === RESOURCE    -> default lane
  //  - legacy record with any other resource                  -> fail closed
  //  - record whose issuer contradicts its resource           -> fail closed
  const dataDir = `/tmp/jc-gw-legacy-${process.pid}-${nextPort}`;
  const expiry = now() + 3600;
  const legacyJc = 'legacy-jc-rjti';
  const legacyJc2 = 'legacy-jc-rjti-2';
  const legacyDc = 'legacy-dc-rjti';
  const legacyDc2 = 'legacy-dc-rjti-2';
  const ambiguous = 'ambiguous-rjti';
  const mismatched = 'mismatched-rjti';
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dataDir, 'tokens.json'), JSON.stringify({
    [legacyJc]: { client_id: 'legacy-client', scope: 'mcp', resource: `${ORIGIN}/jc/mcp`, exp: expiry, active: true },
    [legacyJc2]: { client_id: 'legacy-client', scope: 'mcp', resource: `${ORIGIN}/jc/mcp`, exp: expiry, active: true },
    [legacyDc]: { client_id: 'legacy-client', scope: 'mcp', resource: `${ORIGIN}/mcp`, exp: expiry, active: true },
    [legacyDc2]: { client_id: 'legacy-client', scope: 'mcp', resource: `${ORIGIN}/mcp`, exp: expiry, active: true },
    [ambiguous]: { client_id: 'legacy-client', scope: 'mcp', resource: 'https://elsewhere.example/mcp', exp: expiry, active: true },
    [mismatched]: { client_id: 'legacy-client', scope: 'mcp', resource: `${ORIGIN}/mcp`, issuer: `${ORIGIN}/jc`, exp: expiry, active: true },
  }), { mode: 0o600 });

  const { gw, close } = await lane({ env: { DATA_DIR: dataDir } });
  const base = `http://127.0.0.1:${gw.port}`;
  const refresh = (rjti, at) => fetch(`${base}${at}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rjti, client_id: 'legacy-client' }).toString(),
  });
  const claimsOf = (t) => JSON.parse(Buffer.from(t.access_token.split('.')[1], 'base64url').toString('utf8'));

  try {
    // 1. Historical JC record resolves to the JC lane and keeps JC identity.
    const jcRes = await refresh(legacyJc, '/jc/token');
    assert.equal(jcRes.status, 200);
    const jcClaims = claimsOf(await jcRes.json());
    assert.equal(jcClaims.iss, `${ORIGIN}/jc`);
    assert.equal(jcClaims.aud, `${ORIGIN}/jc/mcp`);

    // 2. The same kind of historical JC record also resolves safely on legacy /token.
    const jcLegacyRes = await refresh(legacyJc2, '/token');
    assert.equal(jcLegacyRes.status, 200);
    const jcLegacyClaims = claimsOf(await jcLegacyRes.json());
    assert.equal(jcLegacyClaims.iss, `${ORIGIN}/jc`);
    assert.equal(jcLegacyClaims.aud, `${ORIGIN}/jc/mcp`);

    // 3. Historical default record stays on the default lane.
    const dcRes = await refresh(legacyDc, '/token');
    assert.equal(dcRes.status, 200);
    const dcClaims = claimsOf(await dcRes.json());
    assert.equal(dcClaims.iss, ORIGIN);
    assert.equal(dcClaims.aud, `${ORIGIN}/mcp`);

    // 4. A historical default record may not enter the JC lane.
    const crossRes = await refresh(legacyDc2, '/jc/token');
    assert.equal(crossRes.status, 400);
    assert.equal((await crossRes.json()).error, 'invalid_target');

    // 5. An issuer-less record with an unrecognised resource is ambiguous -> fail closed.
    const ambRes = await refresh(ambiguous, '/token');
    assert.equal(ambRes.status, 400);
    assert.equal((await ambRes.json()).error, 'invalid_grant');

    // 6. A record whose issuer contradicts its resource is rejected, not reinterpreted.
    const mmRes = await refresh(mismatched, '/token');
    assert.equal(mmRes.status, 400);
    assert.equal((await mmRes.json()).error, 'invalid_grant');

    // 7. Legacy resolution is persisted, closing the compatibility window.
    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'tokens.json'), 'utf8'));
    assert.equal(stored[legacyJc].issuer, `${ORIGIN}/jc`);
    assert.equal(stored[legacyDc].issuer, ORIGIN);
    assert.equal(stored[legacyJc].active, false); // rotation still enforced
  } finally {
    close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('8. Full validation sequence: ChatGPT OAuth lifecycle and JC bridge proxying', async () => {
  const { gw, acs, jcUp, close } = await lane();
  try {
    const base = `http://127.0.0.1:${gw.port}`;

    // POST /jc/mcp -> 401
    const unauth = await fetch(`${base}/jc/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal(unauth.status, 401);
    const wwwAuth = unauth.headers.get('www-authenticate');
    assert.match(wwwAuth, /oauth-protected-resource\/jc\/mcp/);

    // GET /.well-known/oauth-protected-resource/jc/mcp -> 200
    const prmRes = await fetch(`${base}/.well-known/oauth-protected-resource/jc/mcp`);
    assert.equal(prmRes.status, 200);
    const prm = await prmRes.json();
    assert.equal(prm.resource, `${ORIGIN}/jc/mcp`);
    assert.deepEqual(prm.authorization_servers, [`${ORIGIN}/jc`]);

    // GET /.well-known/oauth-authorization-server/jc -> 200
    const asRes = await fetch(`${base}/.well-known/oauth-authorization-server/jc`);
    assert.equal(asRes.status, 200);
    const asMeta = await asRes.json();
    assert.equal(asMeta.issuer, `${ORIGIN}/jc`);
    assert.equal(asMeta.authorization_endpoint, `${ORIGIN}/jc/authorize`);
    assert.equal(asMeta.token_endpoint, `${ORIGIN}/jc/token`);
    assert.equal(asMeta.registration_endpoint, `${ORIGIN}/jc/register`);

    // POST /jc/register -> 201
    const regRes = await fetch(`${base}/jc/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:9/chatgpt-cb'], grant_types: ['authorization_code', 'refresh_token'] }),
    });
    assert.equal(regRes.status, 201);
    const reg = await regRes.json();

    // GET /jc/authorize -> 200
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const authParams = {
      client_id: reg.client_id, redirect_uri: 'http://127.0.0.1:9/chatgpt-cb', response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp', state: 'cgpt-state-xyz',
    };
    const getAuth = await fetch(`${base}/jc/authorize?${new URLSearchParams(authParams)}`);
    assert.equal(getAuth.status, 200);

    // POST /jc/authorize/consent -> 302
    const postConsent = await fetch(`${base}/jc/authorize/consent`, {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...authParams, passphrase: 'pass-phrase' }).toString(),
    });
    assert.equal(postConsent.status, 302);
    const loc = new URL(postConsent.headers.get('location'));
    assert.ok(loc.searchParams.get('code'));
    assert.equal(loc.searchParams.get('state'), 'cgpt-state-xyz');
    assert.equal(loc.searchParams.get('iss'), `${ORIGIN}/jc`);

    // POST /jc/token -> 200
    const postToken = await fetch(`${base}/jc/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: loc.searchParams.get('code'), code_verifier: verifier,
        redirect_uri: authParams.redirect_uri, client_id: reg.client_id,
      }).toString(),
    });
    assert.equal(postToken.status, 200);
    const tokens = await postToken.json();

    // POST /jc/mcp -> authenticated and routed to JC bridge
    const mcpRes = await call(gw.port, '/jc/mcp', tokens.access_token, {
      jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'acs_read', arguments: { view: 'health' } },
    });
    assert.equal(mcpRes.status, 200);
    assert.equal(acs.requests.length, 1);
    assert.equal(acs.requests[0].path, '/jc/capability/issue');
    assert.equal(mcpRequests(jcUp).length, 1);
  } finally { close(); }
});

test('tools/call: jc issue route + jc credential, spoofed meta stripped, forwarded to jc upstream only', async () => {
  const { gw, acs, dcUp, jcUp, close } = await lane();
  try {
    const body = {
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: {
        name: 'acs_read', arguments: { view: 'health' },
        _meta: { acsCapability: { payload: { forged: true }, signature: 'forged', keyId: 'x' }, capability: { forged: true }, progressToken: 'p1' },
      },
    };
    const r = await call(gw.port, '/jc/mcp', jcToken(), body);
    assert.equal(r.status, 200);
    assert.equal(acs.requests.length, 1);
    assert.equal(acs.requests[0].path, '/jc/capability/issue');
    assert.equal(acs.requests[0].auth, 'Bearer jc-bridge-token');
    assert.equal(acs.requests[0].jcActor, 'chatgpt:jacen', 'jc route attributes via x-jc-actor');
    assert.equal(acs.requests[0].actor, undefined, 'jc route never sends x-dc-actor');
    assert.equal(acs.requests[0].body.tool, 'acs_read');
    assert.equal(acs.requests[0].body.argsSummary, JSON.stringify({ view: 'health' }));

    assert.equal(dcUp.requests.length, 0);
    assert.equal(mcpRequests(jcUp).length, 1);
    const forwarded = mcpRequests(jcUp)[0].body;
    assert.equal(forwarded.params._meta.acsCapability.signature, 'acs-sig');
    assert.equal(forwarded.params._meta.acsCapability.payload.forged, undefined);
    assert.equal(forwarded.params._meta.progressToken, 'p1');
    assert.deepEqual(forwarded.params.arguments, { view: 'health' });
  } finally { close(); }
});

test('privileged_exec awaiting human approval fails closed and surfaces the ACS approval challenge', async () => {
  const { gw, jcUp, close } = await lane({
    acsHandler: () => ({
      status: 409,
      body: {
        decision: 'require_approval', workItemId: 'wrk_1', actionHash: 'a'.repeat(64),
        approvalSummary: { runAs: 'root', argv: ['/usr/bin/apt-get', 'update'] },
        approvalInstructions: 'A human must POST /work-items/wrk_1/approve ...',
      },
    }),
  });
  try {
    const r = await call(gw.port, '/jc/mcp', jcToken(), {
      jsonrpc: '2.0', id: 'jc-approval', method: 'tools/call', params: { name: 'privileged_exec', arguments: { argv: ['/usr/bin/apt-get', 'update'] } },
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.id, 'jc-approval');
    assert.equal(body.error.code, -32002);
    assert.match(body.error.message, /approval required/i);
    assert.equal(body.error.data.kind, 'managed_authorization_required');
    assert.equal(body.error.data.acsCode, 'require_approval');
    assert.equal(body.error.data.retryable, true);
    assert.equal(body.error.data.workItemId, 'wrk_1');
    assert.equal(body.error.data.actionHash, 'a'.repeat(64));
    assert.equal(mcpRequests(jcUp).length, 0);
  } finally { close(); }
});

test('ACS unreachable fails closed on the jc lane', async () => {
  const jcUp = recorder(() => ({ status: 200, body: {} }));
  const jcPort = await jcUp.listen();
  const gw = await startGateway({ JC_ENABLED: '1', JC_UPSTREAM: `http://127.0.0.1:${jcPort}`, ACS_GATEWAY_URL: 'http://127.0.0.1:1', ACS_JC_GATEWAY_TOKEN: 'jc-bridge-token' });
  try {
    const r = await call(gw.port, '/jc/mcp', jcToken(), { jsonrpc: '2.0', id: 'jc-unreachable', method: 'tools/call', params: { name: 'jc_status', arguments: {} } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.id, 'jc-unreachable');
    assert.equal(body.error.code, -32003);
    assert.equal(body.error.data.kind, 'managed_authorization_unavailable');
    assert.equal(body.error.data.retryable, true);
    assert.equal(mcpRequests(jcUp).length, 0);
  } finally { gw.child.kill('SIGKILL'); jcUp.server.close(); }
});

test('wrong-audience envelope on the jc route fails closed (acs_capability_wrong_audience)', async () => {
  const { gw, acs, jcUp, close } = await lane({
    acsHandler: (req) => ({
      status: 200,
      body: {
        decision: 'allow',
        capability: { payload: { version: 'acs.dc.v1', audience: 'desktop-commander', toolName: req.body.tool, normalizedArguments: JSON.parse(req.body.argsSummary) }, signature: 'acs-sig', keyId: 'acs-dc-1' },
      },
    }),
  });
  try {
    const r = await call(gw.port, '/jc/mcp', jcToken(), {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'acs_read', arguments: { view: 'health' } },
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.id, 1);
    assert.equal(body.error.code, -32003);
    assert.equal(body.error.data.kind, 'managed_authorization_unavailable');
    assert.equal(body.error.data.acsCode, 'acs_capability_wrong_audience');
    assert.equal(body.error.data.retryable, true);
    assert.equal(acs.requests.length, 1);
    assert.equal(mcpRequests(jcUp).length, 0);
  } finally { close(); }
});

test('JSON-RPC batch containing tools/call is rejected fail-closed on /jc/mcp', async () => {
  const { gw, acs, jcUp, close } = await lane();
  try {
    const batch = [
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'acs_read', arguments: { view: 'health' } } },
    ];
    const r = await call(gw.port, '/jc/mcp', jcToken(), batch);
    assert.equal(r.status, 503);
    assert.equal((await r.json()).code, 'batched_tools_call_rejected');
    assert.equal(acs.requests.length, 0, 'no ACS issuance for a rejected batch');
    assert.equal(mcpRequests(jcUp).length, 0, 'nothing forwarded upstream');
  } finally { close(); }
});

test('JSON-RPC batch without tools/call still proxies on /jc/mcp', async () => {
  const { gw, acs, close } = await lane();
  try {
    const batch = [
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'ping', params: {} },
    ];
    const r = await call(gw.port, '/jc/mcp', jcToken(), batch);
    assert.equal(r.status, 200);
    assert.equal(acs.requests.length, 0);
  } finally { close(); }
});

test('/authority reads the jc bridge from JC_UPSTREAM, not the DC upstream', async () => {
  const authorityFor = (variant) => (req) => (req.path === '/authority'
    ? { status: 200, body: { variant, bridge: { hasUpstreamPair: true } } }
    : { status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } });
  const dcUp = recorder(authorityFor('dc'));
  const jcUp = recorder(authorityFor('jc'));
  const [dcPort, jcPort] = [await dcUp.listen(), await jcUp.listen()];
  const gw = await startGateway({
    UPSTREAM: `http://127.0.0.1:${dcPort}`, JC_ENABLED: '1', JC_UPSTREAM: `http://127.0.0.1:${jcPort}`,
    ACS_GATEWAY_URL: 'http://127.0.0.1:1', ACS_JC_GATEWAY_TOKEN: 'jc-bridge-token',
  });
  try {
    const authority = await (await fetch(`http://127.0.0.1:${gw.port}/authority`)).json();
    assert.equal(authority.bridge.variant, 'dc');
    assert.equal(authority.jcBridge.variant, 'jc');
    const ready = await (await fetch(`http://127.0.0.1:${gw.port}/ready`)).json();
    assert.equal(ready.jcBridgeReady, undefined, '/ready is scoped to the primary lane');
    assert.ok(jcUp.requests.some((r) => r.path === '/authority'), 'jc upstream was queried');
  } finally {
    gw.child.kill('SIGKILL'); dcUp.server.close(); jcUp.server.close();
  }
});

for (const [label, relative] of [['absolute path with spaces', false], ['relative path', true]]) {
  test(`jace-commander bridge runs <JC_DC_DIR>/dist/jace-commander/cli.js serve (${label})`, async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const repo = new URL('..', import.meta.url).pathname;
    // The relative case nests the checkout under the bridge's cwd so a doubled
    // path (cwd + relative script path) cannot resolve by accident.
    const root = fs.mkdtempSync(path.join(relative ? repo : os.tmpdir(), relative ? '.jc-dcdir-test-' : 'jc dcdir '));
    const state = path.join(root, 'state');
    fs.mkdirSync(path.join(root, 'dist/jace-commander'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
    fs.copyFileSync(new URL('./stub-jc.mjs', import.meta.url), path.join(root, 'dist/jace-commander/cli.js'));
    const port = nextPort++;
    const bridge = spawn(process.execPath, ['bridge.js'], {
      cwd: repo,
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME, BRIDGE_PROFILE: 'jace-commander', BRIDGE_PORT: String(port),
        ACS_MANAGED_MODE: '1', DC_CMD: process.execPath, JC_DC_DIR: relative ? path.relative(repo, root) : root,
        JC_ACS_PUBLIC_KEY: 'k', JC_ACS_KEY_ID: 'i', JC_RUNTIME_ID: 'jc-test', JC_STATE_DIR: state,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    bridge.stderr.on('data', (d) => { stderr += d; });
    try {
      const argvFile = path.join(state, 'argv.json');
      for (let i = 0; i < 50 && !fs.existsSync(argvFile); i += 1) await new Promise((r) => setTimeout(r, 100));
      assert.ok(fs.existsSync(argvFile), `child from JC_DC_DIR never started: ${stderr}`);
      assert.deepEqual(JSON.parse(fs.readFileSync(argvFile, 'utf8')).argv, ['serve']);
    } finally {
      bridge.kill('SIGKILL');
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('/jc/mcp refuses to issue or forward when JC_UPSTREAM is not the jc bridge', async () => {
  const { gw, acs, dcUp, jcUp, close } = await lane({ jcVariant: 'dc' });
  try {
    const r = await call(gw.port, '/jc/mcp', jcToken(), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'jc_status', arguments: {} } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.id, 1);
    assert.equal(body.error.code, -32003);
    assert.equal(body.error.data.kind, 'managed_authorization_unavailable');
    assert.equal(body.error.data.acsCode, 'jc_bridge_mismatch');
    assert.equal(body.error.data.retryable, true);
    assert.equal(acs.requests.length, 0, 'no capability issued');
    assert.equal(mcpRequests(jcUp).length, 0, 'nothing forwarded');
    assert.equal(dcUp.requests.length, 0);
  } finally {
    close();
  }
});

test('jc lane refuses to start when JC_RESOURCE equals RESOURCE', async () => {
  const gw = await startGateway({ JC_ENABLED: '1', ACS_GATEWAY_URL: 'http://127.0.0.1:1', ACS_JC_GATEWAY_TOKEN: 'jc-bridge-token', JC_RESOURCE: `${ORIGIN}/mcp` });
  if (gw.exitCode === undefined) gw.child.kill('SIGKILL');
  assert.notEqual(gw.exitCode, undefined, 'gateway must not start');
  assert.match(typeof gw.stderr === 'function' ? gw.stderr() : gw.stderr, /JC_RESOURCE must differ from RESOURCE/);
});

test('jc lane refuses to start when JC_ISSUER equals ISSUER', async () => {
  const gw = await startGateway({ JC_ENABLED: '1', ACS_GATEWAY_URL: 'http://127.0.0.1:1', ACS_JC_GATEWAY_TOKEN: 'jc-bridge-token', JC_ISSUER: ORIGIN });
  if (gw.exitCode === undefined) gw.child.kill('SIGKILL');
  assert.notEqual(gw.exitCode, undefined, 'gateway must not start');
  assert.match(typeof gw.stderr === 'function' ? gw.stderr() : gw.stderr, /JC_ISSUER must differ from ISSUER/);
});

test('with the jc lane on, /mcp refuses a UPSTREAM that is the jc bridge (swapped upstreams)', async () => {
  const acs = recorder(() => ({ status: 200, body: { decision: 'allow' } }));
  const swapped = recorder((req) => (req.path === '/authority'
    ? { status: 200, body: { variant: 'jc', bridge: { hasUpstreamPair: true } } }
    : { status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } }));
  const [acsPort, upPort] = [await acs.listen(), await swapped.listen()];
  const gw = await startGateway({
    ACS_MANAGED_MODE: '1', ACS_GATEWAY_URL: `http://127.0.0.1:${acsPort}`, ACS_GATEWAY_TOKEN: 'dc-bridge-token',
    JC_ENABLED: '1', ACS_JC_GATEWAY_TOKEN: 'jc-bridge-token',
    UPSTREAM: `http://127.0.0.1:${upPort}`, JC_UPSTREAM: `http://127.0.0.1:${upPort}`,
  });
  try {
    assert.equal(gw.exitCode, undefined, 'gateway failed to start');
    const r = await call(gw.port, '/mcp', token(`${ORIGIN}/mcp`), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'start_process', arguments: { command: 'ls' } } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.id, 1);
    assert.equal(body.error.code, -32003);
    assert.equal(body.error.data.kind, 'managed_authorization_unavailable');
    assert.equal(body.error.data.acsCode, 'dc_bridge_mismatch');
    assert.equal(body.error.data.retryable, true);
    assert.equal(acs.requests.filter((q) => q.path === '/dc/capability/issue').length, 0, 'no DC capability issued');
    assert.equal(mcpRequests(swapped).length, 0, 'nothing forwarded');
    const ready = await (await fetch(`http://127.0.0.1:${gw.port}/ready`)).json();
    assert.equal(ready.bridgeReady, false);
  } finally {
    gw.child.kill('SIGKILL'); acs.server.close(); swapped.server.close();
  }
});

test('/ready is not delayed by an unresponsive jc bridge', async () => {
  const dcUp = recorder((req) => (req.path === '/authority'
    ? { status: 200, body: { variant: 'dc', bridge: { hasUpstreamPair: true } } }
    : { status: 200, body: {} }));
  // Accepts connections but never answers.
  const hung = http.createServer(() => {});
  const [dcPort, hungPort] = [await dcUp.listen(), await new Promise((r) => hung.listen(0, '127.0.0.1', () => r(hung.address().port)))];
  const gw = await startGateway({
    UPSTREAM: `http://127.0.0.1:${dcPort}`, JC_ENABLED: '1', JC_UPSTREAM: `http://127.0.0.1:${hungPort}`,
    ACS_GATEWAY_URL: 'http://127.0.0.1:1', ACS_JC_GATEWAY_TOKEN: 'jc-bridge-token',
  });
  try {
    const started = Date.now();
    const ready = await (await fetch(`http://127.0.0.1:${gw.port}/ready`)).json();
    const elapsed = Date.now() - started;
    assert.equal(ready.bridgeReady, true);
    assert.equal(ready.jcBridgeReady, undefined, 'jc bridge is not probed by /ready');
    assert.ok(elapsed < 1500, `/ready took ${elapsed}ms`);
  } finally {
    gw.child.kill('SIGKILL'); dcUp.server.close(); hung.closeAllConnections?.(); hung.close();
  }
});
