#!/usr/bin/env node
/**
 * jace-commander CLI: argument parsing, client-side path resolution, and the
 * mapping of every authorization outcome to a stable exit code — for both
 * refusal transports (today's edge HTTP 503 body and PR #204's JSON-RPC
 * -32001/-32002/-32003 errors). An ACS decision must never look like a crash.
 */
import assert from 'node:assert/strict';
import { absolutePath, CLI_COMMANDS, CliUsageError, helpText, parseArgs, resolveCommand } from '../dist/jace-commander/cli-commands.js';
import { classifyEdgeRefusalBody, classifyJsonRpcError, classifyToolResult, JC_EXIT, McpHttpClient } from '../dist/jace-commander/mcp-http-client.js';
import { main } from '../dist/jace-commander/cli.js';

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`  ✓ ${name}`); };

await test('parseArgs: flags, =values, booleans and -- terminator', () => {
  const parsed = parseArgs(['a', '--depth', '2', '--offset=-5', '--json', '--', '--not-a-flag'], ['json']);
  assert.deepEqual(parsed.positionals, ['a', '--not-a-flag']);
  assert.equal(parsed.flags.get('depth'), '2');
  assert.equal(parsed.flags.get('offset'), '-5');
  assert.equal(parsed.flags.get('json'), true);
  assert.throws(() => parseArgs(['--depth']), CliUsageError);
});

await test('absolutePath resolves ~, relative and absolute inputs client-side', () => {
  assert.equal(absolutePath('~', '/cwd', '/home/u'), '/home/u');
  assert.equal(absolutePath('~/p/x', '/cwd', '/home/u'), '/home/u/p/x');
  assert.equal(absolutePath('src/a.ts', '/repo', '/home/u'), '/repo/src/a.ts');
  assert.equal(absolutePath('/etc/x', '/repo', '/home/u'), '/etc/x');
});

await test('commands map argv to exactly one tool with validated arguments', () => {
  const { command, rest } = resolveCommand(['read', '/r/a.ts', '--offset', '10', '--length', '5']);
  assert.equal(command.tool, 'read_file');
  assert.deepEqual(command.toArguments(parseArgs(rest)), { path: '/r/a.ts', offset: 10, length: 5 });
  assert.equal(resolveCommand(['acs', 'read', 'health']).command.tool, 'acs_read');
  assert.throws(() => resolveCommand(['read', 'x', '--length', 'lots']).command.toArguments(parseArgs(['x', '--length', 'lots'])), CliUsageError);
  assert.throws(() => resolveCommand(['sudo', 'id']).command.toArguments(parseArgs(['id'])), /absolute/);
  assert.equal(resolveCommand(['nope']), undefined);
});

await test('help lists every command, grouped, with the exit-code table', () => {
  const help = helpText();
  for (const command of CLI_COMMANDS) assert.ok(help.includes(command.usage), command.usage);
  for (const heading of ['System', 'Filesystem', 'ACS', 'Exit codes:']) assert.ok(help.includes(heading), heading);
});

await test('today\'s edge 503 bodies classify by ACS decision, not as crashes', () => {
  const approval = classifyEdgeRefusalBody({ error: 'managed_authorization_required', code: 'require_approval', workItemId: 'wrk_1', actionHash: 'a'.repeat(64) });
  assert.equal(approval.exitCode, JC_EXIT.approvalRequired);
  assert.equal(approval.workItemId, 'wrk_1');
  assert.equal(classifyEdgeRefusalBody({ error: 'managed_authorization_unavailable', code: 'jace_commander_path_outside_allow_root' }).exitCode, JC_EXIT.denied);
  assert.equal(classifyEdgeRefusalBody({ error: 'managed_authorization_unavailable', code: 'policy_denied' }).exitCode, JC_EXIT.denied);
  assert.equal(classifyEdgeRefusalBody({ error: 'managed_authorization_unavailable', code: 'jace_commander_argument_invalid' }).exitCode, JC_EXIT.invalidArguments);
  for (const code of ['managed_fail_closed', 'acs_http_503', 'jace_commander_containment_unconfigured', 'capability_issuance_unconfigured']) {
    assert.equal(classifyEdgeRefusalBody({ error: 'managed_authorization_unavailable', code }).exitCode, JC_EXIT.authorityUnavailable, code);
  }
});

await test('PR #204 JSON-RPC errors classify by their normative codes', () => {
  assert.equal(classifyJsonRpcError({ code: -32001, message: 'denied', data: { acsCode: 'x' } }).exitCode, JC_EXIT.denied);
  const approval = classifyJsonRpcError({ code: -32002, message: 'ACS approval required', data: { workItemId: 'wrk_2', actionHash: 'b'.repeat(64), retryable: true } });
  assert.equal(approval.exitCode, JC_EXIT.approvalRequired);
  assert.equal(approval.workItemId, 'wrk_2');
  assert.equal(approval.retryable, true);
  assert.equal(classifyJsonRpcError({ code: -32003, data: {} }).exitCode, JC_EXIT.authorityUnavailable);
});

await test('tool results: success, JC verifier refusal (denied) and ordinary tool errors', () => {
  const ok = classifyToolResult({ content: [{ type: 'text', text: '{}' }], structuredContent: { a: 1 } });
  assert.deepEqual([ok.exitCode, ok.result], [JC_EXIT.ok, { a: 1 }]);
  const verifier = classifyToolResult({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: 'JC_CAPABILITY_MISSING', message: 'x' } }) }] });
  assert.equal(verifier.exitCode, JC_EXIT.denied);
  const toolError = classifyToolResult({ isError: true, structuredContent: { error: { code: 'not_found', message: 'no such file' } }, content: [] });
  assert.deepEqual([toolError.exitCode, toolError.code], [JC_EXIT.toolFailure, 'not_found']);
});

await test('the client maps a 401 to not-connected and never throws for a refusal', async () => {
  const fake = async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } });
  const client = new McpHttpClient({ url: 'http://edge.test/jc/mcp', token: async () => 't', fetchImpl: fake });
  const result = await client.callTool('read_file', { path: '/x' });
  assert.equal(result.exitCode, JC_EXIT.notConnected);
});

await test('main(): --json prints the structured refusal; nothing is sent without a credential', async () => {
  const out = [];
  const code = await main(['ls', '/tmp', '--json'], { HOME: '/tmp', JC_STATE_DIR: '/tmp/jc-cli-test-state', JC_MCP_URL: 'http://127.0.0.1:9/jc/mcp' }, { stdout: (t) => out.push(t), stderr: () => {} });
  assert.equal(code, JC_EXIT.notConnected);
  assert.equal(JSON.parse(out[0]).kind, 'not_connected');
});

console.log(`\njace-commander cli: ${passed} passed`);
