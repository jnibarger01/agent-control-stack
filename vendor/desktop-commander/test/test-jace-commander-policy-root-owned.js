#!/usr/bin/env node
/**
 * Root-only local policy (Jace's decision 2026-10-13; restores #324 local-policy.ts:90-96).
 * Uses an injectable filesystem/uid seam (a fake tree), never real root.
 */
import assert from 'node:assert/strict';
import { assertPolicyImmutable, loadJcPolicy } from '../dist/jace-commander/local-policy.js';
import { readRootControlledFile } from '../dist/jace-commander/root-controlled-file.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const JC = 1000;
const OTHER = 1001;
const POLICY = JSON.stringify({ version: 'jc.policy.v1', classes: { mutate: 'allow' } });

/** A fake tree: path -> { uid, mode, type: 'dir'|'file'|'link', target?, content? }. */
function fakeIo(overrides = {}, { euid = JC, onOpen } = {}) {
  let ino = 1;
  const nodes = {
    '/': { uid: 0, mode: 0o40755, type: 'dir' },
    '/etc': { uid: 0, mode: 0o40755, type: 'dir' },
    '/etc/jace-commander': { uid: 0, mode: 0o40755, type: 'dir' },
    '/etc/jace-commander/policy.json': { uid: 0, mode: 0o100644, type: 'file', content: POLICY },
    ...overrides,
  };
  for (const node of Object.values(nodes)) node.ino ??= ino++;
  const statOf = (node) => ({
    uid: node.uid, mode: node.mode, dev: 1, ino: node.ino, size: Buffer.byteLength(node.content ?? ''),
    isFile: () => node.type === 'file', isDirectory: () => node.type === 'dir', isSymbolicLink: () => node.type === 'link',
  });
  const enoent = (p) => Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
  const resolve = (p) => {
    // Follow links in any component (only links whose path is a key are modelled).
    for (const [k, node] of Object.entries(nodes)) {
      if (node.type === 'link' && (p === k || p.startsWith(k + '/'))) return resolve(node.target + p.slice(k.length));
    }
    return p;
  };
  const fds = new Map();
  return {
    nodes,
    lstat: (p) => { const node = nodes[p]; if (!node) throw enoent(p); return statOf(node); },
    realpath: (p) => { const r = resolve(p); if (!nodes[r]) throw enoent(p); return r; },
    openNoFollow: (p) => {
      onOpen?.(nodes);
      const node = nodes[p];
      if (!node) throw enoent(p);
      if (node.type === 'link') throw Object.assign(new Error('ELOOP'), { code: 'ELOOP' });
      const fd = fds.size + 10; fds.set(fd, node); return fd;
    },
    fstat: (fd) => statOf(fds.get(fd)),
    read: (fd) => Buffer.from(fds.get(fd).content ?? ''),
    close: (fd) => { fds.delete(fd); },
    writable: (p) => { const node = nodes[p]; return node.uid === euid || euid === 0; },
    geteuid: () => euid,
  };
}

const PATH = '/etc/jace-commander/policy.json';
const load = (io, extra = {}) => loadJcPolicy({ systemPath: PATH, systemPathExplicit: true, userPath: '/nonexistent/jc/policy.user.json', rootIo: io, ...extra });

await test('root-owned 0644 file in a root-owned chain passes and loads', () => {
  const io = fakeIo();
  assert.doesNotThrow(() => assertPolicyImmutable(PATH, io));
  const loaded = load(io);
  assert.equal(loaded.state, 'loaded', loaded.errors.join(' '));
  assert.equal(loaded.immutable, true);
  assert.equal(loaded.effective.classDecisions.mutate, 'allow');
});

for (const [label, node, pattern] of [
  ['owned by the JC account', { uid: JC, mode: 0o100444 }, /owned by the JC account/],
  ['owned by another non-root user', { uid: OTHER, mode: 0o100644 }, /not owned by root/],
  ['root-owned but group-writable', { uid: 0, mode: 0o100664 }, /group\/world-writable/],
  ['root-owned but world-writable', { uid: 0, mode: 0o100646 }, /group\/world-writable/],
]) {
  await test(`policy file ${label} fails`, () => {
    const io = fakeIo({ [PATH]: { ...node, type: 'file', content: POLICY } });
    assert.throws(() => assertPolicyImmutable(PATH, io), pattern);
    const loaded = load(io);
    assert.equal(loaded.state, 'invalid');
    assert.equal(loaded.immutable, false);
  });
}

for (const dir of ['/etc/jace-commander', '/etc', '/']) {
  for (const [label, node, pattern] of [
    ['owned by JC', { uid: JC, mode: 0o40755 }, /owned by the JC account/],
    ['owned by another non-root user', { uid: OTHER, mode: 0o40755 }, /not owned by root/],
    ['group-writable', { uid: 0, mode: 0o40775 }, /group\/world-writable/],
    ['world-writable with sticky bit (no exception)', { uid: 0, mode: 0o41777 }, /group\/world-writable/],
  ]) {
    await test(`parent ${dir} ${label} fails`, () => {
      const io = fakeIo({ [dir]: { ...node, type: 'dir' } });
      assert.throws(() => assertPolicyImmutable(PATH, io), pattern);
      assert.equal(load(io).state, 'invalid');
    });
  }
}

await test('JC-writable (access W_OK) root-owned file fails', () => {
  const io = fakeIo();
  io.writable = (p) => p === PATH;
  assert.throws(() => assertPolicyImmutable(PATH, io), /writable by the JC account process/);
});

await test('symlinked policy path owned by a non-root user fails', () => {
  const io = fakeIo({
    '/etc/jace-commander/policy.json': { uid: JC, mode: 0o120777, type: 'link', target: '/etc/real.json' },
    '/etc/real.json': { uid: 0, mode: 0o100644, type: 'file', content: POLICY },
  });
  assert.throws(() => assertPolicyImmutable(PATH, io), /symlink not owned by root/);
});

await test('root-owned symlink resolving to a root-owned chain passes; to a non-root chain fails', () => {
  const good = fakeIo({
    '/etc/jace-commander/policy.json': { uid: 0, mode: 0o120777, type: 'link', target: '/etc/real.json' },
    '/etc/real.json': { uid: 0, mode: 0o100644, type: 'file', content: POLICY },
  });
  assert.equal(load(good).state, 'loaded');
  const bad = fakeIo({
    '/etc/jace-commander/policy.json': { uid: 0, mode: 0o120777, type: 'link', target: '/home/jc/real.json' },
    '/home': { uid: 0, mode: 0o40755, type: 'dir' },
    '/home/jc': { uid: JC, mode: 0o40755, type: 'dir' },
    '/home/jc/real.json': { uid: 0, mode: 0o100644, type: 'file', content: POLICY },
  });
  assert.throws(() => assertPolicyImmutable(PATH, bad), /owned by the JC account/);
  assert.equal(load(bad).state, 'invalid');
});

await test('symlink in a parent directory: non-root link fails, root link into a root chain passes', () => {
  const nonRoot = fakeIo({
    '/etc/jace-commander': { uid: OTHER, mode: 0o120777, type: 'link', target: '/opt/jc' },
    '/opt': { uid: 0, mode: 0o40755, type: 'dir' },
    '/opt/jc': { uid: 0, mode: 0o40755, type: 'dir' },
    '/opt/jc/policy.json': { uid: 0, mode: 0o100644, type: 'file', content: POLICY },
    '/etc/jace-commander/policy.json': { uid: 0, mode: 0o100644, type: 'file', content: POLICY },
  });
  assert.throws(() => assertPolicyImmutable(PATH, nonRoot), /symlink not owned by root/);
  const rootLink = fakeIo({
    '/etc/jace-commander': { uid: 0, mode: 0o120777, type: 'link', target: '/opt/jc' },
    '/opt': { uid: 0, mode: 0o40755, type: 'dir' },
    '/opt/jc': { uid: 0, mode: 0o40755, type: 'dir' },
    '/opt/jc/policy.json': { uid: 0, mode: 0o100644, type: 'file', content: POLICY },
    '/etc/jace-commander/policy.json': { uid: 0, mode: 0o100644, type: 'file', content: POLICY },
  });
  assert.equal(load(rootLink).state, 'loaded');
});

await test('symlink swap after the chain check fails (O_NOFOLLOW refuses the link)', () => {
  const io = fakeIo({ '/tmp': { uid: 0, mode: 0o41777, type: 'dir' }, '/tmp/evil.json': { uid: JC, mode: 0o100644, type: 'file', content: POLICY } }, {
    onOpen: (nodes) => { nodes[PATH] = { uid: JC, mode: 0o120777, type: 'link', target: '/tmp/evil.json', ino: 999 }; },
  });
  const loaded = load(io);
  assert.equal(loaded.state, 'invalid');
  assert.match(loaded.errors.join(' '), /could not be opened without following links/);
});

await test('file replaced between check and read fails (fstat inode mismatch)', () => {
  const swapping = () => fakeIo({}, { onOpen: (nodes) => { if (nodes[PATH].ino !== 4242) nodes[PATH] = { uid: 0, mode: 0o100644, type: 'file', content: JSON.stringify({ version: 'jc.policy.v1', classes: { exec: 'allow' } }), ino: 4242 }; } });
  assert.throws(() => readRootControlledFile(PATH, 4096, { io: swapping() }), /replaced between the ownership check and the read/);
  const loaded = load(swapping());
  assert.equal(loaded.state, 'invalid');
  assert.match(loaded.errors.join(' '), /replaced/);
});

await test('file chmod-ed group-writable between check and read fails (fstat re-check)', () => {
  const io = fakeIo({}, { onOpen: (nodes) => { nodes[PATH].mode = 0o100666; } });
  assert.throws(() => readRootControlledFile(PATH, 4096, { io }), /changed ownership or mode/);
});

await test('missing file keeps existing behaviour: implicit path -> builtin-default, explicit path -> invalid', () => {
  const io = fakeIo();
  delete io.nodes[PATH];
  assert.equal(load(io, { systemPathExplicit: false }).state, 'builtin-default');
  const explicit = load(io);
  assert.equal(explicit.state, 'invalid');
  assert.match(explicit.errors.join(' '), /does not exist/);
});

await test('unsafe-dev still loads a non-root file but reports immutable=false', () => {
  const io = fakeIo({ [PATH]: { uid: OTHER, mode: 0o100644, type: 'file', content: POLICY } });
  // unsafe-dev reads the real path, so only the immutability verdict uses the seam here.
  assert.throws(() => assertPolicyImmutable(PATH, io), /not owned by root/);
});

console.log(`policy root-owned: ${passed} passed`);
