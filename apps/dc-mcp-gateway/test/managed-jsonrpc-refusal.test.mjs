#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { jsonRpcManagedToolsCallError } from '../managed.js';

test('write_file require_approval is JSON-RPC -32002 with stable approval metadata', () => {
  const parsed = { jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'write_file' } };
  const body = jsonRpcManagedToolsCallError(parsed, {
    acsCode: 'require_approval',
    acsApproval: {
      workItemId: 'wrk_1',
      actionHash: 'a'.repeat(64),
      requiredScopes: ['fs.write'],
      approvalInstructions: 'POST /work-items/wrk_1/approve',
    },
  });
  assert.equal(body.jsonrpc, '2.0');
  assert.equal(body.id, 42);
  assert.equal(body.error.code, -32002);
  assert.equal(body.error.data.kind, 'managed_authorization_required');
  assert.equal(body.error.data.workItemId, 'wrk_1');
  assert.equal(body.error.data.requiredScopes[0], 'fs.write');
  assert.equal(body.error.data.instructions, 'POST /work-items/wrk_1/approve');
  assert.equal(body.error.data.retryable, true);
});

test('unknown_tool is JSON-RPC -32001 denied, not a transport failure', () => {
  const body = jsonRpcManagedToolsCallError({ id: 'x' }, {
    acsCode: 'unknown_tool',
    acsApproval: { reason: 'unknown_tool' },
  });
  assert.equal(body.id, 'x');
  assert.equal(body.error.code, -32001);
  assert.equal(body.error.data.kind, 'managed_authorization_denied');
  assert.equal(body.error.data.retryable, false);
});

test('ACS unreachable is JSON-RPC -32003', () => {
  const body = jsonRpcManagedToolsCallError({ id: 1 }, { acsCode: 'acs_http_unreachable' });
  assert.equal(body.error.code, -32003);
  assert.equal(body.error.data.kind, 'managed_authorization_unavailable');
  assert.equal(body.error.data.retryable, true);
});
