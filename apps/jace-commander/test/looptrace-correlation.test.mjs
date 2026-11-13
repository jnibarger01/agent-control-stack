#!/usr/bin/env node
/**
 * Regression tests for LoopTrace correlation IDs (workItemId, attemptId,
 * leaseId, invocationHash) and strict binding to ACS authorization.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadJcConfig } from '../dist/config.js';
import { createJcServer } from '../dist/server.js';
import { readTraceFile, verifyChain, extractTraceCorrelation } from '../dist/looptrace.js';
import { makeIssuer, authorityBody } from './fixtures/jc-mint.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-corr-'));
const root = path.join(tmp, 'work');
fs.mkdirSync(root, { recursive: true });
const stateDir = path.join(tmp, 'state');
const issuer = makeIssuer();

let authorityState = 'active';
const config = loadJcConfig({
  JC_ACS_AUTHORITY_TOKEN: 'test-authority-read-token',
  HOME: tmp,
  JC_STATE_DIR: stateDir,
  JC_FS_ROOTS: root,
  JC_RUNTIME_ID: 'jc-test-runtime',
  JC_ACS_PUBLIC_KEY: issuer.publicKeyB64,
  JC_ACS_KEY_ID: issuer.keyId,
  JC_ACS_URL: 'http://127.0.0.1:3999',
  JC_GATEWAY_META_TRUSTED: '1',
});

const server = createJcServer(config, 'managed', {
  helperAvailable: async () => false,
  invokeHelper: async () => ({ ok: true }),
  fetchImpl: async () => {
    const body = authorityBody(issuer);
    if (authorityState === 'revoked') body.attemptLeases[0].status = 'revoked';
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  },
});

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: 'corr-test', version: '1' });
await client.connect(clientTransport);

function readAllTraceEvents() {
  const traceDir = path.join(stateDir, 'traces');
  const files = fs.readdirSync(traceDir).filter((f) => f.endsWith('.jsonl'));
  assert.equal(files.length, 1, 'expected single trace file');
  const parsed = readTraceFile(path.join(traceDir, files[0]));
  assert.equal(parsed.parseError, undefined);
  assert.equal(verifyChain(parsed.events).ok, true);
  return parsed.events;
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

try {
  await test('tool_call_started and tool_call_finished both carry workItemId, attemptId, leaseId, invocationHash', async () => {
    const filePath = path.join(root, 'hello.txt');
    const args = { path: filePath, content: 'hi' };
    const cap = issuer.mint('write_file', args, {
      workItemId: 'wi-corr-1',
      attemptId: 'att-corr-1',
      leaseId: 'lease-corr-1',
    });
    const res = await client.callTool({
      name: 'write_file',
      arguments: args,
      _meta: { gateway: { sub: 'alice', client_id: 'c1' }, acsCapability: cap },
    });
    assert.equal(res.isError, undefined, JSON.stringify(res));

    const events = readAllTraceEvents();
    const started = events.find((e) => e.type === 'tool_call_started');
    const finished = events.find((e) => e.type === 'tool_call_finished');
    assert.ok(started, 'tool_call_started present');
    assert.ok(finished, 'tool_call_finished present');

    for (const ev of [started, finished]) {
      const corr = extractTraceCorrelation(ev);
      assert.equal(corr.workItemId, 'wi-corr-1');
      assert.equal(corr.attemptId, 'att-corr-1');
      assert.equal(corr.leaseId, 'lease-corr-1');
      assert.equal(corr.invocationHash, cap.payload.invocationHash);
    }
  });

  await test('JC_AUTHORITY_REVOKED carries workItemId, attemptId, leaseId, invocationHash', async () => {
    authorityState = 'revoked';
    const beforeCount = readAllTraceEvents().length;
    const args = { path: path.join(root, 'revoked.txt'), content: 'nope' };
    const cap = issuer.mint('write_file', args, {
      workItemId: 'wi-rev-1',
      attemptId: 'att-rev-1',
      leaseId: 'lease-rev-1',
    });
    const res = await client.callTool({
      name: 'write_file',
      arguments: args,
      _meta: { gateway: { sub: 'alice', client_id: 'c1' }, acsCapability: cap },
    });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent.error.code, 'JC_AUTHORITY_REVOKED');
    assert.equal(fs.existsSync(path.join(root, 'revoked.txt')), false);

    const events = readAllTraceEvents().slice(beforeCount);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'tool_call_finished');
    assert.equal(events[0].payload.code, 'JC_AUTHORITY_REVOKED');
    const corr = extractTraceCorrelation(events[0]);
    assert.equal(corr.workItemId, 'wi-rev-1');
    assert.equal(corr.attemptId, 'att-rev-1');
    assert.equal(corr.leaseId, 'lease-rev-1');
    assert.equal(corr.invocationHash, cap.payload.invocationHash);
    authorityState = 'active';
  });

  await test('conflicting agent-supplied identifiers in _meta are rejected before execution', async () => {
    const beforeCount = readAllTraceEvents().length;
    const target = path.join(root, 'conflict.txt');
    const args = { path: target, content: 'should-not-write' };
    const cap = issuer.mint('write_file', args, {
      workItemId: 'wi-auth-1',
      attemptId: 'att-auth-1',
      leaseId: 'lease-auth-1',
    });
    const res = await client.callTool({
      name: 'write_file',
      arguments: args,
      _meta: {
        gateway: { sub: 'alice', client_id: 'c1' },
        acsCapability: cap,
        workItemId: 'wi-spoofed',
        attemptId: 'att-spoofed',
      },
    });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent.error.code, 'JC_CORRELATION_CONFLICT');
    assert.equal(fs.existsSync(target), false);

    const events = readAllTraceEvents().slice(beforeCount);
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.code, 'JC_CORRELATION_CONFLICT');
    // Trace must record ONLY the authenticated authorization IDs, never spoofed ones.
    const corr = extractTraceCorrelation(events[0]);
    assert.equal(corr.workItemId, 'wi-auth-1');
    assert.equal(corr.attemptId, 'att-auth-1');
    assert.equal(corr.leaseId, 'lease-auth-1');
    assert.equal(corr.invocationHash, cap.payload.invocationHash);
  });

  console.log(`\njace-commander looptrace-correlation: ${passed} passed`);
} finally {
  await client.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
