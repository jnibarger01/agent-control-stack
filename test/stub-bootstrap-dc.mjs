#!/usr/bin/env node
// Managed executor fixture: returns the bootstrap challenge it actually saw.
import readline from 'node:readline';

const delayMs = Number(process.argv[2] || 0);
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method !== 'initialize' || msg.id === undefined) return;
  const bootstrap = msg.params?._meta?.acsRuntimeBootstrap;
  const result = {
    protocolVersion: msg.params?.protocolVersion || '2025-06-18',
    capabilities: {},
    serverInfo: { name: 'bootstrap-stub', version: '1' },
  };
  if (bootstrap?.challenge !== 'malformed') {
    result._meta = {
      acsRuntimeIdentity: {
        schemaVersion: 1,
        runtimeId: bootstrap?.runtimeId || 'test-runtime',
        challenge: bootstrap?.challenge || '',
        scopes: Array.isArray(bootstrap?.scopes) ? bootstrap.scopes : [],
      },
    };
  }
  setTimeout(() => {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`);
  }, delayMs);
});
