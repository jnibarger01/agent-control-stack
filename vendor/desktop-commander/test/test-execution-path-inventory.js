#!/usr/bin/env node
/**
 * Execution-path inventory (ACS review P0: a policy gate is insufficient if an alternate route bypasses it).
 *
 * Static, source-level guard. It fails when a NEW tool-call entry point appears that is not in the inventory below,
 * when a tool handler is invoked outside the governed dispatch function, or when the governance step is no longer
 * ordered before the side effect. It is a regression guard, not a runtime proof: the runtime proof is the negative
 * tests in test-acs-capability.js, test-jace-commander-approval.js, and test-jace-commander-principal-separation.js.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'ui') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts')) out.push(path.relative(SRC, full));
  }
  return out;
}

// Inventory of every module that registers a tools/call handler, and how each one is governed.
const INVENTORY = {
  'server.ts': 'DC managed: authorizeManagedToolCall (ACS capability) then preExecuteEnforcement, before dispatch',
  'jace-commander/server.ts': 'JC: route resolved by authorizer table; local class decision, or ACS/admin-delegated capability, before dispatch',
  'openclaw-bridge/index.ts': 'OpenClaw adapter: requests a fresh issuer capability per call, then forwards it to the managed child',
};

test('every tools/call handler in the source is inventoried (no unreviewed entry point)', () => {
  const registrants = walk(SRC).filter((rel) => /setRequestHandler\(\s*CallToolRequestSchema/.test(read(rel)));
  assert.deepEqual(registrants.sort(), Object.keys(INVENTORY).sort(),
    'a new tools/call entry point must be added to the inventory with its governance step');
});

test('DC: the ACS guard and the enforcement gate run before any handler dispatch', () => {
  const text = read('server.ts');
  const start = text.indexOf('async function handleCallToolRequest(');
  const end = text.indexOf('\n}\n', start);
  assert.ok(start > 0 && end > start, 'handleCallToolRequest must exist');
  const body = text.slice(start, end);
  const guard = body.indexOf('authorizeManagedToolCall(');
  const gate = body.indexOf('preExecuteEnforcement(');
  const firstDispatch = body.search(/await (handlers|executionHandlers)\.handle/);
  assert.ok(guard >= 0 && gate >= 0 && firstDispatch >= 0, 'guard, gate, and dispatch must all be present');
  assert.ok(guard < gate && gate < firstDispatch, 'order must be guard, then gate, then dispatch');
});

test('DC: every handler dispatch call lies inside the governed function', () => {
  const text = read('server.ts');
  const start = text.indexOf('async function handleCallToolRequest(');
  const end = text.indexOf('\n}\n', start);
  const all = [...text.matchAll(/(?:await )?(?:handlers|executionHandlers)\.handle[A-Za-z]+\(/g)].map((m) => m.index);
  assert.ok(all.length > 30, `expected the full dispatch table, found ${all.length}`);
  const outside = all.filter((i) => i < start || i > end);
  assert.deepEqual(outside, [], 'a handler call outside handleCallToolRequest bypasses the gate');
});

test('DC: the handler modules are imported only by the dispatcher (and a path helper)', () => {
  const importers = walk(SRC).filter((rel) => /from ['"]\.\.?\/(?:\.\.\/)?handlers\//.test(read(rel)) || /from ['"]\.\/handlers\/index/.test(read(rel)));
  assert.deepEqual(importers.sort(), ['server.ts', 'tools/edit.ts'].sort(),
    'a new importer of the handler modules must be reviewed for governance');
});

test('JC: the route is resolved and the authorizer decision applied before dispatch', () => {
  const text = read('jace-commander/server.ts');
  const resolve = text.indexOf('resolver.resolve(name)');
  const dispatch = text.indexOf('await dispatch(name');
  assert.ok(resolve > 0 && dispatch > resolve, 'route resolution must precede dispatch');
  const refusedBeforeDispatch = text.indexOf("route.authorizer === 'refused'");
  assert.ok(refusedBeforeDispatch > resolve && refusedBeforeDispatch < dispatch, 'standalone refusal must precede dispatch');
});

test('OpenClaw adapter: a capability is requested before any forwarded call', () => {
  const text = read('openclaw-bridge/index.ts');
  const issue = text.indexOf('requestManagedCapability(');
  const forward = text.indexOf('runtime.callTool(name, toolArguments, undefined, { acsCapability: capability })');
  assert.ok(issue > 0 && forward > issue, 'the issuer must authorize the call before it is forwarded');
});

console.log(`execution-path inventory: ${passed} passed`);
