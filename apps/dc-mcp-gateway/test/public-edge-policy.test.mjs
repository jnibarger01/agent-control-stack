import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedPublicRoute } from '../public-edge-policy.js';
const resource = 'https://example.ts.net/jc/mcp';
const allow = (method, path, body = '') => allowedPublicRoute(method, path, body, resource);

test('only JC protected resource and issuer discovery paths are public', () => {
  for (const path of [
    '/.well-known/oauth-protected-resource/jc/mcp',
    '/.well-known/oauth-authorization-server/jc',
    '/jc/.well-known/oauth-authorization-server',
    '/jc/.well-known/openid-configuration'
  ]) assert.equal(allow('GET', path), true, path);
  for (const path of ['/', '/mcp', '/ready', '/jc/ready', '/authority',
    '/health', '/healthz', '/readyz', '/api', '/admin',
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-authorization-server/mcp',
    '/.well-known/openid-configuration']) assert.equal(allow('GET', path), false, path);
});
test('only JC MCP methods, not DC MCP or arbitrary verbs', () => {
  for (const method of ['GET', 'POST', 'DELETE']) assert.equal(allow(method, '/jc/mcp'), true);
  for (const method of ['PUT', 'TRACE', 'CONNECT', 'OPTIONS', 'PATCH'])
    assert.equal(allow(method, '/jc/mcp'), false);
});
test('OAuth requests must bind to JC lane and resource', () => {
  const good = '?oauth_lane=jc&resource=' + encodeURIComponent(resource);
  for (const [method, path] of [['GET', '/authorize'], ['POST', '/token'], ['POST', '/register']]) {
    assert.equal(allow(method, path + good), true);
    assert.equal(allow(method, path), false);
    assert.equal(allow(method, path + '?oauth_lane=dc&resource=' + encodeURIComponent(resource)), false);
    assert.equal(allow(method, path + '?oauth_lane=jc&resource=https%3A%2F%2Fexample.ts.net%2Fmcp'), false);
  }
});
test('consent must be form-encoded and bound to JC resource', () => {
  assert.equal(allow('POST', '/authorize/consent', 'resource=' + encodeURIComponent(resource)), true);
  assert.equal(allow('POST', '/authorize/consent', 'resource=https%3A%2F%2Fevil.example'), false);
  assert.equal(allow('POST', '/authorize/consent', ''), false);
  assert.equal(allow('GET', '/authorize/consent'), false);
});
test('reject ambiguous paths and duplicate control parameters', () => {
  for (const path of ['/jc/mcp/', '/jc//mcp', '/jc/%6dcp', '/x/../jc/mcp', '/jc\\mcp', '//jc/mcp',
    '/jc/mcp#fragment', '/jc/mcp?x=%zz', '/jc/mcp?x=1%0d%0a']) {
    assert.equal(allow('GET', path), false, path);
  }
  assert.equal(allow('GET', '/authorize?oauth_lane=jc&oauth_lane=dc&resource=' + encodeURIComponent(resource)), false);
});
