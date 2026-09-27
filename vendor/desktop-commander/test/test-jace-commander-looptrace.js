#!/usr/bin/env node
/**
 * LoopTrace byte-compatibility with agent-control-stack
 * packages/agentos-contracts/src/trace-events.js. The pinned vector below was
 * produced by that reference implementation (createTrace('jc-vector-run',
 * clock=2026-09-26T00:00:00.000Z)); if these hashes drift, LoopTrace and the
 * visualizer can no longer verify chains written by jace-commander.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildEvent, GENESIS_HASH, JsonlTraceChain, readTraceFile, verifyChain } from '../dist/jace-commander/looptrace.js';

const TS = '2026-09-26T00:00:00.000Z';
const ACS_VECTOR = [
  '5c7973a13de15bc5f8785d8babc9d826b57754172a6f138da88640612bd0d6e5',
  '0d0c22b10a6a4b4edf3f6948f47fe38203945c9ce77c14701b0556951c0ffe93',
];
let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`  ✓ ${name}`); };

test('hash chain matches the ACS agentos-contracts reference vector', () => {
  const e0 = buildEvent('jc-vector-run', 0, GENESIS_HASH, 'tool_call_started', { tool: 'privileged_exec', argv: ['/usr/bin/apt-get', 'update'], note: 'token=supersecret123' }, TS);
  const e1 = buildEvent('jc-vector-run', 1, e0.hash, 'tool_call_finished', { tool: 'privileged_exec', exitCode: 0 }, TS);
  assert.equal(e0.hash, ACS_VECTOR[0]);
  assert.equal(e1.hash, ACS_VECTOR[1]);
  assert.equal(e0.redacted, true);
  assert.equal(e0.payload.note, '[REDACTED:credential_assignment]');
  assert.equal(verifyChain([e0, e1]).ok, true);
});

test('tamper, reorder and truncation-at-head are detected', () => {
  const e0 = buildEvent('jc-run-abc', 0, GENESIS_HASH, 'task_received', { a: 1 }, TS);
  const e1 = buildEvent('jc-run-abc', 1, e0.hash, 'run_completed', {}, TS);
  assert.equal(verifyChain([{ ...e0, payload: { a: 2 } }, e1]).reason, 'hash mismatch (event tampered)');
  assert.equal(verifyChain([e1, e0]).ok, false);
  assert.equal(verifyChain([e1]).ok, false);
});

test('JSONL writer appends a verifiable chain and refuses to extend a tampered file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-trace-'));
  const file = path.join(dir, 'run.jsonl');
  const chain = new JsonlTraceChain(file, 'jc-run-file');
  chain.append('tool_call_started', { tool: 'x' });
  chain.append('tool_call_finished', { tool: 'x', ok: true });
  const { events } = readTraceFile(file);
  assert.equal(events.length, 2);
  assert.equal(verifyChain(events).ok, true);
  assert.equal((fs.statSync(file).mode & 0o777), 0o600);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"ok":true', '"ok":false'));
  assert.throws(() => chain.append('run_completed', {}), /trace chain invalid/);
});

test('unknown event types and bad run ids are rejected', () => {
  assert.throws(() => buildEvent('jc-run-abc', 0, GENESIS_HASH, 'sudo_granted', {}, TS), /unknown event type/);
  assert.throws(() => buildEvent('bad id', 0, GENESIS_HASH, 'task_received', {}, TS), /invalid run_id/);
});

test('undefined-valued payload keys do not break persisted-chain verification', () => {
  const e0 = buildEvent('jc-run-undef', 0, GENESIS_HASH, 'tool_call_finished', { tool: 'x', workItemId: undefined }, TS);
  assert.equal(verifyChain([JSON.parse(JSON.stringify(e0))]).ok, true);
});

console.log(`\njace-commander looptrace: ${passed} passed`);
