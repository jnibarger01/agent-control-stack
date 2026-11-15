#!/usr/bin/env node
/**
 * End-to-end integration tests for JACE CLI AUTH V2 (Agent 6 - QA/Release).
 *
 * Covers:
 *  1. Live Linux Secret Service (`secret-tool` + D-Bus `org.freedesktop.secrets`) round-trip
 *     and non-destructive availability probing on the host.
 *  2. Full `jace auth` CLI + `dc-mcp-gateway` integration (auto-active once Phase 3 merges
 *     `gateway` + `forge`, or enforced with `JCA2_INTEGRATION=1`):
 *     - Headless RFC 8628 `jace auth login --device --no-browser` + browser consent approval
 *     - `jace auth status --json`, `jace auth devices --json`, `jace auth revoke`, `jace auth logout`
 *     - Headless `EncryptedFileStore` fallback without D-Bus (`0700`/`0600` perms, no plaintext secrets)
 *     - Cross-process concurrent `jace auth refresh` serialization & recovery
 *
 * Run:
 *   node --test tests/jace-cli-auth-v2/e2e-cli-integration.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GATEWAY_DIR = path.join(REPO_ROOT, 'apps/dc-mcp-gateway');
const JC_CLI_DIST = path.join(REPO_ROOT, 'apps/jace-commander/dist/cli.js');
const REQUIRE_INTEGRATION = process.env.JCA2_INTEGRATION === '1';
const REQUIRE_LINUX_KEYRING = process.env.REQUIRE_LINUX_KEYRING === '1';

function hasBinary(name) {
  try {
    execFileSync('which', [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isSecretServiceUnlocked() {
  if (process.platform !== 'linux' || !process.env.DBUS_SESSION_BUS_ADDRESS || !hasBinary('dbus-send')) {
    return false;
  }
  try {
    const out = execFileSync(
      'dbus-send',
      [
        '--session',
        '--dest=org.freedesktop.secrets',
        '--type=method_call',
        '--print-reply',
        '/org/freedesktop/secrets',
        'org.freedesktop.DBus.Properties.Get',
        'string:org.freedesktop.Secret.Service',
        'string:Collections',
      ],
      { encoding: 'utf8', timeout: 3000 },
    );
    const match = out.match(/object path "([^"]+)"/);
    if (!match) return false;
    const lockedOut = execFileSync(
      'dbus-send',
      [
        '--session',
        '--dest=org.freedesktop.secrets',
        '--type=method_call',
        '--print-reply',
        match[1],
        'org.freedesktop.DBus.Properties.Get',
        'string:org.freedesktop.Secret.Collection',
        'string:Locked',
      ],
      { encoding: 'utf8', timeout: 3000 },
    );
    return /boolean\s+false/.test(lockedOut);
  } catch {
    return false;
  }
}

function isV2Integrated() {
  const gatewayHasDpop = fs.existsSync(path.join(GATEWAY_DIR, 'dpop.js'));
  const cliDistExists = fs.existsSync(JC_CLI_DIST);
  if (!gatewayHasDpop || !cliDistExists) return false;
  try {
    const helpOut = execFileSync(process.execPath, [JC_CLI_DIST, 'help'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    return /\bauth\b/.test(helpOut);
  } catch {
    return false;
  }
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => resolve(addr.port));
    });
  });
}

function startStubServer() {
  const seenRequests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      seenRequests.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return {
    seenRequests,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function bootGateway(extraEnv = {}) {
  const acs = startStubServer();
  const upstream = startStubServer();
  const [acsPort, upstreamPort, port] = await Promise.all([acs.listen(), upstream.listen(), freePort()]);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jca2-qa-gw-'));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: GATEWAY_DIR,
    env: {
      PATH: process.env.PATH,
      GATEWAY_PORT: String(port),
      PUBLIC_ORIGIN: origin,
      CONSENT_PASSPHRASE: 'qa-consent-passphrase',
      SIGNING_KEY: 'a'.repeat(64),
      JC_REFRESH_RECOVERY_KEY: 'b'.repeat(64),
      DATA_DIR: dataDir,
      UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
      JC_ENABLED: '1',
      JC_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
      ACS_GATEWAY_URL: `http://127.0.0.1:${acsPort}`,
      ACS_JC_GATEWAY_TOKEN: 'qa-jc-bridge-token',
      EDGE_TEST_MODE: '1',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let logs = '';
  child.stdout.on('data', (d) => {
    logs += d;
  });
  child.stderr.on('data', (d) => {
    logs += d;
  });

  let healthy = false;
  for (let i = 0; i < 60 && !healthy; i += 1) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`${origin}/healthz`);
      healthy = res.ok;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert.ok(healthy, `dc-mcp-gateway failed to start: ${logs}`);

  return {
    origin,
    mcpUrl: `${origin}/jc/mcp`,
    dataDir,
    passphrase: 'qa-consent-passphrase',
    logs: () => logs,
    async close() {
      child.kill('SIGKILL');
      await Promise.all([acs.close(), upstream.close()]);
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [JC_CLI_DIST, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function approveDeviceCode(origin, userCode, passphrase) {
  const formBody = new URLSearchParams({ user_code: userCode, passphrase, action: 'approve' }).toString();
  const res = await fetch(`${origin}/jc/device`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: formBody,
    redirect: 'manual',
  });
  assert.ok(res.status >= 200 && res.status < 400, `device approval failed with HTTP ${res.status}: ${await res.text()}`);
}

function collectFilesRecursive(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Live Linux Secret Service (`secret-tool`) Verification
// ---------------------------------------------------------------------------
test('Linux Secret Service (secret-tool) live store/lookup/clear round-trip', {
  skip: !REQUIRE_LINUX_KEYRING && (!hasBinary('secret-tool') || !isSecretServiceUnlocked())
    ? 'unlocked Linux Secret Service (secret-tool + DBUS_SESSION_BUS_ADDRESS) not available'
    : false,
}, () => {
  assert.equal(hasBinary('secret-tool'), true, 'secret-tool binary must be installed');
  assert.equal(isSecretServiceUnlocked(), true, 'org.freedesktop.secrets collection must be unlocked');

  const id = crypto.randomUUID();
  const service = `jace-cli-auth-v2-qa-${id}`;
  const account = `probe-${id}`;
  const secretValue = JSON.stringify({ probe: id, token: 'qa-ephemeral-secret' });

  try {
    execFileSync(
      'secret-tool',
      ['store', `--label=JACE QA Probe ${id}`, 'service', service, 'account', account],
      { input: secretValue, encoding: 'utf8', timeout: 5000 },
    );

    const lookedUp = execFileSync('secret-tool', ['lookup', 'service', service, 'account', account], {
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(lookedUp, secretValue, 'secret-tool lookup must return exact stored secret');
  } finally {
    execFileSync('secret-tool', ['clear', 'service', service, 'account', account], {
      encoding: 'utf8',
      timeout: 5000,
    });
  }

  let clearedLookupFailed = false;
  try {
    execFileSync('secret-tool', ['lookup', 'service', service, 'account', account], {
      encoding: 'utf8',
      timeout: 5000,
    });
  } catch {
    clearedLookupFailed = true;
  }
  assert.equal(clearedLookupFailed, true, 'secret-tool lookup after clear must fail');
});

// ---------------------------------------------------------------------------
// 2. Full E2E CLI + Gateway Integration Suite (active once Phase 3 integrates)
// ---------------------------------------------------------------------------
const integrated = isV2Integrated();
const integrationSkip = !REQUIRE_INTEGRATION && !integrated
  ? 'awaiting Phase 3 integration of gateway + forge (set JCA2_INTEGRATION=1 to require)'
  : false;

test('E2E: jace auth device login, status, devices, revoke, logout with live Linux SecretServiceStore', {
  skip: integrationSkip || (!hasBinary('secret-tool') || !isSecretServiceUnlocked()
    ? 'unlocked Linux Secret Service required for live SecretServiceStore E2E'
    : false),
}, async () => {
  assert.equal(integrated, true, 'V2 CLI and gateway artifacts must be present');
  const gw = await bootGateway();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jca2-qa-cli-keyring-'), { mode: 0o700 });
  const env = {
    JC_STATE_DIR: stateDir,
    JC_MCP_URL: gw.mcpUrl,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
  };

  try {
    // Start `jace auth login --device --no-browser` and approve the printed user_code
    let loginOut = '';
    let loginErr = '';
    const loginProc = spawn(
      process.execPath,
      [JC_CLI_DIST, 'auth', 'login', '--device', '--no-browser', '--mcp-url', gw.mcpUrl, '--label', 'qa-linux-e2e'],
      { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const userCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for user_code; out=${loginOut} err=${loginErr}`)), 10_000);
      const inspect = (chunk, isErr) => {
        if (isErr) loginErr += chunk;
        else loginOut += chunk;
        const combined = `${loginOut}\n${loginErr}`;
        const codeMatch = combined.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/) || combined.match(/user_code=([A-Za-z0-9_-]+)/);
        if (codeMatch) {
          clearTimeout(timer);
          resolve(codeMatch[1]);
        }
      };
      loginProc.stdout.on('data', (d) => inspect(d.toString('utf8'), false));
      loginProc.stderr.on('data', (d) => inspect(d.toString('utf8'), true));
      loginProc.once('close', (code) => {
        clearTimeout(timer);
        reject(new Error(`login exited prematurely (${code}); out=${loginOut} err=${loginErr}`));
      });
    });

    await approveDeviceCode(gw.origin, userCode, gw.passphrase);
    const loginExit = await new Promise((resolve) => loginProc.once('close', resolve));
    assert.equal(loginExit, 0, `login failed: out=${loginOut} err=${loginErr}`);
    assert.doesNotMatch(loginOut + loginErr, /BEGIN PRIVATE KEY|refresh_token/);

    // Verify status --json (metadata only, zero secrets)
    const statusRes = await runCli(['auth', 'status', '--json'], env);
    assert.equal(statusRes.code, 0, `status failed: ${statusRes.stderr}`);
    const status = JSON.parse(statusRes.stdout);
    const deviceId = status.device_id ?? status.deviceId;
    assert.ok(deviceId, `expected device_id in status: ${statusRes.stdout}`);
    assert.ok(status.jkt, `expected jkt in status: ${statusRes.stdout}`);
    assert.equal(status.accessToken, undefined, 'status --json must never expose accessToken');
    assert.equal(status.refreshToken, undefined, 'status --json must never expose refreshToken');
    assert.match(String(status.storage_backend ?? status.storageBackend ?? ''), /secret-service|kwallet/i);

    // Verify devices --json
    const devicesRes = await runCli(['auth', 'devices', '--json'], env);
    assert.equal(devicesRes.code, 0, `devices failed: ${devicesRes.stderr}`);
    const devicesPayload = JSON.parse(devicesRes.stdout);
    const list = Array.isArray(devicesPayload) ? devicesPayload : devicesPayload.devices;
    assert.ok(Array.isArray(list) && list.some((d) => (d.device_id ?? d.deviceId) === deviceId), 'device must be listed');

    // Revoke device and confirm subsequent refresh fails closed
    const revokeRes = await runCli(['auth', 'revoke', deviceId], env);
    assert.equal(revokeRes.code, 0, `revoke failed: ${revokeRes.stderr}`);
    const refreshAfterRevoke = await runCli(['auth', 'refresh'], env);
    assert.notEqual(refreshAfterRevoke.code, 0, 'refresh after device revocation must fail closed');

    // Local logout
    const logoutRes = await runCli(['auth', 'logout'], env);
    assert.equal(logoutRes.code, 0, `logout failed: ${logoutRes.stderr}`);
  } finally {
    await gw.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('E2E: Headless EncryptedFileStore fallback without D-Bus enforces 0700/0600 and encrypts secrets', {
  skip: integrationSkip,
}, async () => {
  assert.equal(integrated, true, 'V2 CLI and gateway artifacts must be present');
  const gw = await bootGateway();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jca2-qa-cli-headless-'), { mode: 0o700 });
  const keyFile = path.join(os.tmpdir(), `jca2-qa-key-${crypto.randomUUID()}`);
  fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });

  const env = {
    JC_STATE_DIR: stateDir,
    JC_MCP_URL: gw.mcpUrl,
    DBUS_SESSION_BUS_ADDRESS: '',
    JC_KEYRING_KEY_FILE: keyFile,
    JC_KEYRING_PASSPHRASE: 'qa-headless-test-passphrase',
  };

  try {
    let loginOut = '';
    const loginProc = spawn(
      process.execPath,
      [JC_CLI_DIST, 'auth', 'login', '--device', '--no-browser', '--mcp-url', gw.mcpUrl, '--label', 'qa-headless'],
      { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const userCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for user_code; out=${loginOut}`)), 10_000);
      loginProc.stdout.on('data', (d) => {
        loginOut += d.toString('utf8');
        const m = loginOut.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/) || loginOut.match(/user_code=([A-Za-z0-9_-]+)/);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      loginProc.once('close', (code) => {
        clearTimeout(timer);
        reject(new Error(`headless login exited (${code}): ${loginOut}`));
      });
    });

    await approveDeviceCode(gw.origin, userCode, gw.passphrase);
    const loginExit = await new Promise((resolve) => loginProc.once('close', resolve));
    assert.equal(loginExit, 0);

    const statusRes = await runCli(['auth', 'status', '--json'], env);
    assert.equal(statusRes.code, 0, statusRes.stderr);
    const status = JSON.parse(statusRes.stdout);
    assert.match(String(status.storage_backend ?? status.storageBackend ?? ''), /encrypted/i);

    assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700, 'stateDir must be 0700');
    for (const file of collectFilesRecursive(stateDir)) {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600, `file ${file} must be 0600`);
      const content = fs.readFileSync(file, 'utf8');
      assert.doesNotMatch(content, /BEGIN PRIVATE KEY/, `raw private key must not appear in ${file}`);
      assert.doesNotMatch(content, /"refreshToken"\s*:/, `raw refreshToken must not appear in ${file}`);
    }
  } finally {
    await gw.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(keyFile, { force: true });
  }
});

test('E2E: Cross-process concurrent `jace auth refresh` serializes cleanly without device revocation', {
  skip: integrationSkip,
}, async () => {
  assert.equal(integrated, true, 'V2 CLI and gateway artifacts must be present');
  const gw = await bootGateway({ EDGE_TEST_ACCESS_TTL_S: '2' });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jca2-qa-cli-refresh-'), { mode: 0o700 });
  const env = {
    JC_STATE_DIR: stateDir,
    JC_MCP_URL: gw.mcpUrl,
    DBUS_SESSION_BUS_ADDRESS: '',
    JC_KEYRING_PASSPHRASE: 'qa-concurrent-refresh-passphrase',
  };

  try {
    let loginOut = '';
    const loginProc = spawn(
      process.execPath,
      [JC_CLI_DIST, 'auth', 'login', '--device', '--no-browser', '--mcp-url', gw.mcpUrl, '--label', 'qa-refresh'],
      { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const userCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for user_code; out=${loginOut}`)), 10_000);
      loginProc.stdout.on('data', (d) => {
        loginOut += d.toString('utf8');
        const m = loginOut.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/) || loginOut.match(/user_code=([A-Za-z0-9_-]+)/);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      loginProc.once('close', (code) => {
        clearTimeout(timer);
        reject(new Error(`login exited (${code}): ${loginOut}`));
      });
    });

    await approveDeviceCode(gw.origin, userCode, gw.passphrase);
    const loginExit = await new Promise((resolve) => loginProc.once('close', resolve));
    assert.equal(loginExit, 0);

    const [r1, r2] = await Promise.all([runCli(['auth', 'refresh'], env), runCli(['auth', 'refresh'], env)]);
    assert.equal(r1.code, 0, `concurrent refresh 1 failed: ${r1.stderr}`);
    assert.equal(r2.code, 0, `concurrent refresh 2 failed: ${r2.stderr}`);

    const statusAfter = await runCli(['auth', 'status', '--json'], env);
    assert.equal(statusAfter.code, 0, statusAfter.stderr);
    const parsed = JSON.parse(statusAfter.stdout);
    assert.ok(parsed.device_id ?? parsed.deviceId, 'device must remain active after concurrent refresh');
  } finally {
    await gw.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
