import assert from 'node:assert/strict';
import {
  scrubEnvironmentForNoNetwork,
  buildSandboxCommand,
  checkNetworkBinaries,
  NETWORK_BLOCKLIST_BINARIES,
} from '../dist/security/network-guard.js';

async function testEnvScrubbing() {
  const result = scrubEnvironmentForNoNetwork({
    HTTP_PROXY: 'http://proxy:8080',
    https_proxy: 'http://proxy:8080',
    ALL_PROXY: 'socks5://proxy',
    NO_PROXY: 'localhost',
    PATH: '/usr/bin',
    HOME: '/home/jacen',
  });
  assert.ok(!('HTTP_PROXY' in result.env), 'HTTP_PROXY must be removed');
  assert.ok(!('https_proxy' in result.env), 'https_proxy must be removed');
  assert.ok(!('ALL_PROXY' in result.env), 'ALL_PROXY must be removed');
  assert.equal(result.env.NO_PROXY, '*', 'NO_PROXY must be forced to wildcard');
  assert.equal(result.env.no_proxy, '*', 'no_proxy must be forced to wildcard');
  assert.equal(result.env.PATH, '/usr/bin', 'unrelated vars must be preserved');
  assert.ok(!result.degraded, 'env scrubbing never degrades');
  assert.deepEqual(result.removedKeys.sort(), ['ALL_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy']);

  // Spawn-options wrapping: env injection applies to a copied env, not the live process.env
  process.env.HTTP_PROXY = 'http://leak:1';
  const injected = scrubEnvironmentForNoNetwork();
  assert.ok(!('HTTP_PROXY' in injected.env), 'injected spawn env must not contain proxy vars');
  assert.equal(process.env.HTTP_PROXY, 'http://leak:1', 'live process.env must be untouched');
  delete process.env.HTTP_PROXY;
}

async function testBlocklist() {
  const blocked = checkNetworkBinaries(['curl', '-sSf', 'https://example.com'], 'none');
  assert.equal(blocked.ok, false, 'curl must be rejected under network=none');
  assert.equal(blocked.binary, 'curl');

  const sshPath = checkNetworkBinaries(['/usr/bin/ssh', 'host'], 'none');
  assert.equal(sshPath.ok, false, 'ssh via absolute path must be rejected');

  const wget = checkNetworkBinaries(['wget'], 'none');
  assert.equal(wget.ok, false);

  const allowed = checkNetworkBinaries(['ls', '-la'], 'none');
  assert.equal(allowed.ok, true);

  const fullProfile = checkNetworkBinaries(['curl'], 'full');
  assert.equal(fullProfile.ok, true, 'blocklist only applies to network=none');

  for (const binary of NETWORK_BLOCKLIST_BINARIES) {
    assert.equal(checkNetworkBinaries([binary], 'none').ok, false, `${binary} must be blocklisted`);
  }
}

async function testSandboxWrapDegradedFlags() {
  // Sandbox disabled by config => degraded, never claims isolation.
  const disabled = await buildSandboxCommand(['ls'], { allowsSandbox: false });
  assert.equal(disabled.wrapped, false);
  assert.equal(disabled.degraded, true);
  assert.deepEqual(disabled.argv, ['ls']);

  // Non-Linux platform => degraded.
  const darwin = await buildSandboxCommand(['ls'], { allowsSandbox: true, platform: 'darwin' });
  assert.equal(darwin.wrapped, false);
  assert.equal(darwin.degraded, true);

  // Probe failure (e.g. unprivileged netns denied) => degraded flag, honest reason.
  const failed = await buildSandboxCommand(['ls'], {
    allowsSandbox: true,
    platform: 'linux',
    probe: async () => ({ ok: false }),
  });
  assert.equal(failed.wrapped, false);
  assert.equal(failed.degraded, true, 'failed probe must set degraded=true, not claim blocked');
  assert.match(failed.reason, /unshare|unavailable|probe/i);

  // Probe success => wrapped.
  const ok = await buildSandboxCommand(['ls', '-la'], {
    allowsSandbox: true,
    platform: 'linux',
    probe: async () => ({ ok: true }),
  });
  assert.equal(ok.wrapped, true);
  assert.equal(ok.degraded, false);
  assert.deepEqual(ok.argv, ['unshare', '-n', 'ls', '-la']);
}

await testEnvScrubbing();
await testBlocklist();
await testSandboxWrapDegradedFlags();
console.log('Network guard tests passed.');
