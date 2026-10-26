// Proxy-related Node settings must not reroute or bypass the CIMD connection policy.
// The fetch runs in a child process with proxy variables pointing at a CLOSED port and NODE_USE_ENV_PROXY=1, the setting
// that makes Node honour proxy env for the default agent. A successful fetch proves the connection went direct to the
// validated address (the proxy was never used). If the proxy had been used, the connection would fail with ECONNREFUSED.
// Run: node --test test/cimd-proxy-transport.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const GUARD = fileURLToPath(new URL('../cimd-guard.js', import.meta.url));
const CLIENT_ID = 'https://metadata.test/client.json';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cimd-proxy-'));
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
  '-keyout', path.join(tmp, 'k.pem'), '-out', path.join(tmp, 'c.pem'), '-days', '2', '-subj', '/CN=metadata.test',
  '-addext', 'subjectAltName=DNS:metadata.test', '-addext', 'basicConstraints=critical,CA:FALSE',
], { stdio: 'ignore' });
const key = fs.readFileSync(path.join(tmp, 'k.pem'));
const cert = fs.readFileSync(path.join(tmp, 'c.pem'));
const doc = JSON.stringify({ client_id: CLIENT_ID, redirect_uris: ['https://metadata.test/cb'] });

async function closedPort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  return port;
}

function childScript(port) {
  // Loopback lookup for the TEST server only; the production policy is exercised elsewhere. The tls ca is injected.
  return `
    const { fetchClientMetadata } = await import(${JSON.stringify(GUARD)});
    const lookup = (h, o, cb) => (o && o.all) ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4);
    try {
      const meta = await fetchClientMetadata(${JSON.stringify(CLIENT_ID)}, { lookup, port: ${port}, tlsOptions: { ca: ${JSON.stringify(cert.toString())} } });
      console.log('OK ' + meta.redirect_uris[0]);
    } catch (e) {
      console.log('ERR ' + (e && e.code ? e.code + ' ' : '') + e.message);
      process.exitCode = 3;
    }`;
}

async function runChild(env, port) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', childScript(port)], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const [code] = await once(child, 'exit');
  return { code, out: out.trim() };
}

test('proxy environment with NODE_USE_ENV_PROXY does not reroute the metadata connection', async (t) => {
  const server = https.createServer({ key, cert }, (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(doc); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections?.(); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const dead = `http://127.0.0.1:${await closedPort()}`;
  const env = {
    HTTPS_PROXY: dead, https_proxy: dead, HTTP_PROXY: dead, http_proxy: dead, ALL_PROXY: dead, all_proxy: dead,
    NODE_USE_ENV_PROXY: '1', NO_PROXY: '',
  };
  const r = await runChild(env, server.address().port);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out, 'OK https://metadata.test/cb');
});

test('a control: the same child without proxy variables succeeds, so the proxy case above is a real test', async (t) => {
  const server = https.createServer({ key, cert }, (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(doc); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  const r = await runChild({}, server.address().port);
  assert.equal(r.code, 0, r.out);
});

test('proxy variables that would be used for a plain-HTTP request cannot carry the metadata fetch', async (t) => {
  // A proxy that answers with a valid document would be a bypass if honoured. It must never be contacted.
  let proxyHits = 0;
  const proxy = net.createServer((socket) => { proxyHits += 1; socket.end(); });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(() => proxy.close());
  const server = https.createServer({ key, cert }, (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(doc); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections?.(); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const r = await runChild({ HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl, NODE_USE_ENV_PROXY: '1' }, server.address().port);
  assert.equal(r.code, 0, r.out);
  assert.equal(proxyHits, 0, 'the configured proxy must never be contacted for the metadata fetch');
});
