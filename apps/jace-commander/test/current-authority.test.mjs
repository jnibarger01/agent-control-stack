#!/usr/bin/env node
/** Live-authority binding: every field ACS must still confirm, one mismatch at a time. */
import assert from 'node:assert/strict';
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
test('the authority credential is dedicated: JC_ACS_AUTHORITY_TOKEN wins over the model-facing token', () => {
  assert.equal(authorityToken({ JC_ACS_AUTHORITY_TOKEN: 'authority', JC_ACS_TOKEN: 'model' }), 'authority');
  assert.equal(authorityToken({ JC_ACS_AUTHORITY_TOKEN_FILE: '/nonexistent/file' }), undefined);
  assert.equal(authorityToken({}), undefined);
});
console.log(`\njace-commander current authority: ${passed} passed`);
