#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadJcConfig } from '../dist/jace-commander/config.js';
import { JC_DEFAULT_CLASS_POLICY } from '../dist/jace-commander/local-policy.js';
import { mintJcLocalCapability } from '../dist/jace-commander/local-capability.js';
import { createJcServer } from '../dist/jace-commander/server.js';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jc-local-execution-')));
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const config = loadJcConfig({
  HOME: root, JC_STATE_DIR: path.join(root, '.jc'),
  JC_FS_ROOTS: root, JC_RUNTIME_ID: 'local-runtime',
  JC_ACS_URL: 'http://127.0.0.1:9',
});
const localPolicy = {
  policy: {
    version: 'jc.policy.v1',
    classes: { ...JC_DEFAULT_CLASS_POLICY },
    roots: [root], deniedRoots: [],
    authorizers: {},
  },
  hash: 'fixture-policy',
};
let acsCalls = 0;
const server = createJcServer(config, 'local', {
  localPolicy, localSigner: publicKey,
  fetchImpl: async () => { acsCalls++; throw new Error('ACS is unavailable'); },
  helperAvailable: async () => false,
});
const [a,b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const client = new Client({ name: 'jc-local-test', version: '1' });
await client.connect(b);
try {
  const filename = path.join(root, 'test.txt');
  const args = { path: filename, content: 'operator approved' };
  const denied = await client.callTool({ name: 'write_file', arguments: args });
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.error.code, 'JC_LOCAL_APPROVAL_REQUIRED');
  assert.equal(fs.existsSync(filename), false);
  assert.equal(acsCalls, 0);

  const signature = mintJcLocalCapability(privateKey, {
    runtimeId: config.runtimeId, tool: 'write_file',
    arguments: args, approverId: 'verified-operator',
  });
  const authorized = await client.callTool({
    name: 'write_file', arguments: args, _meta: { jcLocalCapability: signature },
  });
  assert.equal(authorized.isError, undefined, JSON.stringify(authorized.structuredContent));
  assert.equal(fs.readFileSync(filename, 'utf8'), 'operator approved');
  assert.equal(acsCalls, 0, 'successful local write must not query ACS');
  const replay = await client.callTool({
    name: 'write_file', arguments: args, _meta: { jcLocalCapability: signature },
  });
  assert.equal(replay.isError, true);
  assert.equal(replay.structuredContent.error.code, 'JC_LOCAL_APPROVAL_REQUIRED');

  const privileged = await client.callTool({
    name: 'privileged_exec',
    arguments: { argv: ['/usr/bin/id'] },
    _meta: { jcLocalCapability: signature },
  });
  assert.equal(privileged.isError, true);
  assert.equal(privileged.structuredContent.error.code, 'JC_LOCAL_TOOL_UNAVAILABLE');

  const read = await client.callTool({ name: 'read_file', arguments: { path: filename } });
  assert.equal(read.isError, undefined);
  assert.equal(read.structuredContent.content, 'operator approved');
  assert.equal(acsCalls, 0);
  console.log('JC local exact authorization, replay, root boundary and ACS independence: passed');
} finally {
  await client.close();
  await server.close();
  fs.rmSync(root, { recursive: true, force: true });
}
