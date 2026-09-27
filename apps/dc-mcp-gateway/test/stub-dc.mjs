#!/usr/bin/env node
// Minimal Desktop Commander stand-in for gateway/bridge tests.
// Speaks just enough JSON-RPC over stdio: answers initialize (and any
// request) with a valid result; exits on a test/crash notification.
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
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
