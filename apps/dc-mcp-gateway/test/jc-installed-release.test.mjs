/**
 * Production runtime pin: with JC_REQUIRE_INSTALLED_RELEASE=1 the JC bridge
 * launches only an installed, read-only release selected by JC_RUNTIME_DIR,
 * never the development checkout, and /authority reports that release. The
 * release here is staged like install-user-release.sh does (RELEASE.json,
 * read-only), with node_modules linked to the workspace so the test is offline.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { jcBridgeReady } from '../readiness.js';

const gateway = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(gateway, '..', '..');
const app = path.join(repo, 'apps', 'jace-commander');
const EXECUTION_TOKEN = 'p'.repeat(40);
// ~/.cache does not exist on a fresh CI runner; create it before mkdtemp.
fs.mkdirSync(path.join(os.homedir(), '.cache'), { recursive: true });
const base = fs.mkdtempSync(path.join(os.homedir(), '.cache', 'jc-pin-test-'));

function stageRelease(name, { readOnly = true, releaseJson = true } = {}) {
  const dir = path.join(base, name);
  fs.mkdirSync(dir);
  fs.cpSync(path.join(app, 'dist'), path.join(dir, 'dist'), { recursive: true });
  fs.copyFileSync(path.join(app, 'package.json'), path.join(dir, 'package.json'));
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(dir, 'node_modules'));
  if (releaseJson) fs.writeFileSync(path.join(dir, 'RELEASE.json'), JSON.stringify({ version: '1.0.0', commit: 'testcommit00', installedAt: new Date().toISOString() }));
  if (readOnly) spawnSync('chmod', ['-R', 'a-w', dir]);
  return dir;
}
const release = stageRelease('releases/1.0.0-testcommit00'.replace('/', '-'));
const current = path.join(base, 'current');
fs.symlinkSync(release, current);
const writable = stageRelease('writable', { readOnly: false });
test.after(() => {
  spawnSync('chmod', ['-R', 'u+w', base]);
  fs.rmSync(base, { recursive: true, force: true });
});

const env = (overrides = {}) => {
  const value = {
    PATH: process.env.PATH, HOME: process.env.HOME, BRIDGE_PROFILE: 'jace-commander', ACS_MANAGED_MODE: '1',
    DC_CMD: process.execPath, JC_ACS_PUBLIC_KEY: 'test-key', JC_ACS_KEY_ID: 'test-key-id', JC_RUNTIME_ID: 'jc-pin-test',
    DC_GATEWAY_EXECUTION_TOKEN: EXECUTION_TOKEN, JC_ACS_AUTHORITY_TOKEN: 'read-only-authority',
    JC_STATE_DIR: path.join(base, 'state'), JC_REQUIRE_INSTALLED_RELEASE: '1', JC_RUNTIME_DIR: current,
    ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
  };
  for (const [key, entry] of Object.entries(overrides)) {
    if (entry === undefined) delete value[key];
    else value[key] = entry;
  }
  return value;
};

function refused(overrides, reason) {
  const run = spawnSync(process.execPath, [path.join(gateway, 'bridge.js')], { env: env({ BRIDGE_PORT: '0', ...overrides }), encoding: 'utf8', timeout: 10_000 });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /JC_REQUIRE_INSTALLED_RELEASE=1 but the runtime is not a pinned release/);
  assert.match(run.stderr, reason);
}

function attestation(sub) {
  const iat = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({ sub, client_id: 'pin-test', jti: `j${iat}`, iat, exp: iat + 60 })).toString('base64url');
  return `${body}.${createHmac('sha256', EXECUTION_TOKEN).update(body).digest('base64url')}`;
}

test('the pinned installed release starts, reports its identity and becomes ready', async (t) => {
  const listener = net.createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  let output = '';
  const child = spawn(process.execPath, [path.join(gateway, 'bridge.js')], { env: env({ BRIDGE_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      const exit = once(child, 'exit');
      child.kill();
      await exit;
    }
  });
  const url = `http://127.0.0.1:${port}`;
  let authority;
  for (let i = 0; i < 100 && !authority?.bridge?.upstreamStarted; i += 1) {
    try {
      authority = await (await fetch(`${url}/authority`)).json();
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(authority, output);
  assert.equal(authority.runtime.dir, current);
  assert.equal(authority.runtime.monorepoDefault, false);
  assert.equal(authority.runtime.releaseRequired, true);
  assert.deepEqual(
    { realDir: authority.runtime.installedRelease.realDir, readOnly: authority.runtime.installedRelease.readOnly, commit: authority.runtime.installedRelease.commit },
    { realDir: fs.realpathSync(release), readOnly: true, commit: 'testcommit00' },
  );
  assert.equal(authority.runtime.entrypoint, path.join(current, 'dist', 'cli.js'));
  assert.doesNotMatch(JSON.stringify(authority.runtime), /desktop-commander|apps\/jace-commander/);

  // An attested MCP initialize reaches the release's JC server; the lane is then ready.
  const init = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-dc-agent': 'operator', 'x-dc-attestation': attestation('operator') },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pin-test', version: '1' } } }),
  });
  assert.equal(init.status, 200, output);
  assert.match(await init.text(), /"name":"jace-commander"/);
  const after = await (await fetch(`${url}/authority`)).json();
  assert.equal(jcBridgeReady(after), true, JSON.stringify(after));
});

test('refuses the development checkout', () => refused({ JC_RUNTIME_DIR: app }, /not an installed release/));
test('refuses a writable release', () => refused({ JC_RUNTIME_DIR: writable }, /is writable/));
test('refuses when JC_RUNTIME_DIR is unset (no fallback to the checkout)', () => refused({ JC_RUNTIME_DIR: undefined }, /JC_RUNTIME_DIR is not set/));
test('refuses a DC_ARGS entrypoint override', () => refused({ DC_ARGS: `${path.join(current, 'dist', 'cli.js')} serve` }, /DC_ARGS overrides/));
test('refuses a release staged inside the development checkout', () => {
  const inside = fs.mkdtempSync(path.join(gateway, '.pin-test-'));
  try {
    fs.cpSync(release, path.join(inside, 'r'), { recursive: true, verbatimSymlinks: true });
    spawnSync('chmod', ['-R', 'a-w', path.join(inside, 'r')]);
    refused({ JC_RUNTIME_DIR: path.join(inside, 'r') }, /inside the development checkout/);
  } finally {
    spawnSync('chmod', ['-R', 'u+w', inside]);
    fs.rmSync(inside, { recursive: true, force: true });
  }
});

test('without the pin the development checkout remains usable for development', async (t) => {
  const listener = net.createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const child = spawn(process.execPath, [path.join(gateway, 'bridge.js')], { env: env({ BRIDGE_PORT: String(port), JC_REQUIRE_INSTALLED_RELEASE: undefined, JC_RUNTIME_DIR: undefined }), stdio: 'ignore' });
  t.after(async () => {
    if (child.exitCode === null) {
      const exit = once(child, 'exit');
      child.kill();
      await exit;
    }
  });
  let authority;
  for (let i = 0; i < 100 && !authority; i += 1) {
    try {
      authority = await (await fetch(`http://127.0.0.1:${port}/authority`)).json();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  assert.equal(authority.runtime.monorepoDefault, true);
  assert.equal(authority.runtime.releaseRequired, false);
  assert.equal(authority.runtime.installedRelease, null);
});

test('the CachyOS unit pins the installed release the installer creates', () => {
  const unit = fs.readFileSync(path.join(gateway, 'deploy', 'systemd', 'jace-commander-mcp.service'), 'utf8');
  const installer = fs.readFileSync(path.join(app, 'deploy', 'install-user-release.sh'), 'utf8');
  const environment = Object.fromEntries([...unit.matchAll(/^Environment=([A-Z0-9_]+)=(.*)$/gm)].map((match) => [match[1], match[2]]));
  assert.equal(environment.JC_RUNTIME_DIR, '%h/.local/lib/jace-commander/current');
  assert.equal(environment.JC_REQUIRE_INSTALLED_RELEASE, '1');
  assert.equal(environment.JC_PRESET, 'managed');
  assert.equal(environment.JC_WORKLOAD_ISOLATION, 'bwrap');
  assert.match(installer, /PREFIX="\$\{PREFIX:-\$HOME\/\.local\/lib\/jace-commander\}"/);
  assert.match(installer, /\$PREFIX\/current/);
  // JC itself is never launched from the checkout: no DC_ARGS / JC_DC_DIR in the unit.
  assert.doesNotMatch(unit, /^Environment=(DC_ARGS|JC_DC_DIR)=/m);
  assert.match(unit, /^ExecStart=\/usr\/bin\/node /m);
  assert.equal(environment.JC_ACS_AUTHORITY_TOKEN_FILE, '%h/.config/acs/jc-authority.token');
});

test('the bridge env example does not present JC_ACS_TOKEN as the authority credential', () => {
  const example = fs.readFileSync(path.join(gateway, 'deploy', 'jace-commander-bridge.env.example'), 'utf8');
  assert.match(example, /~\/\.config\/acs\/jc-bridge\.env/);
  assert.match(example, /JC_ACS_AUTHORITY_TOKEN_FILE=%h\/\.config\/acs\/jc-authority\.token/);
  assert.match(example, /role service and scope acs:read ONLY/);
  assert.match(example, /JC_ACS_TOKEN and ACS_WORKER_TOKEN are\n# never used for it/);
  // The old template told operators this commented variable was the required credential.
  assert.doesNotMatch(example, /Required read-scoped credential/);
  assert.doesNotMatch(example, /^JC_ACS_TOKEN=/m);
  assert.doesNotMatch(example, /^JC_RUNTIME_DIR=/m);
  assert.doesNotMatch(example, /^DC_ARGS=/m);
  assert.match(example, /^ACS_GATEWAY_URL=/m);
  assert.match(example, /^ACS_WORKER_TOKEN=/m);
  assert.match(example, /^ACS_WORKER_ID=acs-jc-bridge$/m);
});
