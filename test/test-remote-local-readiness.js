import assert from 'node:assert/strict';
import { MCPDevice } from '../dist/remote-device/device.js';
import { DesktopCommanderIntegration } from '../dist/remote-device/desktop-commander-integration.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

const integration = new DesktopCommanderIntegration(true);
let disconnected = null;
integration.onDisconnect((reason) => { disconnected = reason; });
integration.isReady = true;
integration.mcpClient = {};
integration.mcpTransport = {};
integration.handleLocalDisconnect('stdio transport closed');
assert.equal(integration.ready, false, 'transport loss must clear local MCP readiness');
assert.equal(disconnected, 'stdio transport closed');

const device = new MCPDevice();
const statusWrites = [];
let ensured = false;
device.deviceId = 'device-1';
device.desktop = {
  ready: false,
  ensureReady: async () => { ensured = true; device.desktop.ready = true; },
};
device.remoteChannel = {
  setOnlineStatus: async (_id, status) => statusWrites.push(status),
  syncReachabilityStatus: () => statusWrites.push('sync'),
};
await device.handleLocalMcpLoss('stdio transport closed');
assert.deepEqual(statusWrites, ['offline', 'sync']);
assert.equal(ensured, true);

console.log('remote local readiness tests passed');

import { localMcpRetryDelayMs, LOCAL_MCP_RETRY_MAX_MS } from '../dist/remote-device/device.js';

// Backoff: exponential, jittered into [50%,100%], capped at 60s.
assert.equal(localMcpRetryDelayMs(0, () => 1), 1000);
assert.equal(localMcpRetryDelayMs(0, () => 0), 500);
assert.equal(localMcpRetryDelayMs(3, () => 1), 8000);
assert.equal(localMcpRetryDelayMs(10, () => 1), LOCAL_MCP_RETRY_MAX_MS);
assert.equal(localMcpRetryDelayMs(1000, () => 1), LOCAL_MCP_RETRY_MAX_MS);
assert.equal(localMcpRetryDelayMs(-5, () => 1), 1000);

// A failed re-attach keeps retrying until it succeeds (the 03:32 outage:
// one failure left the device present but never ready again).
{
  const d = new MCPDevice();
  const writes = [];
  const sleeps = [];
  let attempts = 0;
  d.deviceId = 'device-2';
  d.desktop = {
    ready: false,
    ensureReady: async () => { attempts += 1; if (attempts < 4) throw new Error('Error POSTing to endpoint:'); d.desktop.ready = true; },
  };
  d.remoteChannel = {
    setOnlineStatus: async (_id, status) => writes.push(status),
    syncReachabilityStatus: () => writes.push('sync'),
  };
  d.sleep = async (ms) => { sleeps.push(ms); };
  const quiet = console.error; console.error = () => {};
  try { await d.handleLocalMcpLoss('managed HTTP transport closed'); } finally { console.error = quiet; }
  assert.equal(attempts, 4, 'must retry until attach succeeds');
  assert.equal(sleeps.length, 3, 'one backoff sleep per failure');
  assert.ok(sleeps[1] >= sleeps[0] / 2 && sleeps.every((ms) => ms > 0 && ms <= LOCAL_MCP_RETRY_MAX_MS));
  assert.deepEqual(writes, ['offline', 'sync'], 'ready is republished only after a successful attach');
  assert.equal(d.localMcpRecovery, null, 'recovery slot released');
}

// Concurrent losses join one recovery loop (single-flight).
{
  const d = new MCPDevice();
  let attempts = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  d.deviceId = 'device-3';
  d.desktop = { ensureReady: async () => { attempts += 1; await gate; } };
  d.remoteChannel = { setOnlineStatus: async () => {}, syncReachabilityStatus: () => {} };
  d.sleep = async () => {};
  const a = d.handleLocalMcpLoss('a');
  const b = d.handleLocalMcpLoss('b');
  await new Promise((r) => setImmediate(r));
  release();
  await Promise.all([a, b]);
  assert.equal(attempts, 1, 'concurrent losses must not start parallel re-attach loops');
}

// Shutdown stops the retry loop.
{
  const d = new MCPDevice();
  let attempts = 0;
  d.deviceId = 'device-4';
  d.desktop = { ensureReady: async () => { attempts += 1; throw new Error('down'); } };
  d.remoteChannel = { setOnlineStatus: async () => {}, syncReachabilityStatus: () => { throw new Error('must not sync'); } };
  d.sleep = async () => { if (attempts >= 2) d.isShuttingDown = true; };
  const quiet = console.error; console.error = () => {};
  try { await d.handleLocalMcpLoss('x'); } finally { console.error = quiet; }
  assert.equal(attempts, 2, 'retry loop must exit once shutdown begins');
}

console.log('remote local MCP recovery tests passed');
