#!/usr/bin/env node
/** Live-authority binding: every field ACS must still confirm, one mismatch at a time. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authorityToken, currentAuthorityMismatch } from '../dist/current-authority.js';

const auth = {
  workItemId: 'wrk_1', attemptId: 'att_1', leaseId: 'lease_1', leaseEpoch: 3, planHash: 'p'.repeat(64),
  toolName: 'run_command', invocationHash: 'i'.repeat(64), approvalId: 'appr_1',
};
const now = Date.parse('2026-11-04T12:00:00.000Z');
const body = () => ({
  workItem: {
    id: 'wrk_1', status: 'running', requesterSubject: 'chatgpt:alice',
    requestedActions: [
      { params: { contract: 'acs.jc.v1', tool: 'read_file', invocationHash: 'x'.repeat(64) } },
      { params: { contract: 'acs.jc.v1', tool: 'run_command', invocationHash: 'i'.repeat(64) } },
    ],
  },
  attemptLeases: [{
    leaseId: 'lease_1', workItemId: 'wrk_1', attemptId: 'att_1', workerId: 'acs-jc-bridge', fencingEpoch: 3,
    planHash: 'p'.repeat(64), status: 'active', expiresAt: '2026-11-04T12:00:30.000Z', approvalId: 'appr_1',
  }],
});
const check = (mutate, principal = 'alice|client') => {
  const value = body();
  mutate(value);
  return currentAuthorityMismatch(value, auth, principal, now);
};
let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`  ✓ ${name}`); };

test('the exact confirmed authority passes (matching action need not be the first)', () => assert.equal(check(() => {}), undefined));
test('a different work item', () => assert.equal(check((b) => { b.workItem.id = 'wrk_2'; }), 'work_item_mismatch'));
test('a work item no longer running (cancelled, finished)', () => assert.equal(check((b) => { b.workItem.status = 'cancelled'; }), 'work_item_not_running'));
test('another principal\'s work item', () => assert.equal(check(() => {}, 'bob|client'), 'requester_mismatch'));
test('a different approved action', () => assert.equal(check((b) => { b.workItem.requestedActions[1].params.invocationHash = 'z'.repeat(64); }), 'action_mismatch'));
test('lease missing', () => assert.equal(check((b) => { b.attemptLeases = []; }), 'lease_missing'));
test('lease fenced to another epoch or worker', () => {
  assert.equal(check((b) => { b.attemptLeases[0].fencingEpoch = 4; }), 'lease_binding_mismatch');
  assert.equal(check((b) => { b.attemptLeases[0].workerId = 'acs-dc-bridge'; }), 'lease_binding_mismatch');
});
test('lease revoked, expired or consumed by ACS', () => {
  for (const status of ['revoked', 'expired', 'consumed']) assert.equal(check((b) => { b.attemptLeases[0].status = status; }), 'lease_not_active');
});
test('lease past expiresAt before ACS reconciled it', () => assert.equal(check((b) => { b.attemptLeases[0].expiresAt = '2026-11-04T11:59:59.999Z'; }), 'lease_expired'));
test('approval swapped', () => assert.equal(check((b) => { b.attemptLeases[0].approvalId = 'appr_other'; }), 'approval_mismatch'));
test('garbage from ACS is a mismatch, never a pass', () => {
  for (const garbage of [null, 'ok', [], { workItem: null }]) assert.notEqual(currentAuthorityMismatch(garbage, auth, 'alice|c', now), undefined);
});
test('the authority credential is dedicated: no fallback to the model-facing or worker token', () => {
  assert.equal(authorityToken({ JC_ACS_AUTHORITY_TOKEN: 'authority', JC_ACS_TOKEN: 'model' }), 'authority');
  assert.equal(authorityToken({ JC_ACS_TOKEN: 'model' }), undefined);
  assert.equal(authorityToken({ ACS_WORKER_TOKEN: 'worker', JC_ACS_TOKEN: 'model' }), undefined);
  assert.equal(authorityToken({ JC_ACS_AUTHORITY_TOKEN: '   ', JC_ACS_TOKEN: 'model' }), undefined);
  assert.equal(authorityToken({}), undefined);
});
test('an unreadable or empty authority token file is not configured (no fallback)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-authority-'));
  try {
    const file = path.join(dir, 'token');
    assert.equal(authorityToken({ JC_ACS_AUTHORITY_TOKEN_FILE: file, JC_ACS_TOKEN: 'model' }), undefined);
    fs.writeFileSync(file, '\n');
    assert.equal(authorityToken({ JC_ACS_AUTHORITY_TOKEN_FILE: file, JC_ACS_TOKEN: 'model' }), undefined);
    fs.writeFileSync(file, 'from-file\n');
    assert.equal(authorityToken({ JC_ACS_AUTHORITY_TOKEN_FILE: file, JC_ACS_TOKEN: 'model' }), 'from-file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
console.log(`\njace-commander current authority: ${passed} passed`);

// ---- server level: no dedicated credential means no execution, no ACS call ----
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { loadJcConfig } = await import('../dist/config.js');
const { createJcServer } = await import('../dist/server.js');
const { makeIssuer, authorityFetch } = await import('./fixtures/jc-mint.js');

async function managedServer(extraEnv) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jc-authority-server-')));
  const work = path.join(tmp, 'work');
  fs.mkdirSync(work);
  const issuer = makeIssuer();
  const requests = [];
  const config = loadJcConfig({
    HOME: tmp, JC_STATE_DIR: path.join(tmp, 'state'), JC_FS_ROOTS: work, JC_RUNTIME_ID: 'jc-test-runtime',
    JC_ACS_PUBLIC_KEY: issuer.publicKeyB64, JC_ACS_KEY_ID: issuer.keyId, JC_ACS_URL: 'http://127.0.0.1:9', ...extraEnv,
  });
  const server = createJcServer(config, 'managed', {
    helperAvailable: async () => false,
    fetchImpl: async (url, init = {}) => {
      requests.push({ url: String(url), authorization: init.headers?.authorization });
      return authorityFetch(issuer)(url);
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'authority-test', version: '1' });
  await client.connect(clientTransport);
  const call = (name, args) => client.callTool({ name, arguments: args, _meta: { acsCapability: issuer.mint(name, args) } });
  return { tmp, work, requests, call, close: async () => { await client.close(); fs.rmSync(tmp, { recursive: true, force: true }); } };
}

for (const [label, env] of [
  ['only JC_ACS_TOKEN', { JC_ACS_TOKEN: 'model-facing-token' }],
  ['only the worker token', { ACS_WORKER_TOKEN: 'worker-token' }],
  ['an unreadable token file plus JC_ACS_TOKEN', { JC_ACS_AUTHORITY_TOKEN_FILE: '/nonexistent/jc-authority.token', JC_ACS_TOKEN: 'model-facing-token' }],
]) {
  await (async () => {
    const jc = await managedServer(env);
    try {
      const target = path.join(jc.work, 'must-not-exist.txt');
      const result = await jc.call('write_file', { path: target, content: 'x' });
      test(`fail closed with ${label}: a valid capability does not execute and ACS is not asked with another token`, () => {
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent.error.code, 'ACS_UNAVAILABLE');
        assert.match(result.structuredContent.error.message, /JC_ACS_AUTHORITY_TOKEN/);
        assert.equal(fs.existsSync(target), false);
        assert.deepEqual(jc.requests.filter((request) => request.url.includes('/work-items/')), []);
      });
    } finally {
      await jc.close();
    }
  })();
}

await (async () => {
  const jc = await managedServer({ JC_ACS_AUTHORITY_TOKEN: 'read-only-authority-token', JC_ACS_TOKEN: 'model-facing-token' });
  try {
    const target = path.join(jc.work, 'written.txt');
    const result = await jc.call('write_file', { path: target, content: 'ok' });
    test('with the dedicated credential the same call executes, and ACS is asked with that credential only', () => {
      assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
      assert.equal(fs.readFileSync(target, 'utf8'), 'ok');
      const reads = jc.requests.filter((request) => request.url.includes('/work-items/'));
      assert.equal(reads.length, 1);
      assert.equal(reads[0].authorization, 'Bearer read-only-authority-token');
    });
  } finally {
    await jc.close();
  }
})();
console.log(`jace-commander current authority (server): ${passed} total passed`);

// ---- every authorization failure denies BEFORE any side effect ---------------
await (async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jc-no-side-effect-')));
  const work = path.join(tmp, 'work');
  fs.mkdirSync(work);
  const issuer = makeIssuer();
  const otherIssuer = makeIssuer();
  let acsMode = 'ok';
  const config = loadJcConfig({
    HOME: tmp, JC_STATE_DIR: path.join(tmp, 'state'), JC_FS_ROOTS: work, JC_RUNTIME_ID: 'jc-test-runtime',
    JC_ACS_PUBLIC_KEY: issuer.publicKeyB64, JC_ACS_KEY_ID: issuer.keyId, JC_ACS_URL: 'http://127.0.0.1:9',
    JC_ACS_AUTHORITY_TOKEN: 'read-only-authority-token',
  });
  const server = createJcServer(config, 'managed', {
    helperAvailable: async () => false,
    fetchImpl: async (url) => {
      if (acsMode === 'down') throw new TypeError('fetch failed: ECONNREFUSED');
      if (acsMode === 'error') return new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } });
      const body = (await authorityFetch(issuer)(url)).json ? await (await authorityFetch(issuer)(url)).json() : {};
      if (acsMode === 'revoked') body.attemptLeases[0].status = 'revoked';
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'side-effect-test', version: '1' });
  await client.connect(clientTransport);
  let n = 0;
  const cases = [
    ['no capability', () => undefined, 'JC_CAPABILITY_MISSING'],
    ['a capability from another signer', (name, args) => otherIssuer.mint(name, args, {}, { keyId: issuer.keyId }), 'JC_CAPABILITY_SIGNATURE_INVALID'],
    ['an expired capability', (name, args) => issuer.mint(name, args, {}, { now: Date.now() - 120_000 }), 'JC_CAPABILITY_TIME_INVALID'],
    ['a capability for other arguments', (name, args) => issuer.mint(name, { ...args, cwd: args.cwd ?? work, path: `${work}/elsewhere` }), 'JC_CAPABILITY_ARGUMENTS_MISMATCH'],
    ['a lease ACS revoked', (name, args) => { acsMode = 'revoked'; return issuer.mint(name, args); }, 'JC_AUTHORITY_REVOKED'],
    ['ACS unreachable', (name, args) => { acsMode = 'down'; return issuer.mint(name, args); }, 'ACS_UNAVAILABLE'],
    ['ACS answering 500', (name, args) => { acsMode = 'error'; return issuer.mint(name, args); }, 'ACS_UNAVAILABLE'],
  ];
  try {
    for (const tool of ['run_command', 'write_file']) {
      for (const [label, capabilityFor, expected] of cases) {
        acsMode = 'ok';
        const marker = path.join(work, `marker-${n += 1}`);
        const args = tool === 'run_command' ? { command: `touch ${marker}`, cwd: work, waitMs: 2000 } : { path: marker, content: 'x' };
        const capability = capabilityFor(tool, args);
        const result = await client.callTool({ name: tool, arguments: args, ...(capability ? { _meta: { acsCapability: capability } } : {}) });
        await new Promise((resolve) => setTimeout(resolve, 100));
        test(`${tool} with ${label}: refused (${expected}) and nothing happened`, () => {
          assert.equal(result.isError, true, JSON.stringify(result.structuredContent));
          assert.equal(result.structuredContent.error.code, expected);
          assert.equal(fs.existsSync(marker), false);
        });
      }
      // Replay: the first use executes, the identical envelope is refused and runs nothing more.
      acsMode = 'ok';
      const marker = path.join(work, `replay-${tool}`);
      const args = tool === 'run_command' ? { command: `echo x >> ${marker}`, cwd: work, waitMs: 5000 } : { path: marker, content: 'x', overwrite: true };
      const capability = issuer.mint(tool, args);
      const first = await client.callTool({ name: tool, arguments: args, _meta: { acsCapability: capability } });
      const replay = await client.callTool({ name: tool, arguments: args, _meta: { acsCapability: capability } });
      test(`${tool}: a replayed capability is refused and executes nothing more (no duplicate execution)`, () => {
        assert.equal(first.isError, undefined, JSON.stringify(first.structuredContent));
        assert.equal(replay.structuredContent.error.code, 'JC_CAPABILITY_NONCE_REPLAY');
        assert.equal(fs.readFileSync(marker, 'utf8'), tool === 'run_command' ? 'x\n' : 'x');
      });
    }
  } finally {
    await client.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();
console.log(`jace-commander authorization side effects: ${passed} total passed`);
