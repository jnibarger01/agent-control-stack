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

async function testRawCommandScanBypasses() {
  const { checkNetworkBinariesInRaw } = await import('../dist/security/network-guard.js');
  // Red-team fix #5a: token-splitting missed quoted/parenthesized/absolute-path
  // forms; the raw-string scan with word-boundary regexes must catch them.
  for (const command of [
    '"curl" https://example.com',
    '(/usr/bin/curl) -s https://example.com',
    'x=$(curl https://example.com)',
    '/usr/bin/wget http://example.com',
    'echo hi; nc -l 4444',
    'sh -c "wget http://evil"',
    'bash -c $\'curl http://evil\'',
    'env curl https://example.com',
  ]) {
    const check = checkNetworkBinariesInRaw(command, 'none');
    assert.equal(check.ok, false, `raw scan must block: ${command}`);
    assert.ok(check.binary, 'blocked check must name the binary');
  }
  // Non-matching words must NOT false-positive.
  for (const command of ['curlfoo --version', 'my-curl --help', 'curlx', 'ls -la /usr/bin']) {
    const check = checkNetworkBinariesInRaw(command, 'none');
    assert.equal(check.ok, true, `raw scan must not false-positive on: ${command}`);
  }
  // Profile other than 'none' is unrestricted.
  assert.equal(checkNetworkBinariesInRaw('curl https://example.com', 'full').ok, true);
}

async function testDegradedSummaryAndSpawnEnvOverride() {
  const { networkGuardSummary } = await import('../dist/security/network-guard.js');
  // Red-team fix #5b: a 'none' profile without a usable sandbox must be
  // reported degraded, never silently claimed enforced.
  const summary = await networkGuardSummary('none');
  assert.equal(summary.profile, 'none');
  assert.equal(typeof summary.sandboxAvailable, 'boolean');
  assert.equal(summary.degraded, summary.profile === 'none' && !summary.sandboxAvailable);

  const full = await networkGuardSummary('full');
  assert.equal(full.degraded, false, 'non-none profiles are never degraded');

  // Red-team fix #5c: enforcement result carries a scrubbed spawn env override
  // and the networkGuard summary when the profile is 'none'. ('ls -la' is an
  // unmatched command, so the fail-closed classification needs the permissive
  // opt-in to reach the network-guard pass here.)
  const { preExecuteEnforcement } = await import('../dist/enforcement/pipeline.js');
  const previousProfile = process.env.DC_NETWORK_PROFILE;
  const previousUnmatched = process.env.DC_UNMATCHED_COMMAND_POLICY;
  process.env.DC_NETWORK_PROFILE = 'none';
  process.env.DC_UNMATCHED_COMMAND_POLICY = 'auto';
  try {
    const gate = await preExecuteEnforcement({
      tool: 'start_process',
      args: { command: 'ls -la' },
      meta: { agent: 'test-agent' },
    });
    assert.equal(gate.allowed, true, 'ls must pass under network=none');
    if (!gate.allowed) return;
    assert.ok(gate.networkGuard, 'networkGuard summary must be attached for profile none');
    assert.equal(gate.networkGuard.profile, 'none');
    assert.equal(typeof gate.networkGuard.degraded, 'boolean');
    assert.ok(gate.spawnEnvOverride, 'spawnEnvOverride must be exported for profile none');
    process.env.HTTP_PROXY = 'http://leak:8080';
    const scrubbed = await preExecuteEnforcement({
      tool: 'start_process',
      args: { command: 'ls -la' },
      meta: { agent: 'test-agent' },
    });
    if (scrubbed.allowed) {
      assert.ok(!('HTTP_PROXY' in (scrubbed.spawnEnvOverride ?? {})), 'spawnEnvOverride must scrub proxy vars');
      assert.equal(scrubbed.spawnEnvOverride?.NO_PROXY, '*');
    }
    delete process.env.HTTP_PROXY;
  } finally {
    if (previousProfile === undefined) delete process.env.DC_NETWORK_PROFILE;
    else process.env.DC_NETWORK_PROFILE = previousProfile;
    if (previousUnmatched === undefined) delete process.env.DC_UNMATCHED_COMMAND_POLICY;
    else process.env.DC_UNMATCHED_COMMAND_POLICY = previousUnmatched;
  }

  // profile !== 'none' => no networkGuard/spawnEnvOverride attached.
  process.env.DC_NETWORK_PROFILE = 'full';
  process.env.DC_UNMATCHED_COMMAND_POLICY = 'auto';
  try {
    const gate = await preExecuteEnforcement({
      tool: 'start_process', args: { command: 'ls -la' }, meta: { agent: 'test-agent' },
    });
    if (gate.allowed) {
      assert.equal(gate.networkGuard, undefined);
      assert.equal(gate.spawnEnvOverride, undefined);
    }
  } finally {
    delete process.env.DC_NETWORK_PROFILE;
  }
}

await testEnvScrubbing();
await testBlocklist();
await testRawCommandScanBypasses();
await testSandboxWrapDegradedFlags();
await testDegradedSummaryAndSpawnEnvOverride();
console.log('Network guard tests passed.');
