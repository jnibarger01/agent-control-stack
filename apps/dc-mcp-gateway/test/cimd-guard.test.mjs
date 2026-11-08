import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  fetchClientMetadata, isAllowedRedirectUri, isGlobalAddress, isLoopbackRedirectUri,
  matchesRegisteredLoopback, parseClientMetadata, parseMetadataUrl, publicLookup,
} from '../cimd-guard.js';

// ---------------------------------------------------------------------------
// Address policy (pure, no network)
// ---------------------------------------------------------------------------

test('IPv4: non-global ranges are refused, public addresses are accepted', () => {
  for (const ip of [
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '100.127.255.255', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.0.0.8', '192.0.2.1', '192.88.99.1', '192.168.1.1', '198.18.0.1', '198.19.255.255', '198.51.100.7', '203.0.113.9',
    '224.0.0.1', '239.1.1.1', '240.0.0.1', '255.255.255.255',
  ]) assert.equal(isGlobalAddress(ip), false, `${ip} must be refused`);
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '100.63.255.255', '198.20.0.1']) {
    assert.equal(isGlobalAddress(ip), true, `${ip} must be accepted`);
  }
});

test('IPv6: loopback, unspecified, unique-local, link-local, multicast, documentation, and 6to4 are refused', () => {
  for (const ip of ['::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'ff02::1', '2001:db8::1', '2002:c000:0201::1', '2001::1', '3fff::1']) {
    assert.equal(isGlobalAddress(ip), false, `${ip} must be refused`);
  }
  assert.equal(isGlobalAddress('2606:4700:4700::1111'), true);
  assert.equal(isGlobalAddress('2001:4860:4860::8888'), true);
});

test('IPv4-mapped and IPv4-compatible IPv6 are judged by their embedded IPv4 address', () => {
  for (const ip of ['::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.5', '::ffff:a9fe:a9fe', '::ffff:0:0', '::127.0.0.1', '::10.0.0.1']) {
    assert.equal(isGlobalAddress(ip), false, `${ip} must be refused`);
  }
  assert.equal(isGlobalAddress('::ffff:8.8.8.8'), true);
  assert.equal(isGlobalAddress('::ffff:808:808'), true);
});

test('malformed or non-IP input is refused (fail closed)', () => {
  for (const ip of ['', 'example.com', '999.1.1.1', 'not-an-ip', '1.2.3']) assert.equal(isGlobalAddress(ip), false, `${ip} must be refused`);
});

// ---------------------------------------------------------------------------
// Connection-time policy: DNS answers are checked before any socket is opened
// ---------------------------------------------------------------------------

function lookupOnce(lookup, hostname = 'metadata.test', options = { all: true }) {
  return new Promise((resolve) => lookup(hostname, options, (err, address, family) => resolve({ err, address, family })));
}

test('lookup accepts a public-only answer and returns the validated address', async () => {
  let calls = 0;
  const lookup = publicLookup(async () => { calls += 1; return [{ address: '93.184.216.34', family: 4 }]; });
  const r = await lookupOnce(lookup, 'metadata.test', {});
  assert.equal(r.err, null);
  assert.equal(r.address, '93.184.216.34');
  assert.equal(calls, 1);
});

test('mixed public and private DNS answers are refused, even when the public address is listed first', async () => {
  const lookup = publicLookup(async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]);
  const r = await lookupOnce(lookup, 'metadata.test', {});
  assert.match(r.err.message, /non-public/);
  assert.equal(r.address, undefined);
});

test('DNS rebinding: the single answer used for the connection is the one that is validated', async () => {
  // A rebinding resolver returns a public address on the first query and a private one on the second.
  // The socket only ever uses the first lookup result, and that result is validated. Count the queries to
  // show the connection path does not perform a second, unvalidated resolution.
  let queries = 0;
  const lookup = publicLookup(async () => {
    queries += 1;
    return queries === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }];
  });
  const first = await lookupOnce(lookup, 'metadata.test', {});
  assert.equal(first.address, '93.184.216.34');
  assert.equal(queries, 1);
  // A later lookup by the same connection path is validated afresh and still refused when it is private.
  const second = await lookupOnce(lookup, 'metadata.test', {});
  assert.match(second.err.message, /non-public/);
});

test('lookup refuses an empty answer and propagates resolver failure', async () => {
  const empty = await lookupOnce(publicLookup(async () => []));
  assert.match(empty.err.message, /did not resolve/);
  const failed = await lookupOnce(publicLookup(async () => { throw new Error('ENOTFOUND'); }));
  assert.equal(failed.err.message, 'ENOTFOUND');
});

test('lookup honours all:true by returning every validated address', async () => {
  const lookup = publicLookup(async () => [{ address: '93.184.216.34', family: 4 }, { address: '1.1.1.1', family: 4 }]);
  const r = await lookupOnce(lookup, 'metadata.test', { all: true });
  assert.deepEqual(r.err, null);
  assert.deepEqual(r.address, [{ address: '93.184.216.34', family: 4 }, { address: '1.1.1.1', family: 4 }]);
});

test('fetch refuses a private host before any DNS or socket work (no network needed)', async () => {
  await assert.rejects(fetchClientMetadata('https://127.0.0.1/client.json'), /non-public/);
  await assert.rejects(fetchClientMetadata('https://[::ffff:169.254.169.254]/client.json'), /non-public/);
  await assert.rejects(fetchClientMetadata('https://localhost/client.json'), /not public/);
});

test('URL policy: https only, no userinfo, no fragment, default port only', () => {
  assert.throws(() => parseMetadataUrl('http://93.184.216.34/c.json'), /must be https/);
  assert.throws(() => parseMetadataUrl('https://u:p@93.184.216.34/c.json'), /userinfo/);
  assert.throws(() => parseMetadataUrl('https://93.184.216.34/c.json#x'), /fragment/);
  assert.throws(() => parseMetadataUrl('https://93.184.216.34:8443/c.json'), /default https port/);
  assert.throws(() => parseMetadataUrl('not a url'), /malformed/);
  assert.equal(parseMetadataUrl('https://93.184.216.34/c.json').hostname, '93.184.216.34');
});

// ---------------------------------------------------------------------------
// Metadata document and redirect rules
// ---------------------------------------------------------------------------

test('metadata must match its client_id, be public, and use allowed redirects', () => {
  const id = 'https://app.example.com/client.json';
  const ok = { client_id: id, redirect_uris: ['https://app.example.com/cb'] };
  assert.deepEqual(parseClientMetadata(id, ok), { redirect_uris: ['https://app.example.com/cb'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'] });
  assert.throws(() => parseClientMetadata(id, { ...ok, client_id: 'https://evil.example/client.json' }), /does not match/);
  assert.throws(() => parseClientMetadata(id, { ...ok, token_endpoint_auth_method: 'client_secret_post' }), /public client/);
  assert.throws(() => parseClientMetadata(id, { ...ok, redirect_uris: [] }), /non-empty/);
  assert.throws(() => parseClientMetadata(id, { ...ok, redirect_uris: ['myapp://cb'] }), /allowed URIs/);
  assert.throws(() => parseClientMetadata(id, { ...ok, grant_types: ['password'] }), /grant_types/);
  assert.throws(() => parseClientMetadata(id, []), /JSON object/);
});

test('registrable redirects: https or loopback http only, no fragments or userinfo', () => {
  assert.equal(isAllowedRedirectUri('https://chatgpt.example/cb'), true);
  assert.equal(isAllowedRedirectUri('http://127.0.0.1:53000/cb'), true);
  assert.equal(isAllowedRedirectUri('http://localhost/cb'), true);
  assert.equal(isAllowedRedirectUri('http://[::1]:8000/cb'), true);
  assert.equal(isAllowedRedirectUri('http://evil.example/cb'), false);
  assert.equal(isAllowedRedirectUri('myapp://cb'), false);
  assert.equal(isAllowedRedirectUri('https://u:p@chatgpt.example/cb'), false);
  assert.equal(isAllowedRedirectUri('https://chatgpt.example/cb#frag'), false);
  assert.equal(isAllowedRedirectUri('javascript:alert(1)'), false);
  assert.equal(isAllowedRedirectUri(42), false);
  assert.equal(isLoopbackRedirectUri('http://127.0.0.1:1/cb'), true);
  assert.equal(isLoopbackRedirectUri('https://127.0.0.1/cb'), false);
});

test('loopback matching: any port on the registered host and path only', () => {
  const registered = ['http://127.0.0.1:9/cb'];
  assert.equal(matchesRegisteredLoopback('http://127.0.0.1:55555/cb', registered), true);
  assert.equal(matchesRegisteredLoopback('http://127.0.0.1/cb', registered), true);
  assert.equal(matchesRegisteredLoopback('http://127.0.0.1:9/other', registered), false);
  assert.equal(matchesRegisteredLoopback('http://localhost:9/cb', registered), false);
  assert.equal(matchesRegisteredLoopback('https://127.0.0.1:9/cb', registered), false);
  assert.equal(matchesRegisteredLoopback('http://127.0.0.1:9/cb?next=x', registered), false);
  assert.equal(matchesRegisteredLoopback('http://evil.example/cb', registered), false);
  assert.equal(matchesRegisteredLoopback('http://127.0.0.1:8080/cb', []), false);
  assert.equal(matchesRegisteredLoopback('http://127.0.0.1:8080/cb', ['https://app.test/cb']), false);
});

// ---------------------------------------------------------------------------
// Transport behaviour against a local TLS server. The test lookup points at 127.0.0.1 on purpose:
// this exercises redirects, size, timeout and content checks. The address policy is covered above.
// ---------------------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cimd-test-'));
const keyPath = path.join(tmp, 'key.pem');
const certPath = path.join(tmp, 'cert.pem');
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
  '-keyout', keyPath, '-out', certPath, '-days', '2', '-subj', '/CN=metadata.test',
  '-addext', 'subjectAltName=DNS:metadata.test', '-addext', 'basicConstraints=critical,CA:FALSE',
], { stdio: 'ignore' });
const serverKey = fs.readFileSync(keyPath);
const serverCert = fs.readFileSync(certPath);
const tlsOptions = { ca: serverCert };
// Test-only: send the socket to loopback. The hostname stays metadata.test, so SNI and certificate checks still run.
const loopbackLookup = (hostname, options, callback) => {
  if (options && options.all) return callback(null, [{ address: '127.0.0.1', family: 4 }]);
  callback(null, '127.0.0.1', 4);
};
const CLIENT_ID = 'https://metadata.test/client.json';

function startServer(handler) {
  return new Promise((resolve) => {
    const server = https.createServer({ key: serverKey, cert: serverCert }, handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
const closeServer = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
const fetchFrom = (port, extra = {}) => fetchClientMetadata(CLIENT_ID, { lookup: loopbackLookup, port, tlsOptions, ...extra });
const goodDoc = JSON.stringify({ client_id: CLIENT_ID, redirect_uris: ['https://metadata.test/cb'] });

test('valid metadata over TLS is returned after the transport checks pass', async (t) => {
  const { server, port } = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(goodDoc);
  });
  t.after(() => closeServer(server));
  const meta = await fetchFrom(port);
  assert.deepEqual(meta.redirect_uris, ['https://metadata.test/cb']);
  assert.equal(meta.token_endpoint_auth_method, 'none');
});

test('redirects are never followed: a 302 to an internal address is refused', async (t) => {
  let internalHits = 0;
  const { server, port } = await startServer((req, res) => {
    if (req.url === '/client.json') {
      res.writeHead(302, { location: 'https://169.254.169.254/latest/meta-data/' });
      return res.end();
    }
    internalHits += 1;
    res.end(goodDoc);
  });
  t.after(() => closeServer(server));
  await assert.rejects(fetchFrom(port), /HTTP 302/);
  assert.equal(internalHits, 0);
});

test('a non-200 response is refused', async (t) => {
  const { server, port } = await startServer((req, res) => { res.writeHead(404); res.end('nope'); });
  t.after(() => closeServer(server));
  await assert.rejects(fetchFrom(port), /HTTP 404/);
});

test('wrong content type is refused', async (t) => {
  const { server, port } = await startServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(goodDoc); });
  t.after(() => closeServer(server));
  await assert.rejects(fetchFrom(port), /application\/json/);
});

test('oversized response is cut off at the byte cap (chunked, no content-length)', async (t) => {
  const { server, port } = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"client_id":"' + CLIENT_ID + '","pad":"');
    const chunk = 'a'.repeat(8192);
    let sent = 0;
    const timer = setInterval(() => {
      sent += 1;
      if (sent > 64) { clearInterval(timer); return res.end('"}'); }
      res.write(chunk);
    }, 1);
    res.on('close', () => clearInterval(timer));
  });
  t.after(() => closeServer(server));
  await assert.rejects(fetchFrom(port, { maxBytes: 16 * 1024 }), /too large|socket hang up|aborted|ECONNRESET/);
});

test('oversized response is refused from a declared content-length without reading the body', async (t) => {
  const { server, port } = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(10 * 1024 * 1024) });
    res.write('{');
  });
  t.after(() => closeServer(server));
  await assert.rejects(fetchFrom(port, { maxBytes: 1024 }), /too large/);
});

test('a server that never answers is stopped by the timeout', async (t) => {
  const { server, port } = await startServer(() => { /* never respond */ });
  t.after(() => closeServer(server));
  const started = Date.now();
  await assert.rejects(fetchFrom(port, { timeoutMs: 200 }), /timed out/);
  assert.ok(Date.now() - started < 5000);
});

test('a connection failure is reported, not swallowed', async () => {
  // Port 1 on loopback is closed in the test environment, so the connect fails immediately.
  await assert.rejects(fetchFrom(1), /ECONNREFUSED|connect/);
});

test('metadata whose client_id does not match the fetched URL is refused', async (t) => {
  const bad = JSON.stringify({ client_id: 'https://attacker.example/client.json', redirect_uris: ['https://attacker.example/cb'] });
  const { server, port } = await startServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(bad); });
  t.after(() => closeServer(server));
  await assert.rejects(fetchFrom(port), /does not match/);
});

test('non-JSON body is refused', async (t) => {
  const { server, port } = await startServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('<html>'); });
  t.after(() => closeServer(server));
  await assert.rejects(fetchFrom(port), /JSON|Unexpected/);
});

test('the metadata connection refuses a private DNS answer and never reaches the server', async (t) => {
  let hits = 0;
  const { server, port } = await startServer((req, res) => { hits += 1; res.end(goodDoc); });
  t.after(() => closeServer(server));
  // Real publicLookup, resolver returns loopback: the connection must be blocked before any socket opens.
  const lookup = publicLookup(async () => [{ address: '127.0.0.1', family: 4 }]);
  await assert.rejects(fetchClientMetadata(CLIENT_ID, { lookup, port, tlsOptions }), /non-public/);
  assert.equal(hits, 0);
});

test('the metadata connection refuses a rebinding answer: public first, private second, nothing sent', async (t) => {
  let hits = 0;
  const { server, port } = await startServer((req, res) => { hits += 1; res.end(goodDoc); });
  t.after(() => closeServer(server));
  let queries = 0;
  const lookup = publicLookup(async () => {
    queries += 1;
    return queries === 1 ? [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }] : [{ address: '127.0.0.1', family: 4 }];
  });
  await assert.rejects(fetchClientMetadata(CLIENT_ID, { lookup, port, tlsOptions }), /non-public/);
  assert.equal(queries, 1);
  assert.equal(hits, 0);
});
