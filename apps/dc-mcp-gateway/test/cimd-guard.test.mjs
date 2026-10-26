import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNonPublicAddress, assertPublicHttpsUrl, matchesRegisteredLoopback } from '../cimd-guard.js';

test('non-public addresses are blocked; public addresses pass', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
    '::', '::1', 'fe80::1', 'fd00::1', 'fc00::5', 'ff02::1', '::ffff:127.0.0.1']) {
    assert.equal(isNonPublicAddress(ip), true, `${ip} should be blocked`);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '93.184.216.34', '2606:4700:4700::1111']) {
    assert.equal(isNonPublicAddress(ip), false, `${ip} should be allowed`);
  }
});

test('CIMD URL must be https, credential-free, and not a private literal or localhost', async () => {
  await assert.rejects(assertPublicHttpsUrl('http://93.184.216.34/client.json'), /must be https/);
  await assert.rejects(assertPublicHttpsUrl('https://user:pw@93.184.216.34/client.json'), /credentials/);
  await assert.rejects(assertPublicHttpsUrl('https://localhost/client.json'), /not public/);
  await assert.rejects(assertPublicHttpsUrl('https://app.localhost/client.json'), /not public/);
  await assert.rejects(assertPublicHttpsUrl('https://127.0.0.1/client.json'), /non-public/);
  await assert.rejects(assertPublicHttpsUrl('https://169.254.169.254/latest/meta-data/'), /non-public/);
  await assert.rejects(assertPublicHttpsUrl('https://[::1]/client.json'), /non-public/);
  const ok = await assertPublicHttpsUrl('https://93.184.216.34/client.json');
  assert.equal(ok.hostname, '93.184.216.34');
});

test('loopback redirect: any port on the registered host and path is accepted', () => {
  const registered = ['http://127.0.0.1:9/cb'];
  assert.equal(matchesRegisteredLoopback('http://127.0.0.1:55555/cb', registered), true);
  assert.equal(matchesRegisteredLoopback('http://127.0.0.1/cb', registered), true);
});

test('loopback redirect: other paths, hosts, schemes, and query strings are rejected', () => {
  const registered = ['http://127.0.0.1:9/cb'];
  assert.equal(matchesRegisteredLoopback('http://127.0.0.1:9/other', registered), false);
  assert.equal(matchesRegisteredLoopback('http://localhost:9/cb', registered), false);
  assert.equal(matchesRegisteredLoopback('https://127.0.0.1:9/cb', registered), false);
  assert.equal(matchesRegisteredLoopback('http://127.0.0.1:9/cb?next=x', registered), false);
  assert.equal(matchesRegisteredLoopback('http://evil.test/cb', registered), false);
});

test('loopback redirect: unregistered loopback is rejected when the client registered none', () => {
  assert.equal(matchesRegisteredLoopback('http://127.0.0.1:8080/cb', []), false);
  assert.equal(matchesRegisteredLoopback('http://127.0.0.1:8080/cb', ['https://app.test/cb']), false);
});
