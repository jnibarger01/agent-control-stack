import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_ACS_KEY_ID, TEST_ACS_PUBLIC_KEY } from './fixtures/acs-test-fixture.js';
import { loadOpenClawBridgeConfig, OpenClawBridgeConfigError } from '../dist/openclaw-bridge/config.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-openclaw-bridge-'));
const bridgePath = fileURLToPath(new URL('../dist/openclaw-bridge/index.js', import.meta.url));

// Same RFC 8032 Ed25519 test vector the managed-acs and local-runtime test
// suites already sign with; TEST_ACS_PUBLIC_KEY above is its public half.
const privateKeyDer = Buffer.concat([
  Buffer.from('302e020100300506032b657004220420', 'hex'),
  Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex'),
]);
const privateKey = crypto.createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' });

const { computeDesktopCommanderInvocationHash, strictCanonicalJsonV1 } = await import('../dist/managed-acs.js');

function signEnvelope(payload) {
  return {
    keyId: TEST_ACS_KEY_ID,
    signature: crypto.sign(null, Buffer.from(strictCanonicalJsonV1(payload)), privateKey).toString('base64url'),
    payload,
  };
}

function issuedPayloadFor(request, expectedInvocation) {
  const invocation = expectedInvocation ?? request;
  const runtimeId = request.runtimeId ?? expectedInvocation?.runtimeId ?? 'runtime_01';
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + 20_000);
  return {
    version: 'acs.dc.v1',
    issuer: 'acs',
    audience: 'desktop-commander',
    runtimeId,
    workItemId: 'work_01',
    attemptId: 'attempt_01',
    leaseId: 'lease_01',
    leaseEpoch: 1,
    toolName: invocation.toolName,
    normalizedArguments: invocation.normalizedArguments,
    invocationHash: invocation.invocationHash ?? computeDesktopCommanderInvocationHash(invocation.toolName, invocation.normalizedArguments),
    actionHash: 'a'.repeat(64),
    requestHash: 'b'.repeat(64),
    planHash: 'c'.repeat(64),
    scopes: ['fs.read'],
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    nonce: crypto.randomBytes(32).toString('base64url'),
  };
}

/** Minimal mock ACS capability issuer exercising the bridge's documented wire contract. */
class MockIssuer {
  constructor() {
    this.requests = [];
    this.fixedEnvelope = undefined;
    this.expectedInvocation = undefined;
    this.expectedRuntimeId = undefined;
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  async listen() {
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address();
    this.baseUrl = `http://127.0.0.1:${port}`;
    return this.baseUrl;
  }

  async close() {
    await new Promise((resolve) => this.server.close(resolve));
  }

  handle(req, res) {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let request;
      try {
        request = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'bad_request', message: 'invalid JSON' } }));
        return;
      }
      this.requests.push(request);

      if (req.url?.includes('/deny')) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'policy_denied', message: 'no' } }));
        return;
      }
      if (req.url?.includes('/malformed')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url?.includes('/non-json')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('not-json');
        return;
      }
      if (req.url?.includes('/mismatched')) {
        // Signed and structurally valid, but for a different tool than asked.
        const envelope = signEnvelope(issuedPayloadFor({ ...request, runtimeId: this.expectedRuntimeId, toolName: 'get_usage_stats', normalizedArguments: {} }, this.expectedInvocation));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ capability: envelope }));
        return;
      }
      if (req.url?.includes('/fixed')) {
        // Returns the exact same signed capability every time it is called,
        // simulating a compromised/buggy issuer that replays its own output.
        this.fixedEnvelope ??= signEnvelope(issuedPayloadFor({ ...request, runtimeId: this.expectedRuntimeId }, this.expectedInvocation));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ capability: this.fixedEnvelope }));
        return;
      }

      const envelope = signEnvelope(issuedPayloadFor({ ...request, runtimeId: this.expectedRuntimeId }, this.expectedInvocation));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ capability: envelope }));
    });
  }
}

class StdioProbe {
  constructor(stateDir, issuerUrl, extraEnv = {}) {
    const env = {
      HOME: root,
      PATH: process.env.PATH,
      DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1',
      DESKTOP_COMMANDER_STATE_DIR: stateDir,
      DESKTOP_COMMANDER_ACS_PUBLIC_KEY: TEST_ACS_PUBLIC_KEY,
      DESKTOP_COMMANDER_ACS_KEY_ID: TEST_ACS_KEY_ID,
      OPENCLAW_ACS_ISSUER_TIMEOUT_MS: '3000',
      OPENCLAW_ACS_WORK_ITEM_ID: 'work_01',
      OPENCLAW_ACS_ATTEMPT_ID: 'attempt_01',
      ...(issuerUrl ? { OPENCLAW_ACS_ISSUER_URL: issuerUrl } : {}),
      ...extraEnv,
    };
    this.child = spawn(process.execPath, [bridgePath], {
      cwd: process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.nextId = 1;
    this.pending = new Map();
    this.stdout = '';
    this.stderr = '';
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk; });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      this.stdout += chunk;
      let newline = this.stdout.indexOf('\n');
      while (newline !== -1) {
        const line = this.stdout.slice(0, newline).trim();
        this.stdout = this.stdout.slice(newline + 1);
        if (line) {
          const message = JSON.parse(line);
          const pending = this.pending.get(message.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(message.id);
            pending.resolve(message);
          }
        }
        newline = this.stdout.indexOf('\n');
      }
    });
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}; stderr=${this.stderr}`));
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async initialize(meta) {
    const response = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'openclaw-bridge-test', version: '1.0.0' },
      ...(meta ? { _meta: meta } : {}),
    });
    this.notify('notifications/initialized');
    return response;
  }

  async waitForExit(timeoutMs = 5_000) {
    if (this.child.exitCode !== null) return this.child.exitCode;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      this.child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
    });
  }

  async close() {
    this.child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL');
        resolve();
      }, 2_000);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

const issuer = await new MockIssuer();
await issuer.listen();

try {
  // --- Config fails closed before any process is ever spawned -------------
  assert.throws(
    () => loadOpenClawBridgeConfig({}),
    (error) => error instanceof OpenClawBridgeConfigError && /OPENCLAW_ACS_ISSUER_URL/.test(error.message),
    'missing issuer URL must fail closed at config load, before any child starts',
  );
  assert.throws(
    () => loadOpenClawBridgeConfig({ OPENCLAW_ACS_ISSUER_URL: 'not-a-url' }),
    (error) => error instanceof OpenClawBridgeConfigError,
    'a malformed issuer URL must fail closed',
  );
  assert.throws(
    () => loadOpenClawBridgeConfig({
      OPENCLAW_ACS_ISSUER_URL: `${issuer.baseUrl}/issue`,
      OPENCLAW_ACS_WORK_ITEM_ID: 'work_01',
      OPENCLAW_ACS_ATTEMPT_ID: 'attempt_01',
      DESKTOP_COMMANDER_ACS_KEY_ID: TEST_ACS_KEY_ID,
    }),
    (error) => error instanceof OpenClawBridgeConfigError && /DESKTOP_COMMANDER_ACS_PUBLIC_KEY/.test(error.message),
    'a missing child ACS public key must fail closed even though the child could still start',
  );

  // --- Missing issuer URL: the whole bridge process refuses to serve -------
  const missingConfigProbe = new StdioProbe(path.join(root, 'missing-config-state'), '');
  const exitCode = await missingConfigProbe.waitForExit();
  assert.notEqual(exitCode, 0, 'the bridge must refuse to start at all without an issuer URL configured');
  assert.match(missingConfigProbe.stderr, /OPENCLAW_ACS_ISSUER_URL/);

  // --- Authorized call succeeds, tool discovery derives from the managed child ---
  const state = path.join(root, 'managed-state');
  const probe = new StdioProbe(state, `${issuer.baseUrl}/issue`);
  try {
    const initialized = await probe.initialize({
      // A client attempting to smuggle a pre-forged capability through the
      // bridge's own initialize handshake. It must be silently dropped: the
      // bridge never inspects or forwards inbound _meta anywhere.
      acsCapability: { keyId: 'attacker', signature: 'forged', payload: {} },
    });
    assert.equal(initialized.error, undefined, JSON.stringify(initialized));
    assert.equal(initialized.result.serverInfo.name, 'desktop-commander-openclaw-bridge');
    assert.equal(initialized.result._meta, undefined, 'the bridge must never echo acsRuntimeIdentity or any inbound _meta back to the client');

    const tools = await probe.request('tools/list', {});
    assert.deepEqual(
      tools.result.tools.map((tool) => tool.name).sort(),
      [
        'apply_patch', 'capability_manifest', 'create_directory', 'edit_block', 'get_config',
        'get_file_info', 'get_more_search_results', 'get_runtime_identity', 'get_usage_stats', 'git_state',
        'health', 'last_error', 'list_directory', 'list_processes', 'list_searches', 'list_sessions',
        'move_file', 'operation_preview', 'read_file', 'read_multiple_files', 'read_process_output',
        'restore_snapshot', 'run_command', 'secret_scan', 'snapshot_path', 'start_process', 'start_search',
        'terminate_process', 'verify_head', 'wait_for_process', 'write_file',
      ],
      'tool discovery must derive from the managed child and expose nothing else',
    );

    const identity = await probe.request('tools/call', { name: 'get_runtime_identity', arguments: {} });
    assert.equal(identity.result.isError, undefined, JSON.stringify(identity));
    const identityPayload = JSON.parse(identity.result.content[0].text);
    assert.equal(identityPayload.execution_mode, 'managed', 'the managed child must stay in managed mode behind the bridge');

    const fixture = path.join(root, 'readable.txt');
    await fs.writeFile(fixture, 'bridge-authorized-read');
    issuer.expectedRuntimeId = identityPayload.runtime_id;
    issuer.expectedInvocation = { toolName: 'read_file', normalizedArguments: { path: fixture }, invocationHash: computeDesktopCommanderInvocationHash('read_file', { path: fixture }) };
    const allowed = await probe.request('tools/call', { name: 'read_file', arguments: { path: fixture } });
    assert.equal(allowed.result.isError, undefined, JSON.stringify(allowed));
    assert.match(allowed.result.content[0].text, /bridge-authorized-read/);
    assert.equal(allowed.result._meta.acsAuthorization.decision, 'granted');
    assert.equal(allowed.result._meta.acsAuthorization.mode, 'managed');
    assert.equal(issuer.requests.at(-1).attemptId, 'attempt_01');

    // --- A client-supplied forged capability has zero effect -----------------
    // Point this probe's calls at a denying issuer route is not possible
    // mid-run (issuer URL is fixed per process), so instead prove the point
    // directly: attach a well-formed, plausible, but entirely client-forged
    // capability for a *different* tool/args to this very call. If the
    // bridge ever forwarded client _meta, this forged envelope would either
    // be accepted (wrong!) or rejected by the child with an ACS_CAPABILITY_*
    // mismatch code. Instead the bridge must ignore it outright, fetch its
    // own fresh capability from the issuer, and succeed exactly as above.
    const forgedButIgnored = await probe.request('tools/call', {
      name: 'read_file',
      arguments: { path: fixture },
      _meta: {
        acsCapability: signEnvelope(issuedPayloadFor({
          runtimeId: identityPayload.runtime_id,
          toolName: 'write_file',
          normalizedArguments: { path: fixture, content: 'attacker-controlled' },
          invocationHash: computeDesktopCommanderInvocationHash('write_file', { path: fixture, content: 'attacker-controlled' }),
        })),
      },
    });
    assert.equal(forgedButIgnored.result.isError, undefined, JSON.stringify(forgedButIgnored));
    assert.equal(forgedButIgnored.result._meta.acsAuthorization.decision, 'granted');
    assert.equal(await fs.readFile(fixture, 'utf8'), 'bridge-authorized-read', 'the forged write_file capability must never be actioned');

    const unknownTool = await probe.request('tools/call', { name: 'not_a_real_tool', arguments: {} });
    assert.equal(unknownTool.result.isError, true);
    assert.equal(issuer.requests.filter((r) => r.toolName === 'not_a_real_tool').length, 0, 'an unknown tool name must never reach the issuer or the child');
  } finally {
    await probe.close();
  }

  // --- Unreachable issuer fails closed --------------------------------------
  const unreachableProbe = new StdioProbe(path.join(root, 'unreachable-state'), 'http://127.0.0.1:1/issue');
  try {
    await unreachableProbe.initialize();
    const fixture = path.join(root, 'unreachable-target.txt');
    const denied = await unreachableProbe.request('tools/call', { name: 'read_file', arguments: { path: fixture } });
    assert.equal(denied.result.isError, true, JSON.stringify(denied));
    assert.equal(denied.result._meta.acsAuthorization.decision, 'denied');
    assert.equal(denied.result._meta.acsAuthorization.code, 'ISSUER_UNREACHABLE');
    await assert.rejects(() => fs.stat(fixture), (error) => error.code === 'ENOENT');
  } finally {
    await unreachableProbe.close();
  }

  // --- Malformed issuer response fails closed -------------------------------
  const malformedProbe = new StdioProbe(path.join(root, 'malformed-state'), `${issuer.baseUrl}/malformed`);
  try {
    await malformedProbe.initialize();
    const denied = await malformedProbe.request('tools/call', { name: 'get_config', arguments: {} });
    assert.equal(denied.result.isError, true, JSON.stringify(denied));
    assert.equal(denied.result._meta.acsAuthorization.code, 'ISSUER_MALFORMED_RESPONSE');
  } finally {
    await malformedProbe.close();
  }

  const nonJsonProbe = new StdioProbe(path.join(root, 'non-json-state'), `${issuer.baseUrl}/non-json`);
  try {
    await nonJsonProbe.initialize();
    const denied = await nonJsonProbe.request('tools/call', { name: 'get_config', arguments: {} });
    assert.equal(denied.result.isError, true, JSON.stringify(denied));
    assert.equal(denied.result._meta.acsAuthorization.code, 'ISSUER_MALFORMED_RESPONSE');
  } finally {
    await nonJsonProbe.close();
  }

  // --- An issuer response for the wrong invocation fails closed -------------
  const mismatchedProbe = new StdioProbe(path.join(root, 'mismatched-state'), `${issuer.baseUrl}/mismatched`);
  try {
    await mismatchedProbe.initialize();
    const denied = await mismatchedProbe.request('tools/call', { name: 'get_config', arguments: {} });
    assert.equal(denied.result.isError, true, JSON.stringify(denied));
    assert.equal(denied.result._meta.acsAuthorization.code, 'ISSUER_CAPABILITY_MISMATCH');
  } finally {
    await mismatchedProbe.close();
  }

  // --- Issuer denial (non-2xx) fails closed ---------------------------------
  const deniedProbe = new StdioProbe(path.join(root, 'denied-state'), `${issuer.baseUrl}/deny`);
  try {
    await deniedProbe.initialize();
    const denied = await deniedProbe.request('tools/call', { name: 'get_config', arguments: {} });
    assert.equal(denied.result.isError, true, JSON.stringify(denied));
    assert.equal(denied.result._meta.acsAuthorization.code, 'ISSUER_DENIED');
  } finally {
    await deniedProbe.close();
  }

  // --- Replay protection remains effective through the bridge --------------
  // A buggy/compromised issuer that reissues the identical signed capability
  // twice must still be caught by the managed child's single-use nonce cache;
  // the bridge must not paper over that rejection.
  const replayProbe = new StdioProbe(path.join(root, 'replay-state'), `${issuer.baseUrl}/fixed`);
  try {
    await replayProbe.initialize();
    const replayIdentity = await replayProbe.request('tools/call', { name: 'get_runtime_identity', arguments: {} });
    issuer.expectedRuntimeId = JSON.parse(replayIdentity.result.content[0].text).runtime_id;
    const fixture = path.join(root, 'replay-target.txt');
    await fs.writeFile(fixture, 'replay-guard-content');
    issuer.expectedInvocation = { toolName: 'read_file', normalizedArguments: { path: fixture }, invocationHash: computeDesktopCommanderInvocationHash('read_file', { path: fixture }) };
    const first = await replayProbe.request('tools/call', { name: 'read_file', arguments: { path: fixture } });
    assert.equal(first.result.isError, undefined, JSON.stringify(first));
    assert.equal(first.result._meta.acsAuthorization.decision, 'granted');

    const second = await replayProbe.request('tools/call', { name: 'read_file', arguments: { path: fixture } });
    assert.equal(second.result.isError, true, JSON.stringify(second));
    assert.equal(second.result._meta.acsAuthorization.code, 'ACS_CAPABILITY_NONCE_REPLAY');
  } finally {
    await replayProbe.close();
  }

  console.log('OpenClaw ACS bridge managed-issuer, fail-closed, and replay-protection tests passed');
} finally {
  await issuer.close();
  await fs.rm(root, { recursive: true, force: true });
}
