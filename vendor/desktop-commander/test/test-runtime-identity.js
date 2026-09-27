import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getRuntimeIdentityState } from '../dist/runtime-identity.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-runtime-identity-'));
const stateDir = path.join(root, 'state');
const devicePath = path.join(root, 'device.json');
process.env.DESKTOP_COMMANDER_STATE_DIR = stateDir;
process.env.DESKTOP_COMMANDER_DEVICE_CONFIG_PATH = devicePath;

try {
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => getRuntimeIdentityState()));
  const runtimeIds = new Set(concurrent.map((state) => state.runtime_id));
  assert.equal(runtimeIds.size, 1, 'concurrent first use must publish one runtime identity');
  assert.equal(concurrent[0].remote_auth_state, 'not_configured');
  assert.equal(concurrent[0].authorization, 'external');

  const identityPath = path.join(stateDir, 'runtime-identity.json');
  const identityStat = await fs.stat(identityPath);
  assert.equal(identityStat.mode & 0o777, 0o600, 'runtime identity file must be owner-only');
  const directoryStat = await fs.stat(stateDir);
  assert.equal(directoryStat.mode & 0o777, 0o700, 'runtime state directory must be owner-only');

  await fs.writeFile(devicePath, JSON.stringify({
    deviceId: 'device-test-id',
    session: { access_token: 'secret-access', refresh_token: 'secret-refresh' },
  }), { mode: 0o600 });
  const bound = await getRuntimeIdentityState();
  assert.equal(bound.runtime_id, concurrent[0].runtime_id, 'runtime identity must persist');
  assert.equal(bound.device_id, 'device-test-id', 'existing device identity must be reused');
  assert.equal(bound.remote_auth_state, 'persisted');
  const serialized = JSON.stringify(bound);
  assert.equal(serialized.includes('secret-access'), false, 'access token must never be exposed');
  assert.equal(serialized.includes('secret-refresh'), false, 'refresh token must never be exposed');

  await fs.writeFile(devicePath, '{ malformed json', { mode: 0o600 });
  const localOnly = await getRuntimeIdentityState();
  assert.equal(localOnly.runtime_id, concurrent[0].runtime_id);
  assert.equal(localOnly.remote_auth_state, 'unavailable', 'bad optional remote state must not break local identity');

  console.log('runtime identity persistence and redaction tests passed');
} finally {
  delete process.env.DESKTOP_COMMANDER_STATE_DIR;
  delete process.env.DESKTOP_COMMANDER_DEVICE_CONFIG_PATH;
  await fs.rm(root, { recursive: true, force: true });
}
