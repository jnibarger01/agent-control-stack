#!/usr/bin/env node
// Managed executor fixture: returns the bootstrap challenge it actually saw.
import readline from 'node:readline';

const delayMs = Number(process.argv[2] || 0);
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  if (msg.method === 'tools/list') {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } })}\n`);
    return;
  }
  if (msg.method === 'tools/call') {
    const executionDelayMs = Number(msg.params?.arguments?.delayMs || 0);
    setTimeout(() => {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'done' }] } })}\n`);
    }, executionDelayMs);
    return;
  }
  if (msg.method !== 'initialize') return;
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
  const initializeDelayMs = bootstrap?.challenge === 'slow-initialize' ? 1600 : delayMs;
  setTimeout(() => {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`);
  }, initializeDelayMs);
});
