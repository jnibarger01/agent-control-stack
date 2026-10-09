#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonlTraceChain, readTraceFile, verifyChain } from '../dist/jace-commander/looptrace.js';
import { JcApproverdService } from '../dist/jace-commander/approverd-service.js';
import { verifyJcLocalCapability, FileNonceStore } from '../dist/jace-commander/local-capability.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-approverd-'));
try {
  const signer = crypto.generateKeyPairSync('ed25519');
  const operator = crypto.generateKeyPairSync('ed25519');
  const rogue = crypto.generateKeyPairSync('ed25519');
  let now = Date.now();
  const tracePath = path.join(dir, 'audit.jsonl');
  const app = new JcApproverdService(signer.privateKey, operator.publicKey, new JsonlTraceChain(tracePath, 'jc-approverd-test'), () => now);
  const args = { path: '/tmp/example', content: 'hello' };
  function signature(a, key = operator.privateKey) {
    const keys = ['approvalId','challenge','expiresAt','invocationHash','issuedAt','operatorId'];
    return crypto.sign(null, Buffer.from(JSON.stringify(Object.fromEntries(keys.map(k => [k, a[k]])))), key).toString('base64url');
  }
  function assertion(p) {
    const payload = {
      approvalId: p.id, challenge: p.challenge, invocationHash: p.invocationHash,
      operatorId: 'human-key-1', issuedAt: now, expiresAt: now + 5_000,
    };
    return { payload, signature: signature(payload) };
  }
  const p1 = app.request('write_file', args, 'test-runtime');
  const forged = assertion(p1);
  forged.signature = signature(forged.payload, rogue.privateKey);
  await assert.rejects(app.approveAndIssue(forged), /JC_APPROVAL_DENIED/);
  await assert.rejects(app.approveAndIssue(assertion(p1)), /JC_APPROVAL_UNKNOWN/);

  const p2 = app.request('write_file', args, 'test-runtime');
  const token = await app.approveAndIssue(assertion(p2));
  const nonces = new FileNonceStore(path.join(dir, 'nonces'));
  assert.equal(verifyJcLocalCapability(token, signer.publicKey,
    { runtimeId: 'test-runtime', tool: 'write_file', arguments: args }, nonces, now).approverId, 'human-key-1');
  assert.throws(() => verifyJcLocalCapability(token, signer.publicKey,
    { runtimeId: 'test-runtime', tool: 'write_file', arguments: args }, nonces, now));
  const audit = readTraceFile(tracePath);
  assert.equal(verifyChain(audit.events).ok, true);
  console.log('JC approverd signed human proof, audit and local capability: passed');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
