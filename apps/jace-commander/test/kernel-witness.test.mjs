#!/usr/bin/env node
/**
 * TDD regression tests for JC Kernel Witness integration:
 * - Receipt Ed25519 signature, canonical hash, completeness, correlation, and replay protection
 * - Pre-exec witness wrapping in processes.ts (preserving bwrap --info-fd 3)
 * - Fail-closed behavior on missing witness, incomplete observation, tampered/replayed receipt
 * - Server LoopTrace witness events + ACS POST /black-box/kernel-witness/receipts submission
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  SeenReceiptStore,
  buildWitnessRunArgv,
  canonicalWitnessBody,
  verifyKernelWitnessReceipt,
} from '../dist/kernel-witness.js';
import { createProcessRegistry } from '../dist/processes.js';
import { sandboxPolicyFromEnv } from '../dist/sandbox.js';
import { loadJcConfig } from '../dist/config.js';
import { createJcServer } from '../dist/server.js';
import { readTraceFile, verifyChain } from '../dist/looptrace.js';
import { makeIssuer, authorityBody } from './fixtures/jc-mint.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-witness-int-'));
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function signReceipt(base) {
  const body = canonicalWitnessBody(base);
  const evidenceHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
  const signature = crypto.sign(null, Buffer.from(body, 'utf8'), privateKey).toString('base64');
  return { ...base, evidenceHash, signature };
}

function makeReceipt(overrides = {}) {
  return signReceipt({
    schemaVersion: 'jc.kernel-witness.receipt.v1',
    observerVersion: '0.1.0',
    observerMode: 'synthetic',
    observerId: 'obs-test-1',
    workItemId: 'wi-123',
    attemptId: 'att-123',
    leaseId: 'lease-123',
    invocationHash: 'a'.repeat(64),
    cgroupId: 4242,
    cgroupPath: '/sys/fs/cgroup/user.slice/jc-test',
    startTimeNs: 1000,
    endTimeNs: 2000,
    status: 'complete',
    incompleteReasons: [],
    events: [
      {
        seq: 1,
        timestampNs: 1100,
        cgroupId: 4242,
        eventType: 'EXEC',
        pid: 101,
        tgid: 101,
        ppid: 100,
        childPid: 0,
        childTgid: 0,
        uid: 1000,
        gid: 1000,
        exitCode: 0,
        comm: 'printf',
      },
    ],
    processTree: [
      {
        pid: 101,
        tgid: 101,
        ppid: 100,
        comm: 'printf',
        uid: 1000,
        gid: 1000,
        forkedAtNs: 0,
        execedAtNs: 1100,
        exitedAtNs: 1900,
        exitCode: 0,
        children: [],
      },
    ],
    eventCounts: { total: 1, fork: 0, exec: 1, exit: 0 },
    droppedEvents: 0,
    sequenceGaps: 0,
    previousEvidenceHash: null,
    acsAnchorRef: null,
    signingKeyId: 'witness-key-1',
    ...overrides,
  });
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

try {
  await test('validates complete signed receipt and rejects tampering, bad sig, incomplete, correlation mismatch, and replay', async () => {
    const seen = new SeenReceiptStore(path.join(tmp, 'seen-1'));
    const expected = {
      workItemId: 'wi-123',
      attemptId: 'att-123',
      leaseId: 'lease-123',
      invocationHash: 'a'.repeat(64),
    };

    const valid = makeReceipt();
    const res1 = verifyKernelWitnessReceipt(valid, { publicKeyPem, expected, seenStore: seen });
    assert.equal(res1.valid, true, JSON.stringify(res1));
    assert.equal(res1.complete, true);
    assert.equal(res1.evidenceHash, valid.evidenceHash);

    // Replay of the exact same receipt must be rejected
    const replay = verifyKernelWitnessReceipt(valid, { publicKeyPem, expected, seenStore: seen });
    assert.equal(replay.valid, false);
    assert.ok(replay.reasons.includes('receipt_replayed'));

    // Tampered payload
    const tampered = { ...makeReceipt({ observerId: 'obs-test-2' }) };
    tampered.cgroupId = 9999;
    const resTamper = verifyKernelWitnessReceipt(tampered, { publicKeyPem, expected });
    assert.equal(resTamper.valid, false);
    assert.ok(resTamper.reasons.includes('evidence_hash_mismatch'));

    // Bad signature
    const badSig = { ...makeReceipt({ observerId: 'obs-test-3' }), signature: Buffer.alloc(64, 7).toString('base64') };
    const resSig = verifyKernelWitnessReceipt(badSig, { publicKeyPem, expected });
    assert.equal(resSig.valid, false);
    assert.ok(resSig.reasons.includes('signature_invalid'));

    // Incomplete observation (droppedEvents > 0 or status !== 'complete')
    const incomplete = makeReceipt({ status: 'incomplete', incompleteReasons: ['ringbuf_overflow'], droppedEvents: 2 });
    const resInc = verifyKernelWitnessReceipt(incomplete, { publicKeyPem, expected });
    assert.equal(resInc.valid, false);
    assert.equal(resInc.complete, false);
    assert.ok(resInc.reasons.includes('incomplete_observation'));

    // Correlation mismatch
    const wrongCorr = makeReceipt({ attemptId: 'att-other' });
    const resCorr = verifyKernelWitnessReceipt(wrongCorr, { publicKeyPem, expected });
    assert.equal(resCorr.valid, false);
    assert.ok(resCorr.reasons.some((r) => r.startsWith('correlation_mismatch')));
  });

  await test('processes.ts wraps bwrap with pre-exec witness binary and preserves --info-fd 3', async () => {
    const work = path.join(tmp, 'work');
    const stateDir = path.join(tmp, 'proc-state');
    const receiptDir = path.join(tmp, 'receipts');
    fs.mkdirSync(work, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(receiptDir, { recursive: true });

    const mockBin = path.join(tmp, 'mock-witness.mjs');
    const mockModeFile = path.join(tmp, 'mock-mode.txt');
    const keyFile = path.join(tmp, 'witness-priv.pem');
    fs.writeFileSync(keyFile, privateKeyPem, { mode: 0o600 });

    fs.writeFileSync(mockBin, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const opts = argv.slice(0, sep);
const cmd = argv.slice(sep + 1);
const getOpt = (flag) => {
  const idx = opts.indexOf(flag);
  return idx >= 0 ? opts[idx + 1] : undefined;
};
const receiptOut = getOpt('--receipt-out');
const signingKeyPath = getOpt('--signing-key');
const workItemId = getOpt('--work-item-id') ?? '';
const attemptId = getOpt('--attempt-id') ?? '';
const leaseId = getOpt('--lease-id') ?? '';
const invocationHash = getOpt('--invocation-hash') ?? '';
const previousEvidenceHash = getOpt('--previous-evidence-hash') ?? null;
const mockMode = fs.existsSync(${JSON.stringify(mockModeFile)}) ? fs.readFileSync(${JSON.stringify(mockModeFile)}, 'utf8').trim() : 'complete';

const child = spawnSync(cmd[0], cmd.slice(1), { stdio: [0, 1, 2, 3] });
const base = {
  schemaVersion: 'jc.kernel-witness.receipt.v1',
  observerVersion: '0.1.0',
  observerMode: 'synthetic',
  observerId: 'mock-witness',
  workItemId,
  attemptId,
  leaseId,
  invocationHash,
  cgroupId: 777,
  cgroupPath: '/sys/fs/cgroup/user.slice/mock',
  startTimeNs: 100,
  endTimeNs: 200,
  status: mockMode === 'incomplete' ? 'incomplete' : 'complete',
  incompleteReasons: mockMode === 'incomplete' ? ['ebpf_unavailable_missing_permissions'] : [],
  events: [],
  processTree: [],
  eventCounts: { total: 0, fork: 0, exec: 0, exit: 0 },
  droppedEvents: 0,
  sequenceGaps: 0,
  previousEvidenceHash,
  acsAnchorRef: null,
  signingKeyId: 'mock-key-1',
};
const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys) : (v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
const body = JSON.stringify(sortKeys(base));
const evidenceHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
const key = fs.readFileSync(signingKeyPath, 'utf8');
const signature = crypto.sign(null, Buffer.from(body, 'utf8'), key).toString('base64');
const receipt = { ...base, evidenceHash, signature };
if (mockMode === 'tamper') receipt.cgroupId = 888;
fs.writeFileSync(receiptOut, JSON.stringify(receipt), { mode: 0o600 });
process.exit(child.status ?? 1);
`, { mode: 0o755 });

    const policy = {
      roots: [work],
      deniedRoots: [],
      workload: {
        policy: sandboxPolicyFromEnv({ homeDir: tmp, stateDir, fsRoots: [work], fsDeniedRoots: [], managed: true }),
        homeDir: tmp,
        stateDir,
      },
    };
    const registry = createProcessRegistry();
    const witness = {
      enabled: true,
      required: true,
      mode: 'synthetic',
      binaryPath: mockBin,
      signingKeyPath: keyFile,
      publicKeyPem,
      signingKeyId: 'mock-key-1',
      receiptDir,
    };
    const context = {
      workItemId: 'wi-proc-1',
      attemptId: 'att-proc-1',
      leaseId: 'lease-proc-1',
      invocationHash: 'b'.repeat(64),
      witness,
    };
    const out = await registry.run({ command: 'printf WITNESS_OK', cwd: work, waitMs: 10_000 }, policy, 'alice', context);
    assert.equal(out.exitCode, 0);
    assert.equal(out.stdout, 'WITNESS_OK');
    assert.ok(out.witness, 'witness outcome attached');
    assert.equal(out.witness.verification.valid, true);
    assert.equal(out.witness.verification.complete, true);

    // Missing witness binary fails closed when required
    await assert.rejects(
      () => registry.run(
        { command: 'printf FAIL', cwd: work, waitMs: 5000 },
        policy,
        'alice',
        { ...context, witness: { ...witness, binaryPath: path.join(tmp, 'nonexistent-witness') } },
      ),
      (err) => err.code === 'JC_WITNESS_UNAVAILABLE',
    );
  });

  await test('server.ts emits witness LoopTrace events, submits receipt to ACS, and fails closed on incomplete/tampered', async () => {
    const srvTmp = path.join(tmp, 'srv');
    const srvWork = path.join(srvTmp, 'work');
    const srvState = path.join(srvTmp, 'state');
    fs.mkdirSync(srvWork, { recursive: true });
    const issuer = makeIssuer();
    const mockBin = path.join(tmp, 'mock-witness.mjs');
    const keyFile = path.join(tmp, 'witness-priv.pem');

    const submittedReceipts = [];
    const config = loadJcConfig({
      JC_ACS_AUTHORITY_TOKEN: 'test-authority-read-token',
      HOME: srvTmp,
      JC_STATE_DIR: srvState,
      JC_FS_ROOTS: srvWork,
      JC_RUNTIME_ID: 'jc-test-runtime',
      JC_ACS_PUBLIC_KEY: issuer.publicKeyB64,
      JC_ACS_KEY_ID: issuer.keyId,
      JC_ACS_URL: 'http://127.0.0.1:3999',
      JC_GATEWAY_META_TRUSTED: '1',
      JC_WITNESS_ENABLED: '1',
      JC_WITNESS_REQUIRED: '1',
      JC_WITNESS_MODE: 'synthetic',
      JC_WITNESS_BIN: mockBin,
      JC_WITNESS_SIGNING_KEY: keyFile,
      JC_WITNESS_PUBLIC_KEY_PEM: publicKeyPem,
    });

    const server = createJcServer(config, 'managed', {
      helperAvailable: async () => false,
      invokeHelper: async () => ({ ok: true }),
      fetchImpl: async (url, init = {}) => {
        if (String(url).endsWith('/black-box/kernel-witness/receipts')) {
          submittedReceipts.push({
            url: String(url),
            auth: init.headers?.authorization,
            body: JSON.parse(String(init.body)),
          });
          return new Response(JSON.stringify({
            status: 'created',
            observed: true,
            trustLevel: 'independently_verified',
            eventId: 'ev-1',
            evidenceHash: 'c'.repeat(64),
            anchor: { auditEventId: 1, auditEventHash: 'd'.repeat(64) },
          }), { status: 201, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify(authorityBody(issuer)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 'witness-srv-test', version: '1' });
    await client.connect(b);

    try {
      const args = { command: 'printf SRV_OK', cwd: srvWork, waitMs: 10_000 };
      const cap = issuer.mint('run_command', args, { workItemId: 'wi-srv-1', attemptId: 'att-srv-1', leaseId: 'lease-srv-1' });
      const res = await client.callTool({
        name: 'run_command',
        arguments: args,
        _meta: { gateway: { sub: 'alice', client_id: 'c1' }, acsCapability: cap },
      });
      assert.equal(res.isError, undefined, JSON.stringify(res));
      assert.equal(submittedReceipts.length, 1);
      assert.equal(submittedReceipts[0].body.receipt.workItemId, 'wi-srv-1');
      assert.equal(submittedReceipts[0].auth, 'Bearer test-authority-read-token');

      const traceDir = path.join(srvState, 'traces');
      const files = fs.readdirSync(traceDir).filter((f) => f.endsWith('.jsonl'));
      const events = readTraceFile(path.join(traceDir, files[0])).events;
      assert.equal(verifyChain(events).ok, true);
      const witnessEv = events.find((e) => e.type === 'witness_observation_recorded');
      assert.ok(witnessEv, 'witness_observation_recorded emitted');
      assert.equal(witnessEv.payload.workItemId, 'wi-srv-1');
      assert.equal(witnessEv.payload.attemptId, 'att-srv-1');
      assert.equal(witnessEv.payload.leaseId, 'lease-srv-1');
      assert.equal(witnessEv.payload.invocationHash, cap.payload.invocationHash);

      // Incomplete observation fails closed when required
      const mockModeFile = path.join(tmp, 'mock-mode.txt');
      fs.writeFileSync(mockModeFile, 'incomplete');
      const argsInc = { command: 'printf INC', cwd: srvWork, waitMs: 10_000 };
      const resInc = await client.callTool({
        name: 'run_command',
        arguments: argsInc,
        _meta: { gateway: { sub: 'alice', client_id: 'c1' }, acsCapability: issuer.mint('run_command', argsInc) },
      });
      fs.rmSync(mockModeFile, { force: true });
      assert.equal(resInc.isError, true);
      assert.equal(resInc.structuredContent.error.code, 'JC_WITNESS_INCOMPLETE');
      const eventsAfterInc = readTraceFile(path.join(traceDir, files[0])).events;
      assert.ok(eventsAfterInc.some((e) => e.type === 'witness_observation_incomplete'));

      // Tampered receipt fails closed
      fs.writeFileSync(mockModeFile, 'tamper');
      const argsTamper = { command: 'printf TAMPER', cwd: srvWork, waitMs: 10_000 };
      const resTamper = await client.callTool({
        name: 'run_command',
        arguments: argsTamper,
        _meta: { gateway: { sub: 'alice', client_id: 'c1' }, acsCapability: issuer.mint('run_command', argsTamper) },
      });
      fs.rmSync(mockModeFile, { force: true });
      assert.equal(resTamper.isError, true);
      assert.equal(resTamper.structuredContent.error.code, 'JC_WITNESS_VERIFICATION_FAILED');
    } finally {
      await client.close();
    }
  });

  await test('real jc-kernel-witness binary (if built) integrates with processes.ts + bwrap in auto mode without attaching live eBPF', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const nativeBin = path.resolve(here, '..', 'native', 'kernel-witness', 'build', 'jc-kernel-witness');
    if (!fs.existsSync(nativeBin)) {
      console.log('    (skipped: native jc-kernel-witness not built)');
      return;
    }
    const nativeDir = path.join(tmp, 'native-int');
    const nativeWork = path.join(nativeDir, 'work');
    const nativeState = path.join(nativeDir, 'state');
    const nativeReceipts = path.join(nativeDir, 'receipts');
    fs.mkdirSync(nativeWork, { recursive: true });
    fs.mkdirSync(nativeState, { recursive: true });
    fs.mkdirSync(nativeReceipts, { recursive: true });

    const privPath = path.join(nativeDir, 'priv.pem');
    const pubPath = path.join(nativeDir, 'pub.pem');
    const kg = spawnSync(nativeBin, ['keygen', '--private-out', privPath, '--public-out', pubPath], { encoding: 'utf8' });
    assert.equal(kg.status, 0, kg.stderr);

    const policy = {
      roots: [nativeWork],
      deniedRoots: [],
      workload: {
        policy: sandboxPolicyFromEnv({ homeDir: nativeDir, stateDir: nativeState, fsRoots: [nativeWork], fsDeniedRoots: [], managed: true }),
        homeDir: nativeDir,
        stateDir: nativeState,
      },
    };
    const registry = createProcessRegistry();
    const out = await registry.run(
      { command: 'printf REAL_CGROUP_OK', cwd: nativeWork, waitMs: 10_000 },
      policy,
      'alice',
      {
        workItemId: 'wi-real-1',
        attemptId: 'att-real-1',
        leaseId: 'lease-real-1',
        invocationHash: 'e'.repeat(64),
        witness: {
          enabled: true,
          required: true,
          mode: 'auto',
          binaryPath: nativeBin,
          signingKeyPath: privPath,
          publicKeyPath: pubPath,
          receiptDir: nativeReceipts,
        },
      },
    );
    assert.equal(out.exitCode, 0);
    assert.equal(out.stdout, 'REAL_CGROUP_OK');
    assert.ok(out.witness?.receipt, 'real jc-kernel-witness emitted receipt');
    assert.equal(out.witness.receipt.workItemId, 'wi-real-1');
    assert.equal(out.witness.receipt.attemptId, 'att-real-1');
    assert.equal(out.witness.receipt.leaseId, 'lease-real-1');
    assert.equal(out.witness.receipt.invocationHash, 'e'.repeat(64));
    assert.ok(out.witness.receipt.cgroupId > 0, 'real cgroup v2 ID recorded');
    // In unprivileged auto mode without live eBPF, signature & hash are valid,
    // status is incomplete, and verification fails closed (complete: false, valid: false).
    assert.equal(out.witness.verification.complete, false);
    assert.equal(out.witness.verification.valid, false);
    assert.ok(out.witness.verification.reasons.includes('incomplete_observation'));
    assert.ok(!out.witness.verification.reasons.includes('signature_invalid'));
    assert.ok(!out.witness.verification.reasons.includes('evidence_hash_mismatch'));
  });

  console.log(`\njace-commander kernel-witness: ${passed} passed`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
