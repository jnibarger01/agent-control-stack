#!/usr/bin/env node
/**
 * Integration tests for Jace CLI Auth V2 in dc-mcp-gateway (server.js + public-edge-proxy.js):
 *  - jace-commander-cli static client policy, loopback PKCE + DPoP binding, iss validation
 *  - DPoP-Nonce challenge/retry on /token, /jc/oauth/token, /jc/mcp, /jc/devices
 *  - No Bearer downgrade for DPoP-bound tokens, htu ignores spoofed Host/X-Forwarded-*
 *  - Persistent jti replay protection across gateway restarts
 *  - Refresh rotation with refresh_request_id + AES-256-GCM recovery + family replay revocation
 *  - RFC 8628 device flow (/jc/oauth/device/code, /jc/device, /jc/oauth/token)
 *  - Device management (/jc/devices, /jc/devices/:id/revoke, DELETE /jc/devices/:id)
 *  - Compatibility: ChatGPT / Claude Bearer + CIMD untouched, secret redaction in logs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createPublicIngress } from '../public-edge-proxy.js';
import { allowedPublicRoute } from '../public-edge-policy.js';

const KEY = 'k'.repeat(32);
const ORIGIN = 'https://gw.test';
const JC_RESOURCE = `${ORIGIN}/jc/mcp`;
const JC_ISSUER = `${ORIGIN}/jc`;
const PASS = 'test-pass-phrase';
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: b64u(crypto.createHash('sha256').update(verifier).digest()) };
};

function genKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  const jkt = b64u(crypto.createHash('sha256').update(canonical).digest());
  return { publicKey, privateKey, jwk, jkt };
}

function makeDpopProof(kp, { htm, htu, accessToken, nonce, jti = crypto.randomBytes(16).toString('base64url'), iat = Math.floor(Date.now() / 1000) }) {
  const h = b64u(JSON.stringify({ alg: 'EdDSA', typ: 'dpop+jwt', jwk: kp.jwk }));
  const payload = {
    jti,
    htm,
    htu,
    iat,
    ...(nonce ? { nonce } : {}),
    ...(accessToken ? { ath: b64u(crypto.createHash('sha256').update(accessToken, 'ascii').digest()) } : {}),
  };
  const p = b64u(JSON.stringify(payload));
  const sig = crypto.sign(null, Buffer.from(`${h}.${p}`, 'ascii'), kp.privateKey);
  return `${h}.${p}.${b64u(sig)}`;
}

function stubServer(handler) {
  const server = http.createServer(handler);
  return { server, listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))) };
}

let nextPort = 19600;
async function bootGateway({ dir, extraEnv = {}, extraClients = {} } = {}) {
  const acs = stubServer((req, res) => {
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ recorded: true }));
  });
  const jcUp = stubServer((req, res) => {
    if (req.url === '/authority') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ variant: 'jc' }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
  });
  const dcUp = stubServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
  });
  const [acsPort, jcPort, dcPort] = [await acs.listen(), await jcUp.listen(), await dcUp.listen()];
  const port = nextPort++;
  const ownedDir = !dir;
  const dataDir = dir || fs.mkdtempSync(path.join(os.tmpdir(), `jca2-gw-${port}-`));
  if (ownedDir) {
    fs.writeFileSync(path.join(dataDir, 'clients.json'), JSON.stringify({
      'legacy-public': {
        client_name: 'legacy',
        redirect_uris: ['https://app.test/cb'],
        token_endpoint_auth_method: 'none',
        oauth_lane: 'jc',
        scope: 'mcp',
      },
      ...extraClients,
    }));
    fs.writeFileSync(path.join(dataDir, 'tokens.json'), '{}');
  }

  let child;
  let output = '';
  const start = async () => {
    child = spawn(process.execPath, ['server.js'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: {
        PATH: process.env.PATH,
        GATEWAY_PORT: String(port),
        PUBLIC_ORIGIN: ORIGIN,
        CONSENT_PASSPHRASE: PASS,
        SIGNING_KEY: KEY,
        DATA_DIR: dataDir,
        UPSTREAM: `http://127.0.0.1:${dcPort}`,
        JC_ENABLED: '1',
        JC_UPSTREAM: `http://127.0.0.1:${jcPort}`,
        ACS_GATEWAY_URL: `http://127.0.0.1:${acsPort}`,
        ACS_JC_GATEWAY_TOKEN: 'jc-bridge-token',
        EDGE_TEST_MODE: '1',
        EDGE_TEST_DEVICE_INTERVAL_S: '1',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    let up = false;
    for (let i = 0; i < 60 && !up; i += 1) {
      if (child.exitCode !== null) break;
      try { up = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch { await new Promise((r) => setTimeout(r, 50)); }
    }
    assert.ok(up, `gateway failed to start: ${output}`);
  };
  await start();
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    dataDir,
    output: () => output,
    restart: async () => {
      child.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 100));
      await start();
    },
    close: () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      acs.server.close();
      jcUp.server.close();
      dcUp.server.close();
      if (ownedDir) fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function dpopTokenPost(base, endpointPath, kp, fields, initialNonce) {
  const url = `${base}${endpointPath}`;
  const htu = `${ORIGIN}${endpointPath.split('?')[0]}`;
  let nonce = initialNonce;
  let res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      DPoP: makeDpopProof(kp, { htm: 'POST', htu, nonce }),
    },
    body: new URLSearchParams(fields).toString(),
  });
  if (res.status === 400) {
    const body = await res.clone().json().catch(() => ({}));
    if (body.error === 'use_dpop_nonce') {
      nonce = res.headers.get('dpop-nonce');
      assert.ok(nonce, '400 use_dpop_nonce must carry DPoP-Nonce header');
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          DPoP: makeDpopProof(kp, { htm: 'POST', htu, nonce }),
        },
        body: new URLSearchParams(fields).toString(),
      });
    }
  }
  return { res, nextNonce: res.headers.get('dpop-nonce') || nonce };
}

async function loginCliAuthCode(gw, kp, { label = 'dev-laptop' } = {}) {
  const { verifier, challenge } = pkce();
  const redirect = 'http://127.0.0.1:43210/callback';
  const authQ = new URLSearchParams({
    oauth_lane: 'jc',
    resource: JC_RESOURCE,
    client_id: 'jace-commander-cli',
    redirect_uri: redirect,
    response_type: 'code',
    scope: 'mcp',
    state: 'st-123',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    dpop_jkt: kp.jkt,
  });
  const authRes = await fetch(`${gw.base}/authorize?${authQ.toString()}`, { redirect: 'manual' });
  assert.equal(authRes.status, 200);
  const consentRes = await fetch(`${gw.base}/authorize/consent`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
    body: new URLSearchParams({
      client_id: 'jace-commander-cli',
      redirect_uri: redirect,
      response_type: 'code',
      scope: 'mcp',
      state: 'st-123',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: JC_RESOURCE,
      dpop_jkt: kp.jkt,
      passphrase: PASS,
    }).toString(),
  });
  assert.equal(consentRes.status, 302);
  const loc = new URL(consentRes.headers.get('location'));
  assert.equal(loc.searchParams.get('iss'), JC_ISSUER);
  assert.equal(loc.searchParams.get('state'), 'st-123');
  const code = loc.searchParams.get('code');
  assert.ok(code);

  const { res, nextNonce } = await dpopTokenPost(gw.base, '/token?oauth_lane=jc', kp, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: redirect,
    client_id: 'jace-commander-cli',
    resource: JC_RESOURCE,
    device_name: label,
  });
  assert.equal(res.status, 200, await res.clone().text());
  const tok = await res.json();
  assert.equal(tok.token_type, 'DPoP');
  assert.equal(tok.expires_in, 600);
  assert.ok(tok.device_id);
  return { tok, nonce: nextNonce };
}

test('AS metadata advertises DPoP algorithms and device_authorization_endpoint; edge policy allows new JC routes', async () => {
  const gw = await bootGateway();
  try {
    const meta = await (await fetch(`${gw.base}/jc/.well-known/oauth-authorization-server`)).json();
    assert.deepEqual(meta.dpop_signing_alg_values_supported, ['EdDSA', 'ES256']);
    assert.equal(meta.device_authorization_endpoint, `${ORIGIN}/jc/oauth/device/code`);

    assert.equal(allowedPublicRoute('POST', '/jc/oauth/device/code', '', JC_RESOURCE), true);
    assert.equal(allowedPublicRoute('GET', '/jc/device', '', JC_RESOURCE), true);
    assert.equal(allowedPublicRoute('GET', '/jc/device?user_code=ABCD-EFGH', '', JC_RESOURCE), true);
    assert.equal(allowedPublicRoute('POST', '/jc/device', 'user_code=ABCD-EFGH&passphrase=x', JC_RESOURCE), true);
    assert.equal(allowedPublicRoute('POST', '/jc/oauth/token', '', JC_RESOURCE), true);
    assert.equal(allowedPublicRoute('GET', '/jc/devices', '', JC_RESOURCE), true);
    assert.equal(allowedPublicRoute('POST', '/jc/devices/dev_123/revoke', '', JC_RESOURCE), true);
    assert.equal(allowedPublicRoute('DELETE', '/jc/devices/dev_123', '', JC_RESOURCE), true);
    assert.equal(allowedPublicRoute('GET', '/jc/ready', '', JC_RESOURCE), false);
    assert.equal(allowedPublicRoute('GET', '/mcp', '', JC_RESOURCE), false);
  } finally { gw.close(); }
});

test('jace-commander-cli policy enforces loopback, state, S256, jc lane, dpop_jkt match, and no Bearer downgrade', async () => {
  const gw = await bootGateway();
  try {
    const { challenge, verifier } = pkce();
    const kp = genKeypair();
    const otherKp = genKeypair();

    // Non-loopback redirect refused
    const badRedir = await fetch(`${gw.base}/authorize?${new URLSearchParams({
      oauth_lane: 'jc', resource: JC_RESOURCE, client_id: 'jace-commander-cli',
      redirect_uri: 'https://evil.example/cb', response_type: 'code', scope: 'mcp',
      state: 's1', code_challenge: challenge, code_challenge_method: 'S256',
    })}`, { redirect: 'manual' });
    assert.equal(badRedir.status, 400);

    // DC lane /mcp refused for jace-commander-cli
    const dcLane = await fetch(`${gw.base}/authorize?${new URLSearchParams({
      resource: `${ORIGIN}/mcp`, client_id: 'jace-commander-cli',
      redirect_uri: 'http://127.0.0.1:41111/callback', response_type: 'code', scope: 'mcp',
      state: 's1', code_challenge: challenge, code_challenge_method: 'S256',
    })}`, { redirect: 'manual' });
    assert.equal(dcLane.status, 302);
    assert.equal(new URL(dcLane.headers.get('location')).searchParams.get('error'), 'invalid_target');

    // Missing state refused
    const noState = await fetch(`${gw.base}/authorize?${new URLSearchParams({
      oauth_lane: 'jc', resource: JC_RESOURCE, client_id: 'jace-commander-cli',
      redirect_uri: 'http://127.0.0.1:41111/callback', response_type: 'code', scope: 'mcp',
      code_challenge: challenge, code_challenge_method: 'S256',
    })}`, { redirect: 'manual' });
    assert.equal(noState.status, 302);
    assert.equal(new URL(noState.headers.get('location')).searchParams.get('error'), 'invalid_request');

    // dpop_jkt mismatch at /token rejected
    const consent = await fetch(`${gw.base}/authorize/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
      body: new URLSearchParams({
        client_id: 'jace-commander-cli', redirect_uri: 'http://[::1]:41112/callback',
        response_type: 'code', scope: 'mcp', state: 's2',
        code_challenge: challenge, code_challenge_method: 'S256',
        resource: JC_RESOURCE, dpop_jkt: kp.jkt, passphrase: PASS,
      }).toString(),
    });
    assert.equal(consent.status, 302);
    const code = new URL(consent.headers.get('location')).searchParams.get('code');

    const { res: mismatchRes } = await dpopTokenPost(gw.base, '/token?oauth_lane=jc', otherKp, {
      grant_type: 'authorization_code', code, code_verifier: verifier,
      redirect_uri: 'http://[::1]:41112/callback', client_id: 'jace-commander-cli', resource: JC_RESOURCE,
    });
    assert.equal(mismatchRes.status, 400);

    // Valid login succeeds and enforces DPoP on /jc/mcp (Bearer rejected, spoofed Host/X-Forwarded-Host ignored)
    const { tok, nonce } = await loginCliAuthCode(gw, kp);
    const bearerAttempt = await fetch(`${gw.base}/jc/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    assert.equal(bearerAttempt.status, 401);
    assert.match(bearerAttempt.headers.get('www-authenticate'), /^DPoP /);

    // Unauthenticated probe carrying a DPoP header returns DPoP-Nonce + DPoP challenge
    const dpopProbe = await fetch(`${gw.base}/jc/mcp`, {
      method: 'POST',
      headers: { DPoP: makeDpopProof(kp, { htm: 'POST', htu: JC_RESOURCE }) },
    });
    assert.equal(dpopProbe.status, 401);
    assert.ok(dpopProbe.headers.get('dpop-nonce'));
    assert.match(dpopProbe.headers.get('www-authenticate'), /^DPoP /);

    // Proof signed for spoofed Host header must be rejected
    const spoofedProof = makeDpopProof(kp, { htm: 'POST', htu: 'https://evil.test/jc/mcp', accessToken: tok.access_token, nonce });
    const spoofedRes = await fetch(`${gw.base}/jc/mcp`, {
      method: 'POST',
      headers: {
        authorization: `DPoP ${tok.access_token}`,
        DPoP: spoofedProof,
        'x-forwarded-host': 'evil.test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    assert.equal(spoofedRes.status, 401);

    // Valid DPoP call succeeds, and replay of the exact same proof fails even after restart
    const jti = crypto.randomBytes(16).toString('base64url');
    const goodProof = makeDpopProof(kp, { htm: 'POST', htu: JC_RESOURCE, accessToken: tok.access_token, nonce, jti });
    const ok = await fetch(`${gw.base}/jc/mcp`, {
      method: 'POST',
      headers: { authorization: `DPoP ${tok.access_token}`, DPoP: goodProof, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    assert.equal(ok.status, 200);

    await gw.restart();

    const replayAfterRestart = await fetch(`${gw.base}/jc/mcp`, {
      method: 'POST',
      headers: { authorization: `DPoP ${tok.access_token}`, DPoP: goodProof, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    assert.equal(replayAfterRestart.status, 401);

    // Logs must never leak secrets
    const logs = gw.output();
    for (const secret of [tok.access_token, tok.refresh_token, PASS, goodProof]) {
      assert.ok(!logs.includes(secret), 'secret leaked into gateway logs');
    }
  } finally { gw.close(); }
});

test('refresh_request_id crash recovery returns exact same successor, while replay with new id revokes family', async () => {
  const gw = await bootGateway();
  try {
    const kp = genKeypair();
    const { tok, nonce } = await loginCliAuthCode(gw, kp);
    const reqId1 = crypto.randomUUID();

    // First refresh succeeds
    const r1 = await dpopTokenPost(gw.base, '/token?oauth_lane=jc', kp, {
      grant_type: 'refresh_token',
      refresh_token: tok.refresh_token,
      client_id: 'jace-commander-cli',
      resource: JC_RESOURCE,
      refresh_request_id: reqId1,
    }, nonce);
    assert.equal(r1.res.status, 200);
    const body1 = await r1.res.json();
    assert.notEqual(body1.refresh_token, tok.refresh_token);

    // Ensure recovery blob in gateway.db does NOT store plaintext access_token or refresh_token
    const db = new DatabaseSync(path.join(gw.dataDir, 'gateway.db'), { readOnly: true });
    const rows = db.prepare('SELECT recovery_blob FROM jc_refresh_tokens WHERE recovery_blob IS NOT NULL').all();
    db.close();
    assert.equal(rows.length, 1);
    assert.ok(!rows[0].recovery_blob.includes(body1.access_token), 'recovery_blob must be encrypted');
    assert.ok(!rows[0].recovery_blob.includes(body1.refresh_token), 'recovery_blob must be encrypted');

    // Crash recovery retry with SAME refresh_request_id returns exact same successor
    const r1Retry = await dpopTokenPost(gw.base, '/token?oauth_lane=jc', kp, {
      grant_type: 'refresh_token',
      refresh_token: tok.refresh_token,
      client_id: 'jace-commander-cli',
      resource: JC_RESOURCE,
      refresh_request_id: reqId1,
    }, r1.nextNonce);
    assert.equal(r1Retry.res.status, 200);
    const bodyRetry = await r1Retry.res.json();
    assert.deepEqual(bodyRetry, body1);

    // Replay with DIFFERENT refresh_request_id revokes entire family
    const rReuse = await dpopTokenPost(gw.base, '/token?oauth_lane=jc', kp, {
      grant_type: 'refresh_token',
      refresh_token: tok.refresh_token,
      client_id: 'jace-commander-cli',
      resource: JC_RESOURCE,
      refresh_request_id: crypto.randomUUID(),
    }, r1Retry.nextNonce);
    assert.equal(rReuse.res.status, 400);
    assert.equal((await rReuse.res.json()).error_description, 'refresh_reused');

    // Successor is now revoked too
    const rSuccessor = await dpopTokenPost(gw.base, '/token?oauth_lane=jc', kp, {
      grant_type: 'refresh_token',
      refresh_token: body1.refresh_token,
      client_id: 'jace-commander-cli',
      resource: JC_RESOURCE,
      refresh_request_id: crypto.randomUUID(),
    }, rReuse.nextNonce);
    assert.equal(rSuccessor.res.status, 400);
  } finally { gw.close(); }
});

test('RFC 8628 headless device flow + /jc/devices listing and per-device revocation', async () => {
  const gw = await bootGateway();
  try {
    const kp1 = genKeypair();
    const kp2 = genKeypair();

    // Start device flow for kp1
    const dcRes = await fetch(`${gw.base}/jc/oauth/device/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: 'jace-commander-cli',
        scope: 'mcp',
        dpop_jkt: kp1.jkt,
        device_name: 'headless-box',
      }).toString(),
    });
    assert.equal(dcRes.status, 200);
    const dc = await dcRes.json();
    assert.ok(dc.device_code && dc.user_code && dc.verification_uri && dc.verification_uri_complete);

    // Poll before approval -> authorization_pending
    const p1 = await dpopTokenPost(gw.base, '/jc/oauth/token', kp1, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: dc.device_code,
      client_id: 'jace-commander-cli',
    });
    assert.equal(p1.res.status, 400);
    assert.equal((await p1.res.json()).error, 'authorization_pending');

    // Separate device code to verify slow_down and access_denied without delaying kp1's 1s interval
    const dcDenyRes = await fetch(`${gw.base}/jc/oauth/device/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: 'jace-commander-cli', scope: 'mcp', dpop_jkt: kp1.jkt }).toString(),
    });
    assert.equal(dcDenyRes.status, 200);
    const dcDeny = await dcDenyRes.json();
    const sd1 = await dpopTokenPost(gw.base, '/jc/oauth/token', kp1, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: dcDeny.device_code,
      client_id: 'jace-commander-cli',
    }, p1.nextNonce);
    assert.equal((await sd1.res.json()).error, 'authorization_pending');
    const sd2 = await dpopTokenPost(gw.base, '/jc/oauth/token', kp1, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: dcDeny.device_code,
      client_id: 'jace-commander-cli',
    }, sd1.nextNonce);
    const sd2Body = await sd2.res.json();
    assert.equal(sd2Body.error, 'slow_down');
    assert.equal(sd2Body.interval, 6);

    // Deny dcDeny on /jc/device -> immediate poll returns access_denied even after slow_down
    const denySubmit = await fetch(`${gw.base}/jc/device`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user_code: dcDeny.user_code, passphrase: PASS, action: 'deny' }).toString(),
    });
    assert.equal(denySubmit.status, 200);
    const deniedPoll = await dpopTokenPost(gw.base, '/jc/oauth/token', kp1, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: dcDeny.device_code,
      client_id: 'jace-commander-cli',
    }, sd2.nextNonce);
    assert.equal(deniedPoll.res.status, 400);
    assert.equal((await deniedPoll.res.json()).error, 'access_denied');

    // Invalid/missing decision on /jc/device must fail closed (400), never approve
    const invalidDecision = await fetch(`${gw.base}/jc/device`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user_code: dc.user_code, passphrase: PASS, action: 'bogus' }).toString(),
    });
    assert.equal(invalidDecision.status, 400);

    // Wrong passphrase on /jc/device -> 401
    const badApprove = await fetch(`${gw.base}/jc/device`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user_code: dc.user_code, passphrase: 'wrong', decision: 'approve' }).toString(),
    });
    assert.equal(badApprove.status, 401);

    // Correct passphrase approves once; second submit rejected
    const approve = await fetch(`${gw.base}/jc/device`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user_code: dc.user_code, passphrase: PASS, decision: 'approve' }).toString(),
    });
    assert.equal(approve.status, 200);
    const approveAgain = await fetch(`${gw.base}/jc/device`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user_code: dc.user_code, passphrase: PASS, decision: 'approve' }).toString(),
    });
    assert.equal(approveAgain.status, 400);

    // Wait >1s (interval=1 for dc), then poll with wrong keypair -> rejected; then poll with kp1 -> 200
    await new Promise((r) => setTimeout(r, 1100));
    const wrongKpPoll = await dpopTokenPost(gw.base, '/jc/oauth/token', kp2, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: dc.device_code,
      client_id: 'jace-commander-cli',
    }, sd2.nextNonce);
    assert.equal(wrongKpPoll.res.status, 400);

    await new Promise((r) => setTimeout(r, 1100));
    const pApproved = await dpopTokenPost(gw.base, '/jc/oauth/token', kp1, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: dc.device_code,
      client_id: 'jace-commander-cli',
    }, wrongKpPoll.nextNonce);
    assert.equal(pApproved.res.status, 200, await pApproved.res.clone().text());
    const tok1 = await pApproved.res.json();
    assert.equal(tok1.token_type, 'DPoP');
    assert.ok(tok1.device_id);

    // Device code is single-use
    const pReplay = await dpopTokenPost(gw.base, '/jc/oauth/token', kp1, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: dc.device_code,
      client_id: 'jace-commander-cli',
    }, pApproved.nextNonce);
    assert.equal(pReplay.res.status, 400);

    // Login second device via auth_code
    const { tok: tok2, nonce: n2 } = await loginCliAuthCode(gw, kp2, { label: 'laptop-2' });

    // List devices using device 2
    const listRes = await fetch(`${gw.base}/jc/devices`, {
      headers: {
        authorization: `DPoP ${tok2.access_token}`,
        DPoP: makeDpopProof(kp2, { htm: 'GET', htu: `${ORIGIN}/jc/devices`, accessToken: tok2.access_token, nonce: n2 }),
      },
    });
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json();
    assert.equal(listBody.devices.length, 2);
    const n2b = listRes.headers.get('dpop-nonce');

    // Revoke device 1 using device 2
    const revRes = await fetch(`${gw.base}/jc/devices/${tok1.device_id}/revoke`, {
      method: 'POST',
      headers: {
        authorization: `DPoP ${tok2.access_token}`,
        DPoP: makeDpopProof(kp2, { htm: 'POST', htu: `${ORIGIN}/jc/devices/${tok1.device_id}/revoke`, accessToken: tok2.access_token, nonce: n2b }),
      },
    });
    assert.equal(revRes.status, 200);
    assert.deepEqual(await revRes.json(), { revoked: true, device_id: tok1.device_id });

    // Device 1's access token is immediately rejected on /jc/mcp
    const revokedMcp = await fetch(`${gw.base}/jc/mcp`, {
      method: 'POST',
      headers: {
        authorization: `DPoP ${tok1.access_token}`,
        DPoP: makeDpopProof(kp1, { htm: 'POST', htu: JC_RESOURCE, accessToken: tok1.access_token, nonce: pApproved.nextNonce }),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    assert.equal(revokedMcp.status, 401);

    // Device 2 still works!
    const n2c = revRes.headers.get('dpop-nonce');
    const ok2 = await fetch(`${gw.base}/jc/mcp`, {
      method: 'POST',
      headers: {
        authorization: `DPoP ${tok2.access_token}`,
        DPoP: makeDpopProof(kp2, { htm: 'POST', htu: JC_RESOURCE, accessToken: tok2.access_token, nonce: n2c }),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    assert.equal(ok2.status, 200);

    // Re-enrolling a revoked device keypair (kp1) fails closed
    const dcRevokedRes = await fetch(`${gw.base}/jc/oauth/device/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: 'jace-commander-cli', scope: 'mcp', dpop_jkt: kp1.jkt }).toString(),
    });
    const dcRev = await dcRevokedRes.json();
    await fetch(`${gw.base}/jc/device`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user_code: dcRev.user_code, passphrase: PASS, decision: 'approve' }).toString(),
    });
    const pollRevokedKey = await dpopTokenPost(gw.base, '/jc/oauth/token', kp1, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: dcRev.device_code,
      client_id: 'jace-commander-cli',
    });
    assert.equal(pollRevokedKey.res.status, 400);
  } finally { gw.close(); }
});

test('recovery TTL expiration, inactivity TTL expiration, device_code expiry, and public-edge-proxy forwarding', async () => {
  const gw = await bootGateway({
    extraEnv: {
      EDGE_TEST_RECOVERY_TTL_S: '1',
      EDGE_TEST_INACTIVITY_TTL_S: '2',
      EDGE_TEST_DEVICE_CODE_TTL_S: '1',
    },
  });
  const upstreamPort = Number(new URL(gw.base).port);
  const pubServer = createPublicIngress({ upstreamPort, jcResource: JC_RESOURCE });
  const pubPort = await new Promise((r) => pubServer.listen(0, '127.0.0.1', () => r(pubServer.address().port)));
  const pubBase = `http://127.0.0.1:${pubPort}`;
  try {
    const kp = genKeypair();

    // Public edge proxy allows device code + GET /jc/device
    const dcRes = await fetch(`${pubBase}/jc/oauth/device/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: 'jace-commander-cli', scope: 'mcp', dpop_jkt: kp.jkt }).toString(),
    });
    assert.equal(dcRes.status, 200);
    const dc = await dcRes.json();
    const page = await fetch(`${pubBase}/jc/device?user_code=${encodeURIComponent(dc.user_code)}`);
    assert.equal(page.status, 200);

    // Wait >2s so integer-second TTL=1 strictly expires -> expired_token
    await new Promise((r) => setTimeout(r, 2100));
    const expPoll = await dpopTokenPost(pubBase, '/jc/oauth/token', kp, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: dc.device_code,
      client_id: 'jace-commander-cli',
    });
    assert.equal(expPoll.res.status, 400);
    assert.equal((await expPoll.res.json()).error, 'expired_token');

    // Login via auth_code, refresh with reqId, let recovery window expire (1s) -> reuse revokes family
    const { tok, nonce } = await loginCliAuthCode(gw, kp);
    const reqId = crypto.randomUUID();
    const r1 = await dpopTokenPost(pubBase, '/token?oauth_lane=jc&resource=' + encodeURIComponent(JC_RESOURCE), kp, {
      grant_type: 'refresh_token',
      refresh_token: tok.refresh_token,
      client_id: 'jace-commander-cli',
      resource: JC_RESOURCE,
      refresh_request_id: reqId,
    }, nonce);
    assert.equal(r1.res.status, 200);
    const r1Body = await r1.res.json();

    await new Promise((r) => setTimeout(r, 2100));
    const rLate = await dpopTokenPost(pubBase, '/token?oauth_lane=jc&resource=' + encodeURIComponent(JC_RESOURCE), kp, {
      grant_type: 'refresh_token',
      refresh_token: tok.refresh_token,
      client_id: 'jace-commander-cli',
      resource: JC_RESOURCE,
      refresh_request_id: reqId,
    }, r1.nextNonce);
    assert.equal(rLate.res.status, 400);
    assert.equal((await rLate.res.json()).error_description, 'refresh_reused');

    // Successor also revoked
    const rSucc = await dpopTokenPost(pubBase, '/token?oauth_lane=jc&resource=' + encodeURIComponent(JC_RESOURCE), kp, {
      grant_type: 'refresh_token',
      refresh_token: r1Body.refresh_token,
      client_id: 'jace-commander-cli',
      resource: JC_RESOURCE,
      refresh_request_id: crypto.randomUUID(),
    }, rLate.nextNonce);
    assert.equal(rSucc.res.status, 400);

    // Second login -> wait >3s inactivity TTL=2 -> refresh fails as expired
    const kp2 = genKeypair();
    const { tok: tok2, nonce: n2 } = await loginCliAuthCode(gw, kp2);
    await new Promise((r) => setTimeout(r, 3100));
    const idleRes = await dpopTokenPost(pubBase, '/token?oauth_lane=jc&resource=' + encodeURIComponent(JC_RESOURCE), kp2, {
      grant_type: 'refresh_token',
      refresh_token: tok2.refresh_token,
      client_id: 'jace-commander-cli',
      resource: JC_RESOURCE,
      refresh_request_id: crypto.randomUUID(),
    }, n2);
    assert.equal(idleRes.res.status, 400);
  } finally {
    await new Promise((r) => pubServer.close(r));
    gw.close();
  }
});
