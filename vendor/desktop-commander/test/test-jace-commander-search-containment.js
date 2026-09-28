#!/usr/bin/env node
/**
 * Regression (PR #212 review B1): start_search must apply the same
 * denied-root / credential-path / symlink containment as read_file and
 * list_directory to EVERY entry it walks, not only to the search root.
 *
 * Before the fix a content search rooted at $HOME returned the private key in
 * ~/.ssh, ~/.aws/credentials, a project .env and the JC state dir's tokens
 * (repro: /tmp/acs212-repro/search-leak.mjs). All values here are fake.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadJcConfig } from '../dist/jace-commander/config.js';
import { createJcServer } from '../dist/jace-commander/server.js';
import { createSearchRegistry } from '../dist/jace-commander/search.js';
import { defaultDeniedRoots, setJcFsRaceHookForTests } from '../dist/jace-commander/filesystem.js';
import { makeIssuer } from './fixtures/jc-mint.js';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jc-search-contain-')));
const home = path.join(tmp, 'home');
const project = path.join(home, 'proj');
const stateDir = path.join(home, '.jace-commander');
const outside = path.join(tmp, 'outside');
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

// Secrets that must never surface (names or content). All fake.
write(path.join(home, '.ssh', 'id_ed25519'), '-----BEGIN OPENSSH PRIVATE KEY----- FAKE_SECRET_SSH\n');
write(path.join(home, '.aws', 'credentials'), 'aws_secret_access_key = FAKE_SECRET_AWS\n');
write(path.join(project, '.env'), 'API_TOKEN=FAKE_SECRET_ENV\n');
write(path.join(project, 'credentials.json'), '{"secret":"FAKE_SECRET_CREDS"}\n');
write(path.join(stateDir, 'credentials.json'), '{"refresh_token":"FAKE_SECRET_JC_CREDS"}\n');
write(path.join(stateDir, 'mcp-token.json'), '{"access_token":"FAKE_SECRET_JC_MCP"}\n');
write(path.join(stateDir, 'device-key.pem'), '-----BEGIN PRIVATE KEY----- FAKE_SECRET_JC_DEVICE\n');
// Outside every root, reachable only through symlinks.
write(path.join(outside, 'loot.txt'), 'FAKE_SECRET_OUTSIDE\n');
fs.symlinkSync(path.join(outside, 'loot.txt'), path.join(project, 'escape-file.txt'));
fs.symlinkSync(outside, path.join(project, 'escape-dir'));
fs.symlinkSync(path.join(home, '.ssh'), path.join(project, 'ssh-link'));
// Legitimate content that SHOULD be found.
write(path.join(project, 'src', 'index.ts'), 'export const FAKE_SECRET_MARKER_OK = 1;\n');
write(path.join(project, 'raced.txt'), 'FAKE_SECRET_RACED_ORIGINAL\n');

const SECRET_MARKERS = ['FAKE_SECRET_SSH', 'FAKE_SECRET_AWS', 'FAKE_SECRET_ENV', 'FAKE_SECRET_CREDS', 'FAKE_SECRET_JC_CREDS',
  'FAKE_SECRET_JC_MCP', 'FAKE_SECRET_JC_DEVICE', 'FAKE_SECRET_OUTSIDE', 'PRIVATE KEY'];
const SECRET_NAMES = ['id_ed25519', 'credentials', 'credentials.json', '.env', 'mcp-token.json', 'device-key.pem', 'loot.txt',
  'escape-file.txt', 'escape-dir', 'ssh-link'];

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function assertNoLeak(results, label) {
  const serialized = JSON.stringify(results);
  for (const marker of SECRET_MARKERS) assert.ok(!serialized.includes(marker), `${label}: leaked ${marker}: ${serialized}`);
  for (const hit of results) {
    const rel = path.relative(home, hit.path);
    assert.ok(!rel.startsWith('..'), `${label}: result outside the root: ${hit.path}`);
    assert.ok(!rel.split(path.sep).some((part) => ['.ssh', '.aws', '.jace-commander'].includes(part)), `${label}: denied dir named: ${hit.path}`);
    assert.ok(!SECRET_NAMES.includes(path.basename(hit.path)), `${label}: credential/symlink entry named: ${hit.path}`);
  }
}

// Unit level: the search registry with the real JC policy shape.
const policy = { roots: [home], deniedRoots: defaultDeniedRoots(stateDir, home) };

await test('content search from $HOME never returns credential/denied/state-dir content or names', async () => {
  const search = createSearchRegistry();
  const result = await search.start({ path: home, pattern: 'FAKE_SECRET|PRIVATE KEY', mode: 'content', regex: true, limit: 100 }, policy);
  assertNoLeak(result.results, 'content');
  // The legitimate file is still searched.
  assert.deepEqual(result.results.map((hit) => path.relative(home, hit.path)).sort(), ['proj/raced.txt', 'proj/src/index.ts']);
});

await test('filename search from $HOME never names credential files, denied dirs or symlinks', async () => {
  const search = createSearchRegistry();
  const all = await search.start({ path: home, pattern: '*', mode: 'filename', limit: 100 }, policy);
  assertNoLeak(all.results, 'filename');
  assert.deepEqual(all.results.map((hit) => path.relative(home, hit.path)).sort(), ['proj/raced.txt', 'proj/src/index.ts']);
  for (const pattern of ['*.pem', '*.json', '.env', 'id_*', 'credentials', 'loot*']) {
    const hits = await search.start({ path: home, pattern, mode: 'filename' }, policy);
    assert.equal(hits.results.length, 0, `${pattern}: ${JSON.stringify(hits.results)}`);
  }
});

await test('a symlink escaping the root (file or directory) is skipped, not followed', async () => {
  const search = createSearchRegistry();
  const result = await search.start({ path: project, pattern: 'FAKE_SECRET_OUTSIDE', mode: 'content' }, policy);
  assert.equal(result.results.length, 0, JSON.stringify(result.results));
});

await test('a file swapped for a symlink between the walk and the open is skipped (O_NOFOLLOW)', async () => {
  const raced = path.join(project, 'raced.txt');
  setJcFsRaceHookForTests((checked) => {
    if (checked !== raced) return;
    fs.rmSync(raced);
    fs.symlinkSync(path.join(outside, 'loot.txt'), raced);
  });
  try {
    const search = createSearchRegistry();
    const result = await search.start({ path: project, pattern: 'FAKE_SECRET', mode: 'content', regex: true }, policy);
    assertNoLeak(result.results, 'race');
    assert.ok(!result.results.some((hit) => hit.path === raced), JSON.stringify(result.results));
  } finally {
    setJcFsRaceHookForTests(undefined);
    fs.rmSync(raced, { force: true });
    fs.writeFileSync(raced, 'FAKE_SECRET_RACED_ORIGINAL\n');
  }
});

await test('the managed MCP start_search (the real handler) is contained the same way', async () => {
  const issuer = makeIssuer();
  const config = loadJcConfig({
    HOME: home,
    JC_STATE_DIR: stateDir,
    JC_RUNTIME_ID: 'jc-test-runtime',
    JC_ACS_PUBLIC_KEY: issuer.publicKeyB64,
    JC_ACS_KEY_ID: issuer.keyId,
    JC_FS_ROOTS: home,
    JC_TRACE_ROOTS: path.join(tmp, 'traces'),
  });
  const server = createJcServer(config, 'managed', { helperAvailable: async () => false });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientTransport);
  const call = (name, args) => client.callTool({ name, arguments: args, _meta: { acsCapability: issuer.mint(name, args) } });
  try {
    const content = await call('start_search', { path: home, pattern: 'FAKE_SECRET|PRIVATE KEY', mode: 'content', regex: true, limit: 100 });
    assert.equal(content.isError, undefined, JSON.stringify(content.structuredContent));
    assertNoLeak(content.structuredContent.results, 'mcp content');
    const names = await call('start_search', { path: home, pattern: '*', mode: 'filename', limit: 100 });
    assertNoLeak(names.structuredContent.results, 'mcp filename');
    // Searching a denied root directly is refused outright.
    const direct = await call('start_search', { path: path.join(home, '.ssh'), pattern: 'x', mode: 'filename' });
    assert.equal(direct.isError, true);
    assert.equal(direct.structuredContent.error.code, 'path_denied');
  } finally {
    await client.close();
  }
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\njace-commander search containment: ${passed} passed`);
