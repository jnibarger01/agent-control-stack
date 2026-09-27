import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-managed-stdio-'));
const managedState = path.join(root, 'managed-state');
const standaloneState = path.join(root, 'standalone-state');
const scopes = ['fs.read', 'fs.write', 'network.read', 'network.write', 'process.exec', 'process.spawn'];
const challenge = Buffer.alloc(32, 11).toString('base64url');
const serverPath = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const privateKeyDer = Buffer.concat([
  Buffer.from('302e020100300506032b657004220420', 'hex'),
  Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex'),
]);
const publicKeyDer = Buffer.concat([
  Buffer.from('302a300506032b6570032100', 'hex'),
  Buffer.from('11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo', 'base64url'),
]);
const privateKey = crypto.createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' });
const { computeDesktopCommanderInvocationHash, strictCanonicalJsonV1 } = await import('../dist/managed-acs.js');

class StdioProbe {
  constructor(args, stateDir, extraEnv = {}) {
    this.child = spawn(process.execPath, [serverPath, '--no-onboarding', ...args], {
      cwd: process.cwd(),
      env: {
        HOME: root,
        PATH: process.env.PATH,
        DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1',
        DESKTOP_COMMANDER_STATE_DIR: stateDir,
        ...extraEnv,
      },
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

  rawRequest(jsonForId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for raw request; stderr=${this.stderr}`));
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${jsonForId(id)}\n`);
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
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

async function initialize(probe, meta) {
  const response = await probe.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'managed-acs-stdio-test', version: '1.0.0' },
    ...(meta ? { _meta: meta } : {}),
  });
  probe.notify('notifications/initialized');
  return response;
}

try {
  const managed = new StdioProbe([], managedState, {
    DESKTOP_COMMANDER_ACS_PUBLIC_KEY: publicKeyDer.toString('base64url'),
    DESKTOP_COMMANDER_ACS_KEY_ID: 'test-key-1',
  });
  try {
    const preexistingIdentity = await import('../dist/runtime-identity.js').then(({ getRuntimeIdentityState }) =>
      getRuntimeIdentityState({ stateDirectory: managedState, homeDirectory: root }));
    const initialized = await initialize(managed, {
      acsRuntimeBootstrap: {
        schemaVersion: 1,
        runtimeId: preexistingIdentity.runtime_id,
        challenge,
        scopes,
      },
    });
    assert.equal(initialized.error, undefined, JSON.stringify(initialized));
    assert.deepEqual(initialized.result._meta.acsRuntimeIdentity, {
      schemaVersion: 1,
      runtimeId: preexistingIdentity.runtime_id,
      challenge,
      scopes,
    });
    assert.equal(initialized.result._meta.desktopCommanderMode, 'managed');

    const tools = await managed.request('tools/list', {});
    assert.ok(tools.result.tools.length > 0, 'tools/list remains available in managed mode');
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
      'managed discovery must advertise only the exact ACS v1 allowlist plus identity discovery',
    );
    const ping = await managed.request('ping', {});
    assert.deepEqual(ping.result, {}, 'health ping remains available in managed mode');

    const identity = await managed.request('tools/call', { name: 'get_runtime_identity', arguments: {} });
    assert.equal(identity.result.isError, undefined, JSON.stringify(identity));
    const identityPayload = JSON.parse(identity.result.content[0].text);
    assert.equal(identityPayload.runtime_id, preexistingIdentity.runtime_id);
    assert.equal(identityPayload.execution_mode, 'managed');

    const managedFile = path.join(root, 'must-not-exist.txt');
    const denied = await managed.request('tools/call', {
      name: 'write_file',
      arguments: { path: managedFile, content: 'blocked' },
    });
    assert.equal(denied.result.isError, true, JSON.stringify(denied));
    assert.equal(denied.result._meta.acsAuthorization.code, 'ACS_CAPABILITY_MISSING');
    await assert.rejects(() => fs.stat(managedFile), (error) => error.code === 'ENOENT');

    const duplicate = await managed.rawRequest((id) =>
      `{"jsonrpc":"2.0","id":${id},"method":"tools/call","params":{"name":"read_file","arguments":{"path":"${managedFile}"},"_meta":{"acsCapability":null,"acsCapability":null}}}`);
    assert.equal(duplicate.result.isError, true);
    assert.equal(duplicate.result._meta.acsAuthorization.code, 'ACS_CAPABILITY_EXTRA_FIELD');

    const fixture = path.join(root, 'managed-readable.txt');
    await fs.writeFile(fixture, 'capability-authorized-read');
    const readArguments = { path: fixture };
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 30_000);
    const payload = {
      version: 'acs.dc.v1',
      issuer: 'acs',
      audience: 'desktop-commander',
      runtimeId: preexistingIdentity.runtime_id,
      workItemId: 'work_01',
      attemptId: 'attempt_01',
      leaseId: 'lease_01',
      leaseEpoch: 1,
      toolName: 'read_file',
      normalizedArguments: readArguments,
      invocationHash: computeDesktopCommanderInvocationHash('read_file', readArguments),
      actionHash: 'a'.repeat(64),
      requestHash: 'b'.repeat(64),
      planHash: 'c'.repeat(64),
      scopes: ['fs.read'],
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      nonce: crypto.randomBytes(32).toString('base64url'),
    };
    const envelope = {
      payload,
      keyId: 'test-key-1',
      signature: crypto.sign(null, Buffer.from(strictCanonicalJsonV1(payload)), privateKey).toString('base64url'),
    };
    const allowed = await managed.request('tools/call', {
      name: 'read_file',
      arguments: readArguments,
      _meta: { acsCapability: envelope },
    });
    assert.equal(allowed.result.isError, undefined, JSON.stringify(allowed));
    assert.match(allowed.result.content[0].text, /capability-authorized-read/);
    assert.equal(allowed.result._meta.acsAuthorization.decision, 'granted');

    const replayed = await managed.request('tools/call', {
      name: 'read_file',
      arguments: readArguments,
      _meta: { acsCapability: envelope },
    });
    assert.equal(replayed.result.isError, true);
    assert.equal(replayed.result._meta.acsAuthorization.code, 'ACS_CAPABILITY_NONCE_REPLAY');

    const forgedPayload = { ...payload, nonce: crypto.randomBytes(32).toString('base64url') };
    const forged = await managed.request('tools/call', {
      name: 'read_file',
      arguments: readArguments,
      _meta: {
        acsCapability: {
          payload: forgedPayload,
          keyId: 'test-key-1',
          signature: Buffer.alloc(64).toString('base64url'),
        },
      },
    });
    assert.equal(forged.result.isError, true);
    assert.equal(forged.result._meta.acsAuthorization.code, 'ACS_CAPABILITY_SIGNATURE_INVALID');

    // P0-2: `origin` is transport metadata. A capability bound WITHOUT origin
    // verifies a delivered request that carries origin (full DC server path).
    const signFresh = (toolName, normalizedArguments, scopes) => {
      const fresh = {
        ...payload,
        toolName,
        normalizedArguments,
        invocationHash: computeDesktopCommanderInvocationHash(toolName, normalizedArguments),
        scopes,
        nonce: crypto.randomBytes(32).toString('base64url'),
      };
      return {
        payload: fresh,
        keyId: 'test-key-1',
        signature: crypto.sign(null, Buffer.from(strictCanonicalJsonV1(fresh)), privateKey).toString('base64url'),
      };
    };
    const withOrigin = await managed.request('tools/call', {
      name: 'read_file',
      arguments: { ...readArguments, origin: 'llm' },
      _meta: { acsCapability: signFresh('read_file', readArguments, ['fs.read']) },
    });
    assert.equal(withOrigin.result.isError, undefined, JSON.stringify(withOrigin));
    assert.match(withOrigin.result.content[0].text, /capability-authorized-read/);
    const configWithOrigin = await managed.request('tools/call', {
      name: 'get_config',
      arguments: { origin: 'ui' },
      _meta: { acsCapability: signFresh('get_config', {}, ['fs.read']) },
    });
    assert.equal(configWithOrigin.result.isError, undefined, JSON.stringify(configWithOrigin));
    const badOrigin = await managed.request('tools/call', {
      name: 'get_config',
      arguments: { origin: 'admin' },
      _meta: { acsCapability: signFresh('get_config', {}, ['fs.read']) },
    });
    assert.equal(badOrigin.result._meta.acsAuthorization.code, 'ACS_CAPABILITY_ARGUMENTS_MISMATCH');

    // P0-5: get_runtime_identity stays callable without a capability (above),
    // but a PRESENTED capability is verified, never ignored.
    const identityGranted = await managed.request('tools/call', {
      name: 'get_runtime_identity',
      arguments: {},
      _meta: { acsCapability: signFresh('get_runtime_identity', {}, ['process.exec']) },
    });
    assert.equal(identityGranted.result.isError, undefined, JSON.stringify(identityGranted));
    assert.equal(identityGranted.result._meta.acsAuthorization.decision, 'granted');
    const identityPayloadGranted = JSON.parse(identityGranted.result.content[0].text);
    for (const forbidden of ['token', 'access_token', 'refresh_token', 'credentials', 'user', 'email', 'decision']) {
      assert.equal(Object.prototype.hasOwnProperty.call(identityPayloadGranted, forbidden), false, forbidden);
    }
    const identityForged = await managed.request('tools/call', {
      name: 'get_runtime_identity',
      arguments: {},
      _meta: { acsCapability: { payload: forgedPayload, keyId: 'test-key-1', signature: Buffer.alloc(64).toString('base64url') } },
    });
    assert.equal(identityForged.result.isError, true);
    assert.equal(identityForged.result._meta.acsAuthorization.code, 'ACS_CAPABILITY_SIGNATURE_INVALID');

    // Expansion: a capability-authorized new tool executes through the managed
    // guard; the bound argv (ACS-resolved executable) is what runs, and a
    // drifted argv is refused before execution.
    const health = await managed.request('tools/call', {
      name: 'health', arguments: {}, _meta: { acsCapability: signFresh('health', {}, ['process.exec']) },
    });
    assert.equal(health.result.isError, undefined, JSON.stringify(health));
    assert.equal(health.result._meta.acsAuthorization.decision, 'granted');
    assert.equal(JSON.parse(health.result.content[0].text).subsystems.managed_transport.status, 'ok');
    const unsupported = await managed.request('tools/call', { name: 'service_status', arguments: { checks: [{ type: 'executable', name: 'node' }] } });
    assert.equal(unsupported.result.isError, true);
    assert.equal(unsupported.result._meta.acsAuthorization.code, 'ACS_CAPABILITY_MISSING');
  } finally {
    await managed.close();
  }

  // Production lane (bridge.env): DC_ACS_CAPABILITY_PUBLIC_KEY is configured
  // and the gateway transports the ACS envelope under BOTH _meta.capability
  // (enforcement pipeline) and _meta.acsCapability (managed guard). A
  // capability-authorized run_command executes exactly the bound argv; a
  // drifted argv is refused before execution.
  const prod = new StdioProbe([], managedState, {
    DESKTOP_COMMANDER_ACS_PUBLIC_KEY: publicKeyDer.toString('base64url'),
    DESKTOP_COMMANDER_ACS_KEY_ID: 'test-key-1',
    DC_ACS_CAPABILITY_PUBLIC_KEY: publicKeyDer.toString('base64url'),
    DC_ACS_CAPABILITY_KEY_ID: 'test-key-1',
  });
  try {
    const identity = await import('../dist/runtime-identity.js').then(({ getRuntimeIdentityState }) =>
      getRuntimeIdentityState({ stateDirectory: managedState, homeDirectory: root }));
    const init = await initialize(prod, { acsRuntimeBootstrap: { schemaVersion: 1, runtimeId: identity.runtime_id, challenge, scopes } });
    assert.equal(init.error, undefined, JSON.stringify(init));
    const sign = (toolName, normalizedArguments, toolScopes, approval) => {
      const now = new Date();
      const payload = {
        version: 'acs.dc.v1', issuer: 'acs', audience: 'desktop-commander', runtimeId: identity.runtime_id,
        workItemId: 'work_02', attemptId: 'attempt_02', leaseId: 'lease_02', leaseEpoch: 1, toolName, normalizedArguments,
        invocationHash: computeDesktopCommanderInvocationHash(toolName, normalizedArguments),
        actionHash: 'a'.repeat(64), requestHash: 'b'.repeat(64), planHash: 'c'.repeat(64), scopes: toolScopes,
        ...(approval ? { approvalId: 'approval_02' } : {}),
        issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 29_000).toISOString(),
        nonce: crypto.randomBytes(32).toString('base64url'),
      };
      const envelope = { payload, keyId: 'test-key-1', signature: crypto.sign(null, Buffer.from(strictCanonicalJsonV1(payload)), privateKey).toString('base64url') };
      return { capability: envelope, acsCapability: envelope };
    };
    const boundRun = { argv: [process.execPath, '-e', 'process.stdout.write("managed-ok")'], cwd: root };
    const ran = await prod.request('tools/call', {
      name: 'run_command', arguments: { ...boundRun, origin: 'llm' }, _meta: sign('run_command', boundRun, ['process.spawn'], true),
    });
    assert.equal(ran.result.isError, undefined, JSON.stringify(ran));
    assert.equal(JSON.parse(ran.result.content[0].text).stdout, 'managed-ok');
    assert.equal(ran.result._meta.acsAuthorization.decision, 'granted');
    const drifted = await prod.request('tools/call', {
      name: 'run_command', arguments: { ...boundRun, argv: ['node', ...boundRun.argv.slice(1)] }, _meta: sign('run_command', boundRun, ['process.spawn'], true),
    });
    assert.equal(drifted.result.isError, true);
    assert.equal(drifted.result._meta.acsAuthorization.code, 'ACS_CAPABILITY_ARGUMENTS_MISMATCH');
    const noApproval = await prod.request('tools/call', {
      name: 'run_command', arguments: boundRun, _meta: sign('run_command', boundRun, ['process.spawn'], false),
    });
    assert.equal(noApproval.result._meta.acsAuthorization.code, 'ACS_CAPABILITY_APPROVAL_REQUIRED');
  } finally {
    await prod.close();
  }

  const standalone = new StdioProbe(['--standalone'], standaloneState);
  try {
    const initialized = await initialize(standalone);
    assert.equal(initialized.error, undefined, JSON.stringify(initialized));
    assert.equal(initialized.result._meta.desktopCommanderMode, 'standalone');

    const standaloneFile = path.join(root, 'standalone.txt');
    const result = await standalone.request('tools/call', {
      name: 'write_file',
      arguments: { path: standaloneFile, content: 'allowed' },
    });
    assert.equal(result.result.isError, undefined, JSON.stringify(result));
    assert.equal(await fs.readFile(standaloneFile, 'utf8'), 'allowed');
  } finally {
    await standalone.close();
  }

  console.log('managed stdio default-deny and explicit standalone opt-in smoke tests passed');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
