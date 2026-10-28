import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesRegisteredLoopback } from '../cimd-guard.js';

test('RFC 8252 loopback allows port changes only, including registered query', () => {
  const registered = ['http://127.0.0.1:9999/callback?channel=client'];
  assert.equal(matchesRegisteredLoopback('http://127.0.0.1:34567/callback?channel=client', registered), true);
  assert.equal(matchesRegisteredLoopback('http://127.0.0.1:34567/callback', registered), false);
  assert.equal(matchesRegisteredLoopback('http://127.0.0.1:34567/callback?channel=attacker', registered), false);
  assert.equal(matchesRegisteredLoopback('http://127.0.0.1:34567/callback?channel=client#frag', registered), false);
});
