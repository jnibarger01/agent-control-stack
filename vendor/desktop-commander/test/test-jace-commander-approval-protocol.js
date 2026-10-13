#!/usr/bin/env node
/** Human-assertion gate (ported from PR #324) over main's approverd record shape. */
import assert from 'node:assert/strict';
import { JcHumanAssertionGate } from '../dist/jace-commander/approval-protocol.js';
import { computeLocalInvocationHash } from '../dist/jace-commander/local-token.js';

let now = 1_000_000;
const clock = () => now;
let seq = 0;
const record = (args = { path: '/tmp/x', content: String(seq) }) => ({
  id: `apr-${++seq}`, runtimeId: 'rt-1', tool: 'write_file', status: 'pending',
  expiresAt: new Date(now + 15 * 60_000).toISOString(),
  invocationHash: computeLocalInvocationHash('rt-1', 'write_file', args),
});
const assertionFor = (c, extra = {}) => ({
  approvalId: c.approvalId, challenge: c.challenge, invocationHash: c.invocationHash,
  operatorId: 'human', issuedAt: now, expiresAt: now + 1000, ...extra,
});

// Verifier accepts (returning the authenticated principal, F2): success once, then replay is unknown.
const OK = { operatorId: 'human', assurance: 'webauthn-uv' };
let calls = 0;
// Deterministic challenges: each one fills its bytes with a small counter (0x01, 0x02, ...), so challenges
// differ from each other but never start with 'x' in hex or base64, which keeps the 'x' + slice(1) mutation a real change.
let fill = 0;
const randomBytes = (size) => Buffer.alloc(size, (++fill % 0x7f) || 1);
const gate = new JcHumanAssertionGate({ verify: async () => { calls++; return OK; } }, { now: clock, randomBytes });
let c = gate.issue(record());
assert.equal(c.expiresAt - c.issuedAt, 30_000);
assert.match(c.invocationHash, /^[0-9a-f]{64}$/);
const accepted = await gate.accept(assertionFor(c));
assert.equal(accepted.challenge.approvalId, c.approvalId);
assert.equal(accepted.operatorId, 'human');
assert.equal(accepted.assurance, 'webauthn-uv');
await assert.rejects(gate.accept(assertionFor(c)), /JC_APPROVAL_UNKNOWN/);
assert.equal(calls, 1);

// Verifier rejects / throws => denied, and the challenge is consumed.
// A bare `true` (no principal), a wrong principal or a missing assurance level are denials too (F2).
for (const verify of [async () => false, async () => { throw new Error('boom'); }, async () => 'yes', async () => true,
  async () => ({ operatorId: 'mallory', assurance: 'webauthn-uv' }), async () => ({ operatorId: 'human' })]) {
  const g = new JcHumanAssertionGate({ verify }, { now: clock });
  const ch = g.issue(record());
  await assert.rejects(g.accept(assertionFor(ch)), /JC_APPROVAL_DENIED/);
  await assert.rejects(g.accept(assertionFor(ch)), /JC_APPROVAL_UNKNOWN/);
}

// Binding mismatches are denied without consulting the verifier.
calls = 0;
const bad = [
  (ch) => { assert.notEqual(ch.challenge[0], 'x'); return { challenge: 'x' + ch.challenge.slice(1) }; },
  () => ({ invocationHash: computeLocalInvocationHash('rt-1', 'write_file', { other: 1 }) }),
  () => ({ operatorId: '' }),
  () => ({ issuedAt: now + 1 }),
  () => ({ expiresAt: now - 1 }),
  () => ({ issuedAt: now - 31_000, expiresAt: now + 1 }),
  () => ({ issuedAt: 'now' }),
];
for (const mutate of bad) {
  const ch = gate.issue(record());
  await assert.rejects(gate.accept(assertionFor(ch, mutate(ch))), /JC_APPROVAL_DENIED/);
}
// Assertion for another approval's challenge is denied.
const a = gate.issue(record()); const b = gate.issue(record());
await assert.rejects(gate.accept(assertionFor(a, { approvalId: b.approvalId })), /JC_APPROVAL_DENIED/);
assert.equal(calls, 0);

// Expired challenge denied.
c = gate.issue(record());
now += 30_001;
await assert.rejects(gate.accept(assertionFor(c)), /JC_APPROVAL_DENIED/);

// Parallel replay: only one of two concurrent accepts can win.
let release;
const slow = new JcHumanAssertionGate({ verify: () => new Promise((r) => { release = r; }) }, { now: clock });
c = slow.issue(record());
const first = slow.accept(assertionFor(c));
await assert.rejects(slow.accept(assertionFor(c)), /JC_APPROVAL_UNKNOWN/);
release(OK);
await first;

// Issue preconditions and cancel.
assert.throws(() => gate.issue({ ...record(), status: 'approved' }), /JC_APPROVAL_REQUEST_INVALID/);
assert.throws(() => gate.issue({ ...record(), invocationHash: 'nothex' }), /JC_APPROVAL_REQUEST_INVALID/);
assert.throws(() => gate.issue({ ...record(), runtimeId: '' }), /JC_APPROVAL_REQUEST_INVALID/);
assert.throws(() => new JcHumanAssertionGate({ verify: async () => OK }, { challengeTtlMs: 30_001 }), RangeError);
c = gate.issue(record()); gate.cancel(c.approvalId);
await assert.rejects(gate.accept(assertionFor(c)), /JC_APPROVAL_UNKNOWN/);
await assert.rejects(gate.accept({}), /JC_APPROVAL_UNKNOWN/);

console.log('JC human-assertion gate: passed');
