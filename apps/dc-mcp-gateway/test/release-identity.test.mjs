import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createReleaseMetadata, verifyRelease } from '../release-integrity.js';
import { dcRuntimeIdentityFromState } from '../managed.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-dc-release-identity-'));
  const release = path.join(root, 'dc', 'fixture');
  const node = path.join(root, '_node', 'v24.18.0', 'bin', 'node');
  const state = path.join(root, 'state');
  fs.mkdirSync(path.join(release, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(release, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.dirname(node), { recursive: true });
  fs.mkdirSync(state);
  fs.writeFileSync(node, '#!/bin/sh\nprintf "v24.18.0\\n"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(release, 'dist/index.js'), 'fixture entrypoint');
  fs.writeFileSync(path.join(release, 'package.json'), '{"name":"fixture"}');
  fs.writeFileSync(path.join(release, 'package-lock.json'), '{}');
  fs.writeFileSync(path.join(release, 'node_modules/dependency.js'), 'fixture dependency');
  fs.writeFileSync(path.join(state, 'runtime-identity.json'), '{"runtimeId":"fixture-runtime"}');
  const metadata = createReleaseMetadata(release, { commit: 'a'.repeat(40), nodePath: node });
  const env = {
    ACS_DC_RELEASE_DIR: release,
    ACS_DC_ENTRYPOINT: path.join(release, 'dist/index.js'),
    DESKTOP_COMMANDER_STATE_DIR: state,
    ACS_DC_RUNTIME_SCOPES: 'fs.read,process.exec',
  };
  return { root, release, node, state, metadata, env };
}

test('managed bootstrap uses the verified release digest rather than the entrypoint hash', () => {
  const f = fixture();
  try {
    assert.equal(verifyRelease(f.release).runtimeIdentityDigest, f.metadata.runtimeIdentityDigest);
    const actual = dcRuntimeIdentityFromState(f.env);
    assert.deepEqual(actual, {
      runtimeId: 'fixture-runtime',
      identityConfigFingerprint: f.metadata.runtimeIdentityDigest,
      scopes: ['fs.read', 'process.exec'],
    });
    assert.notEqual(actual.identityConfigFingerprint,
      crypto.createHash('sha256').update(fs.readFileSync(f.env.ACS_DC_ENTRYPOINT)).digest('hex'));
    const withoutExplicitEntrypoint = { ...f.env };
    delete withoutExplicitEntrypoint.ACS_DC_ENTRYPOINT;
    assert.deepEqual(dcRuntimeIdentityFromState(withoutExplicitEntrypoint), actual);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

for (const [name, corrupt] of [
  ['entrypoint bytes', (f) => fs.appendFileSync(f.env.ACS_DC_ENTRYPOINT, 'tampered')],
  ['dependency bytes', (f) => fs.appendFileSync(path.join(f.release, 'node_modules/dependency.js'), 'tampered')],
  ['manifest digest', (f) => fs.writeFileSync(path.join(f.release, 'RELEASE-MANIFEST.json'), '{}')],
  ['runtime digest', (f) => {
    const metadata = { ...f.metadata, runtimeIdentityDigest: 'b'.repeat(64) };
    fs.writeFileSync(path.join(f.release, 'RELEASE.json'), JSON.stringify(metadata));
  }],
  ['pinned Node bytes', (f) => fs.appendFileSync(f.node, '# tampered\n')],
  ['missing metadata', (f) => fs.unlinkSync(path.join(f.release, 'RELEASE.json'))],
  ['linked metadata', (f) => {
    fs.renameSync(path.join(f.release, 'RELEASE.json'), path.join(f.root, 'metadata.json'));
    fs.symlinkSync(path.join(f.root, 'metadata.json'), path.join(f.release, 'RELEASE.json'));
  }],
  ['entrypoint outside release', (f) => { f.env.ACS_DC_ENTRYPOINT = path.join(f.root, 'other.js'); }],
  ['relative release directory', (f) => { f.env.ACS_DC_RELEASE_DIR = 'relative'; }],
  ['empty configured release directory', (f) => { f.env.ACS_DC_RELEASE_DIR = ''; }],
  ['linked release directory', (f) => {
    const linked = path.join(f.root, 'dc', 'linked');
    fs.symlinkSync(f.release, linked);
    f.env.ACS_DC_RELEASE_DIR = linked;
    f.env.ACS_DC_ENTRYPOINT = path.join(linked, 'dist/index.js');
  }],
]) {
  test(`configured release fails closed for ${name}; no development-hash fallback`, () => {
    const f = fixture();
    try { corrupt(f); assert.equal(dcRuntimeIdentityFromState(f.env), null); }
    finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
}

test('unpackaged development preserves entrypoint hashing when no release is configured', () => {
  const f = fixture();
  try {
    delete f.env.ACS_DC_RELEASE_DIR;
    assert.equal(dcRuntimeIdentityFromState(f.env).identityConfigFingerprint,
      crypto.createHash('sha256').update(fs.readFileSync(f.env.ACS_DC_ENTRYPOINT)).digest('hex'));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('verification never executes a tampered pinned Node binary', () => {
  const f = fixture();
  const marker = path.join(f.root, 'tampered-node-executed');
  try {
    fs.writeFileSync(f.node, `#!/bin/sh\ntouch '${marker}'\nprintf "v24.18.0\\n"\n`);
    assert.equal(dcRuntimeIdentityFromState(f.env), null);
    assert.equal(fs.existsSync(marker), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('missing executable hash cannot authorize a pinned Node version probe', () => {
  const f = fixture();
  const marker = path.join(f.root, 'unbound-node-executed');
  try {
    const metadata = JSON.parse(fs.readFileSync(path.join(f.release, 'RELEASE.json'), 'utf8'));
    delete metadata.node.sha256;
    fs.writeFileSync(path.join(f.release, 'RELEASE.json'), JSON.stringify(metadata));
    fs.writeFileSync(f.node, `#!/bin/sh\ntouch '${marker}'\nprintf "v24.18.0\\n"\n`);
    assert.equal(dcRuntimeIdentityFromState(f.env), null);
    assert.equal(fs.existsSync(marker), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
