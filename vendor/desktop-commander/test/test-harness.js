import assert from 'node:assert/strict';
import { DesktopCommanderAgent } from '../dist/harness/openai-agent.js';

const systemPath = new URL('../SYSTEM.md', import.meta.url).pathname;

function response(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeRuntime() {
  const calls = [];
  return {
    calls,
    started: false,
    stopped: false,
    async start() { this.started = true; },
    async listTools() {
      return {
        tools: [
          { name: 'read_file', description: 'read', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
          { name: 'write_file', description: 'write', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
          { name: 'not_allowlisted', description: 'nope', inputSchema: { type: 'object' } },
        ],
      };
    },
    async callTool(name, args, timeout, meta) {
      calls.push({ name, args, timeout, meta });
      return { content: [{ type: 'text', text: 'file contents' }] };
    },
    async shutdown() { this.stopped = true; },
  };
}
async function testReadOnlyToolLoop() {
  const runtime = fakeRuntime();
  const requests = [];
  const replies = [
    {
      id: 'resp_1',
      output: [{
        type: 'function_call',
        call_id: 'call_1',
        name: 'read_file',
        arguments: '{"path":"/tmp/example.txt"}',
      }],
    },
    {
      id: 'resp_2',
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: 'Read completed.' }],
      }],
    },
  ];

  const agent = new DesktopCommanderAgent({
    apiKey: 'test-key',
    systemPath,
    runtime,
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return response(replies.shift());
    },
  });

  assert.equal(await agent.run('Read the file'), 'Read completed.');
  assert.equal(runtime.calls.length, 1);
  assert.equal(runtime.calls[0].name, 'read_file');
  assert.ok(requests[0].instructions.includes('Inspect before modifying.'));
  assert.ok(requests[0].tools.some((tool) => tool.name === 'read_file'));
  assert.ok(!requests[0].tools.some((tool) => tool.name === 'not_allowlisted'));
  assert.equal(requests[1].previous_response_id, 'resp_1');
  assert.equal(requests[1].input[0].type, 'function_call_output');
  await agent.shutdown();
  assert.equal(runtime.stopped, true);
}

async function testMutationDenialIsFailClosed() {
  const runtime = fakeRuntime();
  const requests = [];
  const replies = [
    {
      id: 'resp_write_1',
      output: [{
        type: 'function_call',
        call_id: 'call_write',
        name: 'write_file',
        arguments: '{"path":"/tmp/example.txt","content":"changed"}',
      }],
    },
    {
      id: 'resp_write_2',
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: 'Write was not approved.' }],
      }],
    },
  ];

  const agent = new DesktopCommanderAgent({
    apiKey: 'test-key',
    systemPath,
    runtime,
    approval: async () => false,
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return response(replies.shift());
    },
  });

  assert.equal(await agent.run('Change the file'), 'Write was not approved.');
  assert.equal(runtime.calls.length, 0);
  assert.match(requests[1].input[0].output, /USER_APPROVAL_REQUIRED/);
  await agent.shutdown();
}

await testReadOnlyToolLoop();
await testMutationDenialIsFailClosed();
console.log('Harness regression tests passed.');
