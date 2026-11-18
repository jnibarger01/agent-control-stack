#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSearchRegistry } from '../dist/search.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-search-owner-'));
try {
  fs.writeFileSync(path.join(root, 'visible.txt'), 'search result');
  const registry = createSearchRegistry();
  const policy = { roots: [root], deniedRoots: [] };
  const started = await registry.start({ path: root, pattern: '*.txt', mode: 'filename' }, policy, 'principal-A');
  const id = started.searchId;
  assert.equal(registry.list('principal-A').searches.length, 1);
  assert.deepEqual(registry.list('principal-B').searches, []);
  assert.throws(() => registry.more({ searchId: id }, 'principal-B'), /search not found/);
  assert.throws(() => registry.stop({ searchId: id }, 'principal-B'), /search not found/);
  assert.equal(registry.more({ searchId: id }, 'principal-A').searchId, id);
  assert.equal(registry.stop({ searchId: id }, 'principal-A').cancelled, true);
  console.log('search sessions are principal scoped');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
