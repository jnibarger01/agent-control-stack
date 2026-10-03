#!/usr/bin/env node
// Minimal Desktop Commander stand-in for gateway/bridge tests.
// Speaks just enough JSON-RPC over stdio: answers initialize (and any
// request) with a valid result; exits on a test/crash notification.
import readline from 'node:readline';
import { existsSync } from 'node:fs';

const rl = readline.createInterface({ input: process.stdin });
if (process.argv[2]) {
  for (const params of [
    { schemaVersion: 'invalid', runtime: 'desktop_commander' },
    { schemaVersion: 'acs.runtime-ready.v1', runtime: 'jace_commander' },
  ]) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/acs/runtime-ready', params }) + '\n');
}
function announceReady() {
  if (process.argv[2] && !existsSync(process.argv[2])) {
    setTimeout(announceReady, 25);
    return;
  }
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', method: 'notifications/acs/runtime-ready',
    params: { schemaVersion: 'acs.runtime-ready.v1', runtime: 'desktop_commander' },
  }) + '\n');
}
announceReady();
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'test/crash') process.exit(0);
  if (msg.method === 'test/orphan') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'upstream-orphan', result: {} }) + '\n');
    return;
  }
  if (msg.method === 'test/delay') {
    setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { echo: msg.params?.marker } }) + '\n'), 250);
    return;
  }
  if (msg.id === undefined || msg.id === null) return; // notification
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion || '2025-06-18',
        capabilities: {},
        serverInfo: { name: 'stub-dc', version: '0.0.1' },
      },
    }) + '\n');
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
      echo: msg.params?.marker,
      agent: msg.params?._meta?.agent,
      gatewaySub: msg.params?._meta?.gateway?.sub,
    } }) + '\n');
  }
});
