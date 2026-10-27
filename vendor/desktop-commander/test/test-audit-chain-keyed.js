#!/usr/bin/env node
/**
 * Keyed audit integrity (ACS review P1). An unkeyed hash chain can be rewritten by anyone who can write the file: change a
 * record, recompute the hashes, and the chain verifies. A keyed MAC closes that, but only when verification uses the key,
 * and the key must be held outside the writer.
 *
 * The attacker model here: the attacker can write the file and runs the public canonicalization, but does NOT hold the key.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-audit-keyed-'));
process.env.DC_AUDIT_DIR = path.join(tmp, 'audit');
const { AuditChain, verifyChain, canonicalJsonForEvent, sha256Hex } = await import('../dist/audit/audit-chain.js');

const KEY = crypto.randomBytes(32);
const WRONG = crypto.randomBytes(32);
let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function writeKeyedChain(name) {
  const file = path.join(tmp, `${name}.jsonl`);
  const chain = new AuditChain(file, { macKey: KEY });
  chain.append({ kind: 'request', tool: 'read_file', agent: 'a', argsPreview: '{"path":"/x"}' });
  chain.append({ kind: 'request', tool: 'write_file', agent: 'b', argsPreview: '{"path":"/y"}' });
  chain.append({ kind: 'result', tool: 'write_file', agent: 'b', ok: true });
  return file;
}
const records = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const dump = (file, recs) => fs.writeFileSync(file, `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`);

/** An attacker without the key: rewrite record `index`, then recompute every hash in order. MACs are left as they were. */
function forgeWithoutKey(file, index, mutate, { stripMac = false } = {}) {
  const original = records(file);
  const out = [];
  for (let i = 0; i < original.length; i += 1) {
    let rec = { ...original[i] };
    delete rec.hash;
    if (stripMac) delete rec.mac;
    if (i === index) rec = mutate(rec);
    if (i > 0) rec.prevHash = out[i - 1].hash;
    out.push({ ...rec, hash: sha256Hex(canonicalJsonForEvent(rec)) });
  }
  dump(file, out);
}

test('an intact keyed chain verifies with the key', () => {
  const file = writeKeyedChain('intact');
  assert.equal(verifyChain(file, { macKey: KEY }).valid, true);
});

test('an unkeyed verifier still checks linkage and hashes (limit: it cannot detect a recomputed rewrite)', () => {
  const file = writeKeyedChain('unkeyed-limit');
  forgeWithoutKey(file, 1, (rec) => ({ ...rec, tool: 'delete_everything' }));
  assert.equal(verifyChain(file).valid, true, 'an unkeyed chain verifies after a recomputed rewrite: the documented limit');
});

test('a recomputed rewrite is detected when verification uses the key', () => {
  const file = writeKeyedChain('rewrite-detected');
  forgeWithoutKey(file, 1, (rec) => ({ ...rec, tool: 'delete_everything' }));
  const result = verifyChain(file, { macKey: KEY });
  assert.equal(result.valid, false);
  assert.equal(result.brokenAt, 1);
  assert.match(result.error, /mac mismatch at seq 2/);
});

test('stripping the MAC and recomputing hashes is detected: a MAC is required under a key', () => {
  const file = writeKeyedChain('stripped');
  forgeWithoutKey(file, 1, (rec) => ({ ...rec, tool: 'delete_everything' }), { stripMac: true });
  const result = verifyChain(file, { macKey: KEY });
  assert.equal(result.valid, false);
  assert.match(result.error, /missing mac/);
});

test('a wrong verification key is refused', () => {
  const file = writeKeyedChain('wrong-key');
  const result = verifyChain(file, { macKey: WRONG });
  assert.equal(result.valid, false);
  assert.match(result.error, /mac mismatch/);
});

test('an unkeyed chain cannot be verified as keyed (no silent downgrade)', () => {
  const file = path.join(tmp, 'unkeyed.jsonl');
  const chain = new AuditChain(file);
  chain.append({ kind: 'request', tool: 'read_file', agent: 'a' });
  const result = verifyChain(file, { macKey: KEY });
  assert.equal(result.valid, false);
  assert.match(result.error, /missing mac/);
});

console.log(`keyed audit chain: ${passed} passed`);
