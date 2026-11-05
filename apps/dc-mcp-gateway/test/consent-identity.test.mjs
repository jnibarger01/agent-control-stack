#!/usr/bin/env node
/**
 * P0 consent transaction and per-client JC identity.
 *
 * The consent page must show the client and the exact redirect destination, and the
 * authorization code must be minted only from a server-side transaction. A JC access
 * token's subject is bound to that client. Desktop Commander tokens keep the owner subject.
 *
 * Run: node --test test/consent-identity.test.mjs
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
const DC_RESOURCE = `${ORIGIN}/mcp`;
const PASS = 'consent-test-pass-1';
const WRONG_PASS = 'not-the-passphrase';

const jcSubject = (clientId) => `jc-client:${crypto.createHash('sha256').update(clientId).digest('hex')}`;
const jcActor = (clientId) => `chatgpt:${jcSubject(clientId)}`;
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: b64u(crypto.createHash('sha256').update(verifier).digest()) };
};
const claimsOf = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));

function hiddenFields(html) {
  const fields = {};
  for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)) {
    fields[match[1]] = match[2]
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }
  return fields;
}

function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function recorder(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const entry = {
        path: req.url,
        auth: req.headers.authorization,
        actor: req.headers['x-dc-actor'],
        jcActor: req.headers['x-jc-actor'],
        body: text ? JSON.parse(text) : null,
      };
      requests.push(entry);
      const { status, body } = handler(entry);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  return { server, requests, listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))) };
}

let nextPort = 21140;
async function boot() {
  const acs = recorder((req) => (req.path === '/jc/capability/issue'
    ? {
      status: 200,
      body: {
        decision: 'allow',
        capability: {
          payload: { version: 'acs.jc.v1', audience: 'jace-commander', toolName: req.body.tool, normalizedArguments: JSON.parse(req.body.argsSummary) },
          signature: 'acs-sig',
          keyId: 'acs-jc-1',
        },
        claimActionHash: 'claim',
        inputHash: 'input',
        workerId: 'acs-jc-bridge',
      },
    }
    : { status: 202, body: { recorded: true } }));
  const upstream = recorder((req) => (req.path === '/authority'
    ? { status: 200, body: { variant: 'jc' } }
    : { status: 200, body: { jsonrpc: '2.0', id: 1, result: { ok: true } } }));
  const [acsPort, upPort] = [await acs.listen(), await upstream.listen()];
  const port = nextPort++;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `consent-identity-${port}-`));
  fs.writeFileSync(path.join(dir, 'clients.json'), JSON.stringify({
    'jc-one': {
      client_name: 'Trusted App',
      redirect_uris: ['https://app.test/cb', 'https://app.test/other'],
      token_endpoint_auth_method: 'none',
      oauth_lane: 'jc',
      scope: 'mcp',
    },
    'jc-two': {
      client_name: 'Other App',
      redirect_uris: ['https://app.test/cb', 'https://other.test/cb'],
      token_endpoint_auth_method: 'none',
      oauth_lane: 'jc',
      scope: 'mcp',
    },
    'dc-one': {
      client_name: 'Desktop Owner',
      redirect_uris: ['https://dc.test/cb'],
      token_endpoint_auth_method: 'none',
      oauth_lane: 'dc',
      scope: 'mcp',
    },
  }));
  fs.writeFileSync(path.join(dir, 'tokens.json'), '{}');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      PATH: process.env.PATH,
      GATEWAY_PORT: String(port),
      PUBLIC_ORIGIN: ORIGIN,
      CONSENT_PASSPHRASE: PASS,
      SIGNING_KEY: KEY,
      DATA_DIR: dir,
      UPSTREAM: `http://127.0.0.1:${upPort}`,
      JC_ENABLED: '1',
      JC_UPSTREAM: `http://127.0.0.1:${upPort}`,
      ACS_GATEWAY_URL: `http://127.0.0.1:${acsPort}`,
      ACS_JC_GATEWAY_TOKEN: 'jc-bridge-token',
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
  return {
    base,
    acs,
    output: () => output,
    close: () => { child.kill('SIGKILL'); acs.server.close(); upstream.server.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

async function withGateway(fn) {
  const gw = await boot();
  try { await fn(gw); } finally { gw.close(); }
}

function authorizeUrl(base, params) {
  return `${base}/authorize?${new URLSearchParams(params).toString()}`;
}

async function authorize(gw, params) {
  const response = await fetch(authorizeUrl(gw.base, params), { redirect: 'manual' });
  const html = await response.text();
  return { response, html, fields: hiddenFields(html) };
}

function consent(gw, fields) {
  return fetch(`${gw.base}/authorize/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

const jcAuthorize = (clientId, redirect, challenge, extra = {}) => ({
  oauth_lane: 'jc',
  resource: JC_RESOURCE,
  client_id: clientId,
  redirect_uri: redirect,
  response_type: 'code',
  scope: 'mcp',
  state: 's1',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  ...extra,
});

test('authorize shows the client and the exact redirect, and does not hide either as a substitutable field', () =>
  withGateway(async (gw) => {
    const { challenge } = pkce();
    const redirect = 'https://app.test/cb';
    const { response, html, fields } = await authorize(gw, jcAuthorize('jc-one', redirect, challenge));
    assert.equal(response.status, 200);
    const shown = visibleText(html);
    assert.match(shown, /Trusted App/);
    assert.match(shown, /jc-one/);
    assert.match(shown, /https:\/\/app\.test\/cb/);
    assert.match(shown, new RegExp(JC_RESOURCE.replace(/[.]/g, '\\.')));
    assert.equal(fields.client_id, 'jc-one');
    assert.equal(fields.resource, JC_RESOURCE);
    assert.equal(typeof fields.consent_txn, 'string');
    assert.ok(fields.consent_txn.length >= 20);
    assert.equal(fields.redirect_uri, undefined);
    assert.equal(fields.code_challenge, undefined);
    assert.equal(fields.code_challenge_method, undefined);
    assert.equal(fields.state, undefined);
    assert.equal([...html.matchAll(/name="resource"/g)].length, 1);
    assert.equal([...html.matchAll(/name="consent_txn"/g)].length, 1);
    assert.doesNotMatch(html, /name="redirect_uri"/);
    assert.doesNotMatch(html, /name="code_challenge"/);
  }));

test('a consent POST without a server-side transaction is refused', () =>
  withGateway(async (gw) => {
    const { challenge } = pkce();
    const posted = await consent(gw, {
      ...jcAuthorize('jc-one', 'https://app.test/cb', challenge),
      passphrase: PASS,
    });
    assert.equal(posted.status, 400);
    assert.equal(posted.headers.get('location'), null);
  }));

test('an unknown consent transaction is refused before the passphrase is checked', () =>
  withGateway(async (gw) => {
    const posted = await consent(gw, {
      consent_txn: 'missing-transaction',
      client_id: 'jc-one',
      resource: JC_RESOURCE,
      passphrase: WRONG_PASS,
    });
    assert.equal(posted.status, 400);
    assert.doesNotMatch(gw.output(), new RegExp(WRONG_PASS));
  }));

test('a conflicting redirect, client, challenge, resource, or state does not consume the transaction', () =>
  withGateway(async (gw) => {
    const { verifier, challenge } = pkce();
    const other = pkce();
    const { html, fields } = await authorize(gw, jcAuthorize('jc-one', 'https://app.test/cb', challenge));
    assert.match(visibleText(html), /https:\/\/app\.test\/cb/);
    const probes = [
      { redirect_uri: 'https://app.test/other' },
      { client_id: 'jc-two' },
      { code_challenge: other.challenge },
      { code_challenge_method: 'plain' },
      { resource: DC_RESOURCE },
      { scope: 'openid' },
      { state: 'attacker' },
    ];
    for (const probe of probes) {
      const response = await consent(gw, { ...fields, ...probe, passphrase: PASS });
      assert.equal(response.status, 400, `probe ${Object.keys(probe)[0]} must fail`);
      assert.equal(response.headers.get('location'), null);
    }
    const ok = await consent(gw, { ...fields, passphrase: PASS });
    assert.equal(ok.status, 302, 'the transaction must still be usable after rejected probes');
    const code = new URL(ok.headers.get('location')).searchParams.get('code');
    const token = await fetch(`${gw.base}/token?oauth_lane=jc&resource=${encodeURIComponent(JC_RESOURCE)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: 'https://app.test/cb',
        client_id: 'jc-one',
        resource: JC_RESOURCE,
      }).toString(),
    });
    assert.equal(token.status, 200);
    assert.equal(claimsOf((await token.json()).access_token).sub, jcSubject('jc-one'));
  }));

test('a wrong passphrase does not consume the transaction and is not logged', () =>
  withGateway(async (gw) => {
    const { challenge } = pkce();
    const { fields } = await authorize(gw, jcAuthorize('jc-one', 'https://app.test/cb', challenge));
    assert.equal(typeof fields.consent_txn, 'string');
    assert.equal(fields.redirect_uri, undefined);
    const denied = await consent(gw, { ...fields, passphrase: WRONG_PASS });
    assert.equal(denied.status, 401);
    assert.doesNotMatch(gw.output(), new RegExp(WRONG_PASS));
    assert.doesNotMatch(gw.output(), new RegExp(PASS));
    const ok = await consent(gw, { ...fields, passphrase: PASS });
    assert.equal(ok.status, 302);
  }));

test('a consent transaction cannot be replayed', () =>
  withGateway(async (gw) => {
    const { challenge } = pkce();
    const { fields } = await authorize(gw, jcAuthorize('jc-one', 'https://app.test/cb', challenge));
    const first = await consent(gw, { ...fields, passphrase: PASS });
    assert.equal(first.status, 302);
    const second = await consent(gw, { ...fields, passphrase: PASS });
    assert.equal(second.status, 400);
    assert.equal(second.headers.get('location'), null);
  }));

test('JC access tokens use a per-client subject and refresh keeps it', () =>
  withGateway(async (gw) => {
    async function issue(clientId, redirect) {
      const { verifier, challenge } = pkce();
      const { fields } = await authorize(gw, jcAuthorize(clientId, redirect, challenge));
      const approved = await consent(gw, { ...fields, passphrase: PASS });
      assert.equal(approved.status, 302);
      const code = new URL(approved.headers.get('location')).searchParams.get('code');
      const token = await fetch(`${gw.base}/token?oauth_lane=jc&resource=${encodeURIComponent(JC_RESOURCE)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          redirect_uri: redirect,
          client_id: clientId,
          resource: JC_RESOURCE,
        }).toString(),
      });
      assert.equal(token.status, 200);
      return token.json();
    }
    const first = await issue('jc-one', 'https://app.test/cb');
    const second = await issue('jc-two', 'https://other.test/cb');
    const firstClaims = claimsOf(first.access_token);
    const secondClaims = claimsOf(second.access_token);
    assert.equal(firstClaims.sub, jcSubject('jc-one'));
    assert.equal(secondClaims.sub, jcSubject('jc-two'));
    assert.notEqual(firstClaims.sub, 'jacen');
    assert.notEqual(firstClaims.sub, secondClaims.sub);
    assert.equal(firstClaims.client_id, 'jc-one');
    assert.equal(secondClaims.client_id, 'jc-two');
    assert.equal(firstClaims.aud, JC_RESOURCE);
    const refreshed = await fetch(`${gw.base}/token?oauth_lane=jc&resource=${encodeURIComponent(JC_RESOURCE)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: first.refresh_token,
        client_id: 'jc-one',
        resource: JC_RESOURCE,
      }).toString(),
    });
    assert.equal(refreshed.status, 200);
    const refreshedClaims = claimsOf((await refreshed.json()).access_token);
    assert.equal(refreshedClaims.sub, jcSubject('jc-one'));
    assert.equal(refreshedClaims.client_id, 'jc-one');
  }));

test('a Desktop Commander token from the same consent handler keeps the owner subject', () =>
  withGateway(async (gw) => {
    const { verifier, challenge } = pkce();
    const { fields } = await authorize(gw, {
      resource: DC_RESOURCE,
      client_id: 'dc-one',
      redirect_uri: 'https://dc.test/cb',
      response_type: 'code',
      scope: 'mcp',
      state: 'dc',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    assert.match(visibleText(await (await fetch(authorizeUrl(gw.base, {
      resource: DC_RESOURCE,
      client_id: 'dc-one',
      redirect_uri: 'https://dc.test/cb',
      response_type: 'code',
      scope: 'mcp',
      state: 'dc2',
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
    }))).text()), /Desktop Owner/);
    const approved = await consent(gw, { ...fields, passphrase: PASS });
    assert.equal(approved.status, 302);
    const code = new URL(approved.headers.get('location')).searchParams.get('code');
    const token = await fetch(`${gw.base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: 'https://dc.test/cb',
        client_id: 'dc-one',
        resource: DC_RESOURCE,
      }).toString(),
    });
    assert.equal(token.status, 200);
    const claims = claimsOf((await token.json()).access_token);
    assert.equal(claims.sub, 'jacen');
    assert.equal(claims.client_id, 'dc-one');
    assert.equal(claims.aud, DC_RESOURCE);
    assert.notEqual(claims.sub, jcSubject('dc-one'));
  }));

test('tools/call attributes ACS to the authenticated JC client, not a shared owner', () =>
  withGateway(async (gw) => {
    const { verifier, challenge } = pkce();
    const { fields } = await authorize(gw, jcAuthorize('jc-one', 'https://app.test/cb', challenge));
    const approved = await consent(gw, { ...fields, passphrase: PASS });
    assert.equal(approved.status, 302);
    const code = new URL(approved.headers.get('location')).searchParams.get('code');
    const tokenResponse = await fetch(`${gw.base}/token?oauth_lane=jc&resource=${encodeURIComponent(JC_RESOURCE)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: 'https://app.test/cb',
        client_id: 'jc-one',
        resource: JC_RESOURCE,
      }).toString(),
    });
    assert.equal(tokenResponse.status, 200);
    const { access_token: accessToken } = await tokenResponse.json();
    const call = await fetch(`${gw.base}/jc/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'acs_read', arguments: { view: 'health' } } }),
    });
    assert.equal(call.status, 200);
    const issued = gw.acs.requests.filter((req) => req.path === '/jc/capability/issue');
    assert.equal(issued.length, 1);
    assert.equal(issued[0].jcActor, jcActor('jc-one'));
    assert.notEqual(issued[0].jcActor, 'chatgpt:jacen');
    assert.equal(issued[0].actor, undefined);
    assert.equal(issued[0].body.client_id, 'jc-one');
    assert.equal(issued[0].body.tool, 'acs_read');
  }));
