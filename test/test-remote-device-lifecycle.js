import assert from 'node:assert/strict';
import { MCPDevice } from '../dist/remote-device/device.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

let releaseInitialize;
const initializeGate = new Promise((resolve) => { releaseInitialize = resolve; });
let desktopShutdowns = 0;
let registerCalls = 0;
let heartbeatStarts = 0;

const device = new MCPDevice();
device.desktop = {
  initialize: () => initializeGate,
  shutdown: async () => { desktopShutdowns++; },
  listClientTools: async () => ({ tools: [] }),
};
device.remoteChannel = {
  stopHeartbeat: () => {},
  unsubscribe: async () => {},
  setOffline: async () => {},
  registerDevice: async () => { registerCalls++; },
  startHeartbeat: () => { heartbeatStarts++; },
};

const start = device.start();
await device.shutdown();
releaseInitialize();
await assert.rejects(start, /startup cancelled by shutdown/);

assert.equal(desktopShutdowns, 1, 'shutdown must close the local integration exactly once');
assert.equal(registerCalls, 0, 'a late startup completion must not register the remote device');
assert.equal(heartbeatStarts, 0, 'a late startup completion must not start retry timers');

let resilientDesktopShutdowns = 0;
const resilient = new MCPDevice();
resilient.remoteChannel = {
  stopHeartbeat: () => { throw new Error('heartbeat stop failed'); },
  unsubscribe: async () => { throw new Error('unsubscribe failed'); },
  setOffline: async () => { throw new Error('offline failed'); },
};
resilient.desktop = {
  shutdown: async () => { resilientDesktopShutdowns++; },
};
const firstShutdown = resilient.shutdown();
const secondShutdown = resilient.shutdown();
assert.equal(firstShutdown, secondShutdown, 'concurrent shutdown calls must share one cleanup');
await Promise.all([firstShutdown, secondShutdown]);
assert.equal(resilientDesktopShutdowns, 1, 'remote cleanup failures must not skip local child cleanup');

console.log('remote device start/shutdown race test passed');
