#!/usr/bin/env node
// Minimal Jace Commander stand-in for /jc/mcp tests (spawned by bridge.js
// BRIDGE_VARIANT=jc as `stub-jc.mjs serve`). Records its argv and every
// JSON-RPC message it receives under $JC_STATE_DIR so tests can prove what
// reached the executor, and echoes the transported capability on tools/call.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const stateDir = process.env.JC_STATE_DIR;
if (!stateDir) { console.error('stub-jc: JC_STATE_DIR required'); process.exit(1); }
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, 'argv.json'), JSON.stringify({
  argv: process.argv.slice(2),
  env: Object.keys(process.env).filter((k) => k.startsWith('JC_') || k.startsWith('DC_') || k.startsWith('ACS_') || k.startsWith('DESKTOP_COMMANDER_')).sort(),
  runtimeId: process.env.JC_RUNTIME_ID,
}));
if (process.argv.slice(2).includes('--standalone')) { console.error('stub-jc: --standalone must never be used'); process.exit(2); }

const log = path.join(stateDir, 'received.jsonl');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  fs.appendFileSync(log, `${JSON.stringify(msg)}\n`);
  if (msg.id === undefined || msg.id === null) return; // notification
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'jace-commander', version: '0.0.0-stub' },
      },
    }) + '\n');
    return;
  }
  if (msg.method === 'tools/call') {
    const meta = msg.params?._meta || {};
    const capability = meta.acsCapability;
    const granted = capability?.payload?.version === 'acs.jc.v1' && capability?.payload?.audience === 'jace-commander';
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      result: {
        content: [{ type: 'text', text: JSON.stringify({ tool: msg.params?.name, mode: 'managed' }) }],
        ...(granted ? {} : { isError: true }),
        _meta: { acsAuthorization: { version: 'acs.jc.v1', decision: granted ? 'granted' : 'denied' } },
      },
    }) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n');
});
