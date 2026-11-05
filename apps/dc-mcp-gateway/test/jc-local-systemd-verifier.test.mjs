/**
 * The root-only systemd verifier is a deployment gate, so its refusal paths
 * must be testable without root: it never falls back to a user-namespace
 * approximation, and it refuses to touch a host unless the operator marks the
 * installation disposable.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'deploy', 'verify-local-preset-systemd.sh');

test('the verifier is executable and has a valid shell syntax', () => {
  assert.equal(fs.statSync(script).mode & 0o111, 0o111, 'verifier must be executable');
  const syntax = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test('the verifier refuses to run without root and a disposable opt-in', () => {
  const noRoot = spawnSync(script, { env: { ...process.env, ACS_VERIFY_DISPOSABLE: '1' }, encoding: 'utf8' });
  if (process.getuid?.() === 0) {
    // Root must still refuse without the disposable marker.
    const noFlag = spawnSync(script, { env: { ...process.env, ACS_VERIFY_DISPOSABLE: '' }, encoding: 'utf8' });
    assert.equal(noFlag.status, 2);
    assert.match(noFlag.stderr, /ACS_VERIFY_DISPOSABLE=1/);
  } else {
    assert.equal(noRoot.status, 2);
    assert.match(noRoot.stderr, /must run as root/);
  }
});
