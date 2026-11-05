import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createPublicIngress } from '../public-edge-proxy.js';
import { INGRESS_CLIENT_HEADER, INGRESS_PROOF_HEADER, ingressIdentityProof } from '../consent-guard.js';

const resource = 'https://example.ts.net/jc/mcp';
const identityKey = 'k'.repeat(32);
const ingress = (upstreamPort) => createPublicIngress({ upstreamPort, jcResource: resource, identityKey });
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));
test('proxy drops denied routes before they reach OAuth gateway', async () => {
  const reached = [];
  const upstream = http.createServer((req, res) => {
    reached.push(req.url);
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('upstream');
  });
  const uport = await listen(upstream);
  const publicServer = ingress(uport);
  const pport = await listen(publicServer);
  const url = (path) => 'http://127.0.0.1:' + pport + path;
  try {
    for (const path of ['/ready', '/authority', '/jc/ready', '/mcp', '/', '/.well-known/oauth-protected-resource']) {
      const response = await fetch(url(path));
      assert.equal(response.status, 404, path);
    }
    assert.equal(reached.length, 0);
    const good = await fetch(url('/.well-known/oauth-protected-resource/jc/mcp'));
    assert.equal(good.status, 200);
    assert.equal(await good.text(), 'upstream');
    assert.deepEqual(reached, ['/.well-known/oauth-protected-resource/jc/mcp']);
  } finally { await close(publicServer); await close(upstream); }
});
test('proxy forwards only JC OAuth and consent payloads', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    req.pipe(res);
  });
  const uport = await listen(upstream);
  const publicServer = ingress(uport);
  const pport = await listen(publicServer);
  try {
    const url = 'http://127.0.0.1:' + pport + '/authorize/consent';
    const good = 'resource=' + encodeURIComponent(resource) + '&passphrase=placeholder';
    const ok = await fetch(url, { method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}, body: good });
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), good);
    const denied = await fetch(url, { method: 'POST', body: 'resource=https%3A%2F%2Fevil.example' });
    assert.equal(denied.status, 404);
  } finally { await close(publicServer); await close(upstream); }
});
test('proxy stamps the accepted peer and drops a client-supplied ingress identity', async () => {
  let seen = null;
  const upstream = http.createServer((req, res) => {
    seen = req.headers;
    res.writeHead(204);
    res.end();
  });
  const uport = await listen(upstream);
  const publicServer = ingress(uport);
  const pport = await listen(publicServer);
  try {
    const url = 'http://127.0.0.1:' + pport + '/authorize/consent';
    const good = 'resource=' + encodeURIComponent(resource) + '&passphrase=placeholder';
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-for': '203.0.113.50',
        'x-real-ip': '198.51.100.50',
        forwarded: 'for=192.0.2.50',
        [INGRESS_CLIENT_HEADER]: '203.0.113.53',
        [INGRESS_PROOF_HEADER]: 'ab'.repeat(32),
      },
      body: good,
    });
    assert.equal(response.status, 204);
    assert.equal(seen[INGRESS_CLIENT_HEADER], '127.0.0.1');
    assert.equal(seen[INGRESS_PROOF_HEADER], ingressIdentityProof('127.0.0.1', identityKey));
    assert.equal(seen['x-forwarded-for'], undefined);
    assert.equal(seen['x-real-ip'], undefined);
    assert.equal(seen.forwarded, undefined);
    assert.notEqual(seen[INGRESS_CLIENT_HEADER], '203.0.113.53');
    assert.notEqual(seen[INGRESS_PROOF_HEADER], 'ab'.repeat(32));
  } finally { await close(publicServer); await close(upstream); }
});
