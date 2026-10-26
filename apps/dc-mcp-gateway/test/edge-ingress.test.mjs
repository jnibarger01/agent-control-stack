// Public HTTPS edge: route/method allowlist and ingress behaviour, against a real loopback upstream that records hits.
// Denied requests must produce ZERO upstream hits. Run: node --test test/edge-ingress.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createIngress } from '../edge/ingress.js';
import { decideRoute, bodyResourceMatches } from '../edge/policy.js';

const HOST = 'edge.test';
const RESOURCE = `https://${HOST}/jc/mcp`;
const LANE = `resource=${encodeURIComponent(RESOURCE)}&oauth_lane=jc`;
const allow = (method, url, host = HOST) => decideRoute({ method, url, host, publicHost: HOST, jcResource: RESOURCE });

// ---------------------------------------------------------------------------
// Pure policy
// ---------------------------------------------------------------------------

test('allowed: the discovery documents, the lane OAuth endpoints, and /jc/mcp', () => {
  assert.equal(allow('GET', '/.well-known/oauth-protected-resource/jc/mcp').allow, true);
  assert.equal(allow('GET', '/.well-known/oauth-authorization-server/jc').allow, true);
  assert.equal(allow('GET', '/jc/.well-known/openid-configuration').allow, true);
  assert.equal(allow('GET', `/authorize?response_type=code&${LANE}`).allow, true);
  assert.equal(allow('POST', `/token?${LANE}`).allow, true);
  assert.equal(allow('POST', `/register?${LANE}`).allow, true);
  assert.equal(allow('POST', '/authorize/consent').allow, true);
  for (const m of ['GET', 'POST', 'DELETE']) assert.equal(allow(m, '/jc/mcp').allow, true, `${m} /jc/mcp`);
});

test('internal and diagnostic surfaces are not routable from the public edge', () => {
  for (const url of [
    '/ready', '/authority', '/jc/ready', '/health', '/healthz', '/debug/last-headers',
    '/mcp', '/dc/capability/issue', '/jc/capability/issue', '/dc/runtime/bootstrap', '/acs/internal', '/jc/debug',
    '/', '/index.html', '/.well-known/oauth-protected-resource',
  ]) {
    const d = allow('GET', url);
    assert.equal(d.allow, false, `${url} must be denied`);
  }
});

test('known paths with the wrong method are 405 with an Allow header; unknown paths are 404', () => {
  assert.deepEqual(
    { allow: false, status: 405, allow_methods: 'GET, POST, DELETE' }, allow('PUT', '/jc/mcp'),
  );
  assert.equal(allow('HEAD', '/jc/mcp').status, 405);
  assert.equal(allow('OPTIONS', '/jc/mcp').status, 405);
  assert.equal(allow('GET', `/token?${LANE}`).status, 405);
  assert.equal(allow('GET', '/authorize/consent').status, 405);
  assert.equal(allow('DELETE', '/register').status, 405);
  assert.equal(allow('POST', '/.well-known/oauth-protected-resource/jc/mcp').status, 405);
  assert.equal(allow('GET', '/ready').status, 404);
});

test('OAuth lane routes require exactly one oauth_lane=jc and one matching resource', () => {
  assert.equal(allow('POST', '/token').status, 404);                                  // no query
  assert.equal(allow('POST', `/token?oauth_lane=dc&resource=${encodeURIComponent(RESOURCE)}`).status, 404);
  assert.equal(allow('POST', `/token?oauth_lane=jc&resource=${encodeURIComponent('https://other.test/jc/mcp')}`).status, 404);
  assert.equal(allow('POST', `/token?${LANE}&oauth_lane=dc`).status, 404);            // duplicate parameter
  assert.equal(allow('GET', `/authorize?${LANE}&resource=${encodeURIComponent(RESOURCE)}`).status, 404); // duplicate resource
});

test('path tricks are denied: encoding, dot segments, double slashes, backslash, fragments, traversal', () => {
  for (const url of [
    '/jc/%2e%2e/ready', '/jc/mcp/../ready', '/jc//mcp', '/jc/./mcp', '/jc/mcp/', '/jc/mcp%00', '/jc\\mcp',
    '/jc/mcp#x', '/%6Aс/mcp', '/JC/MCP', '/jc/mcp?x=1', '/authorize/consent?x=1', '/.well-known/oauth-authorization-server/jc?x=1',
  ]) {
    assert.equal(allow('GET', url).allow, false, `${url} must be denied`);
    assert.equal(allow('POST', url).allow, false, `POST ${url} must be denied`);
  }
});

test('Host must be exactly the public host', () => {
  assert.equal(allow('GET', '/jc/mcp', 'omarchy.tailaa6d41.ts.net').allow, false);
  assert.equal(allow('GET', '/jc/mcp', `${HOST}.evil.test`).allow, false);
  assert.equal(allow('GET', '/jc/mcp', '').allow, false);
  assert.equal(allow('GET', '/jc/mcp', HOST.toUpperCase()).allow, false); // exact, lowercase match only
});

test('consent body must name the JC resource exactly once', () => {
  assert.equal(bodyResourceMatches(`resource=${encodeURIComponent(RESOURCE)}&client_id=x`, RESOURCE), true);
  assert.equal(bodyResourceMatches(`resource=${encodeURIComponent('https://other/jc/mcp')}`, RESOURCE), false);
  assert.equal(bodyResourceMatches(`resource=${encodeURIComponent(RESOURCE)}&resource=https://other/jc/mcp`, RESOURCE), false);
  assert.equal(bodyResourceMatches('client_id=x', RESOURCE), false);
});

// ---------------------------------------------------------------------------
// Ingress against a recording upstream
// ---------------------------------------------------------------------------

async function startFixture({ upstreamDown = false } = {}) {
  const hits = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamPort = upstream.address().port;
  if (upstreamDown) { await new Promise((r) => upstream.close(r)); }
  const ingress = createIngress({ publicHost: HOST, jcResource: RESOURCE, upstreamPort, upstreamTimeoutMs: 2000 });
  ingress.listen(0, '127.0.0.1');
  await once(ingress, 'listening');
  const base = `http://127.0.0.1:${ingress.address().port}`;
  const close = async () => {
    ingress.closeAllConnections?.(); ingress.close();
    if (!upstreamDown) { upstream.closeAllConnections?.(); upstream.close(); }
  };
  return { base, hits, close };
}

// fetch() cannot set a custom Host header, so route tests use node:http with an explicit Host.
function raw(base, { method = 'GET', path, host = HOST, headers = {}, body }) {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.end(body); else req.end();
  });
}

test('denied routes and methods never reach the upstream', async (t) => {
  const f = await startFixture();
  t.after(() => f.close());
  const cases = [
    ['GET', '/ready'], ['GET', '/authority'], ['GET', '/jc/ready'], ['GET', '/health'], ['GET', '/healthz'],
    ['GET', '/mcp'], ['POST', '/dc/capability/issue'], ['PUT', '/jc/mcp'], ['HEAD', '/jc/mcp'], ['OPTIONS', '/jc/mcp'],
    ['GET', '/token?oauth_lane=jc'], ['POST', '/jc/mcp/../ready'], ['GET', '/jc/%2e%2e/ready'],
  ];
  for (const [method, path] of cases) {
    const r = await raw(f.base, { method, path });
    assert.ok(r.status === 404 || r.status === 405, `${method} ${path} -> ${r.status}`);
  }
  assert.equal(f.hits.length, 0, 'denied requests must not reach the gateway');
});

test('wrong Host is denied and never reaches the upstream', async (t) => {
  const f = await startFixture();
  t.after(() => f.close());
  const r = await raw(f.base, { path: '/jc/mcp', host: 'omarchy.tailaa6d41.ts.net' });
  assert.equal(r.status, 404);
  assert.equal(f.hits.length, 0);
});

test('an allowed request is forwarded, and client-supplied identity headers are stripped', async (t) => {
  const f = await startFixture();
  t.after(() => f.close());
  const r = await raw(f.base, {
    method: 'POST', path: '/jc/mcp', body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    headers: { 'content-type': 'application/json', 'x-dc-attestation': 'forged', 'x-dc-agent': 'forged', 'x-acs-capability': 'forged', 'x-forwarded-for': '1.2.3.4', forwarded: 'for=1.2.3.4', 'x-real-ip': '1.2.3.4', authorization: 'Bearer abc' },
  });
  assert.equal(r.status, 200);
  assert.equal(f.hits.length, 1);
  const seen = f.hits[0].headers;
  for (const h of ['x-dc-attestation', 'x-dc-agent', 'x-acs-capability', 'x-forwarded-for', 'forwarded', 'x-real-ip']) {
    assert.equal(seen[h], undefined, `${h} must not reach the gateway`);
  }
  assert.equal(seen.authorization, 'Bearer abc', 'the bearer token is the caller\'s own and must be forwarded');
});

test('oversized bodies are refused with 413 before any upstream connection', async (t) => {
  const f = await startFixture();
  t.after(() => f.close());
  const big = 'a'.repeat(64 * 1024 + 1);
  const r = await raw(f.base, { method: 'POST', path: '/jc/mcp', body: big, headers: { 'content-type': 'application/json' } });
  assert.equal(r.status, 413);
  assert.equal(f.hits.length, 0);
});

test('consent POST: a foreign resource is refused; the JC resource is forwarded with the correct length', async (t) => {
  const f = await startFixture();
  t.after(() => f.close());
  const foreign = await raw(f.base, { method: 'POST', path: '/authorize/consent', body: `resource=${encodeURIComponent('https://other/jc/mcp')}&x=1`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(foreign.status, 404);
  assert.equal(f.hits.length, 0);
  const body = `resource=${encodeURIComponent(RESOURCE)}&passphrase=p&client_id=c`;
  const ok = await raw(f.base, { method: 'POST', path: '/authorize/consent', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(ok.status, 200);
  assert.equal(f.hits.length, 1);
  assert.equal(f.hits[0].body, body);
  assert.equal(f.hits[0].headers['content-length'], String(Buffer.byteLength(body)));
});

test('an unreachable gateway yields 502, not a hang', async (t) => {
  const f = await startFixture({ upstreamDown: true });
  t.after(() => f.close());
  const r = await raw(f.base, { path: '/jc/mcp' });
  assert.equal(r.status, 502);
});

test('the ingress refuses to start with a host or resource it cannot serve safely', () => {
  assert.throws(() => createIngress({ publicHost: 'Edge.Test', jcResource: 'https://Edge.Test/jc/mcp', upstreamPort: 8010 }), /bare lowercase/);
  assert.throws(() => createIngress({ publicHost: HOST, jcResource: 'https://other/jc/mcp', upstreamPort: 8010 }), /jcResource/);
  assert.throws(() => createIngress({ publicHost: HOST, jcResource: RESOURCE, upstreamPort: 0 }), /upstream port/);
  assert.throws(() => createIngress({ publicHost: HOST, jcResource: RESOURCE, upstreamPort: 8010, upstreamHost: '0.0.0.0' }), /loopback/);
});
