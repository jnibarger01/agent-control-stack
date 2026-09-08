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
