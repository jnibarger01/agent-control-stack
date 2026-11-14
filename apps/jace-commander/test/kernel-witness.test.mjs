#!/usr/bin/env node
/**
 * TDD regression tests for JC Kernel Witness integration (v1 & v2):
 * - v1 and v2 receipt Ed25519 signature, domain-separated canonical hash, category digests,
 *   completeness, scope coverage, correlation, live-mode enforcement, and replay protection
 * - Signer socket (`--signer-socket`) and `--acs-anchor-ref` wiring; raw key forbidden in live/managed mode
 * - Sandbox masking of signer sockets, signing keys, and receipt dirs even inside JC_FS_ROOTS
 * - Pre-exec witness wrapping in processes.ts (preserving bwrap --info-fd 3)
 * - Fail-closed behavior on missing witness, incomplete observation, tampered/replayed receipt
 * - Single-emission LoopTrace witness events + ACS POST on process close (async start_process
 *   and repeated read_process_output) + persistent locked WitnessChainStateStore
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
  WitnessChainStateStore,
  assertSigningKeyCustody,
  assertWitnessBinaryReady,
  buildWitnessRunArgv,
  canonicalWitnessBody,
  computeV2CategoryDigest,
  verifyKernelWitnessReceipt,
} from '../dist/kernel-witness.js';
import { createProcessRegistry } from '../dist/processes.js';
import { sandboxArgv, sandboxPolicyFromEnv } from '../dist/sandbox.js';
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
  if (base.schemaVersion === 'jc.kernel-witness.receipt.v2') {
    const evidenceHash = crypto
      .createHash('sha256')
      .update(`jc.kernel-witness.receipt.v2:${body}`, 'utf8')
      .digest('hex');
    const signature = crypto
      .sign(null, Buffer.from(`jc.kernel-witness.sig.v2:${evidenceHash}:${body}`, 'utf8'), privateKey)
      .toString('base64');
    return { ...base, evidenceHash, signature };
  }
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
    rootPid: 101,
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
    acsAnchorRef: 'wi-123',
    signingKeyId: 'witness-key-1',
    ...overrides,
  });
}

function makeReceiptV2(overrides = {}) {
  const processTree = overrides.processTree ?? [
    {
      pid: 101,
      tgid: 101,
      ppid: 100,
      comm: 'sh',
      uid: 1000,
      gid: 1000,
      forkedAtNs: 1000,
      execedAtNs: 1100,
      exitedAtNs: 1900,
      exitCode: 0,
      children: [],
    },
  ];
  const filesystemEvents = overrides.filesystemEvents ?? [
    {
      seq: 2,
      timestampNs: 1200,
      cgroupId: 4242,
      pid: 101,
      tgid: 101,
      comm: 'sh',
      uid: 1000,
      gid: 1000,
      op: 'CREATE',
      phase: 'completed',
      succeeded: true,
      resultErrno: 0,
      bytes: 12,
      flags: 65,
      dev: 2049,
      inode: 99911,
      mountId: 28,
      pathDigest: 'hmac-sha256:' + '1'.repeat(64),
      pathDigestKeyId: 'pathkey:0123456789abcdef',
      displayPath: null,
      targetPathDigest: null,
      targetDisplayPath: null,
      targetInode: 0,
    },
  ];
  const networkEvents = overrides.networkEvents ?? [
    {
      seq: 3,
      timestampNs: 1300,
      cgroupId: 4242,
      pid: 101,
      tgid: 101,
      comm: 'sh',
      sockCookie: 5001,
      af: 'INET',
      proto: 'TCP',
      op: 'CONNECT',
      phase: 'completed',
      stateTransition: 'TCP_SYN_SENT->TCP_ESTABLISHED',
      outcome: 'connected',
      errnoVal: 0,
      remoteAddrDigest: 'hmac-sha256:' + '2'.repeat(64),
      displayRemoteAddr: null,
      remotePort: 443,
      localPort: 51234,
      bytes: 0,
    },
  ];
  const base = {
    schemaVersion: 'jc.kernel-witness.receipt.v2',
    observerVersion: '0.2.0',
    observerMode: 'live',
    observerId: 'obs-test-v2',
    workItemId: 'wi-123',
    attemptId: 'att-123',
    leaseId: 'lease-123',
    invocationHash: 'a'.repeat(64),
    cgroupId: 4242,
    cgroupPath: '/sys/fs/cgroup/user.slice/jc-test',
    rootPid: 101,
    startTimeNs: 1000,
    endTimeNs: 2000,
    signedAtUtc: '2026-11-13T23:59:00.000Z',
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
        comm: 'sh',
      },
    ],
    processTree,
    filesystemEvents,
    networkEvents,
    eventCounts: { total: 3, fork: 0, exec: 1, exit: 0, filesystem: 1, network: 1 },
    observationScope: {
      policyRequired: ['process', 'filesystem', 'network'],
      requested: ['process', 'filesystem', 'network'],
      active: ['process', 'filesystem', 'network'],
    },
    categoryCompleteness: {
      process: {
        category: 'process',
        enabled: true,
        status: 'complete',
        eventCount: 1,
        droppedEvents: 0,
        sequenceGaps: 0,
        firstSeq: 1,
        lastSeq: 1,
        categoryDigestSha256: computeV2CategoryDigest('process', processTree),
        incompleteReasons: [],
        unsupportedOperations: [],
      },
      filesystem: {
        category: 'filesystem',
        enabled: true,
        status: 'complete',
        eventCount: 1,
        droppedEvents: 0,
        sequenceGaps: 0,
        firstSeq: 2,
        lastSeq: 2,
        categoryDigestSha256: computeV2CategoryDigest('filesystem', filesystemEvents),
        incompleteReasons: [],
        unsupportedOperations: [],
      },
      network: {
        category: 'network',
        enabled: true,
        status: 'complete',
        eventCount: 1,
        droppedEvents: 0,
        sequenceGaps: 0,
        firstSeq: 3,
        lastSeq: 3,
        categoryDigestSha256: computeV2CategoryDigest('network', networkEvents),
        incompleteReasons: [],
        unsupportedOperations: [],
      },
    },
    droppedEvents: 0,
    sequenceGaps: 0,
    previousEvidenceHash: null,
    acsAnchorRef: 'wi-123',
    signingKeyId: 'witness-key-1',
    ...overrides,
  };
  return signReceipt(base);
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

try {
  await test('validates complete signed v1 & v2 receipts and rejects tampering, bad sig, incomplete, non-live mode, category digest mismatch, and replay', async () => {
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

    // [P0-05] requireLiveMode rejects synthetic/replay receipts
    const resNotLive = verifyKernelWitnessReceipt(valid, { publicKeyPem, expected, requireLiveMode: true });
    assert.equal(resNotLive.valid, false);
    assert.ok(resNotLive.reasons.includes('observer_mode_not_live'));

    // v2 receipt verification with domain-separated hash/signature and category digests
    const validV2 = makeReceiptV2();
    const resV2 = verifyKernelWitnessReceipt(validV2, { publicKeyPem, expected, requireLiveMode: true });
    assert.equal(resV2.valid, true, JSON.stringify(resV2));
    assert.equal(resV2.complete, true);

    // v2 category digest mismatch
    const badFsDigestV2 = makeReceiptV2({
      categoryCompleteness: {
        ...validV2.categoryCompleteness,
        filesystem: {
          ...validV2.categoryCompleteness.filesystem,
          categoryDigestSha256: 'f'.repeat(64),
        },
      },
    });
    const resBadDigest = verifyKernelWitnessReceipt(badFsDigestV2, { publicKeyPem, expected });
    assert.equal(resBadDigest.valid, false);
    assert.ok(resBadDigest.reasons.includes('category_digest_mismatch:filesystem'));
  });

  await test('processes.ts wraps bwrap with pre-exec witness binary, passes --signer-socket and --acs-anchor-ref, and preserves --info-fd 3', async () => {
    const work = path.join(tmp, 'work');
    const stateDir = path.join(tmp, 'proc-state');
    const receiptDir = path.join(tmp, 'receipts');
    const signerSock = path.join(tmp, 'signer.sock');
    fs.mkdirSync(work, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(receiptDir, { recursive: true });

    const mockBin = path.join(tmp, 'mock-witness.mjs');
    const mockModeFile = path.join(tmp, 'mock-mode.txt');
    const keyFile = path.join(tmp, 'witness-priv.pem');
    fs.writeFileSync(keyFile, privateKeyPem, { mode: 0o600 });
    fs.writeFileSync(signerSock, keyFile, { mode: 0o600 });

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
const signerSocketPath = getOpt('--signer-socket');
const workItemId = getOpt('--work-item-id') ?? '';
const attemptId = getOpt('--attempt-id') ?? '';
const leaseId = getOpt('--lease-id') ?? '';
const invocationHash = getOpt('--invocation-hash') ?? '';
const acsAnchorRef = getOpt('--acs-anchor-ref') ?? null;
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
  acsAnchorRef,
  signingKeyId: 'mock-key-1',
};
const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys) : (v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
const body = JSON.stringify(sortKeys(base));
const evidenceHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
const resolvedKeyFile = signerSocketPath ? fs.readFileSync(signerSocketPath, 'utf8').trim() : signingKeyPath;
const key = fs.readFileSync(resolvedKeyFile, 'utf8');
const signature = crypto.sign(null, Buffer.from(body, 'utf8'), key).toString('base64');
const receipt = { ...base, evidenceHash, signature };
if (mockMode === 'tamper') receipt.cgroupId = 888;
fs.writeFileSync(receiptOut, JSON.stringify(receipt), { mode: 0o600 });
process.exit(child.status ?? 1);
`, { mode: 0o755 });

    // Check buildWitnessRunArgv passes --signer-socket and --acs-anchor-ref
    const builtArgv = buildWitnessRunArgv(
      {
        enabled: true,
        required: true,
        mode: 'live',
        binaryPath: mockBin,
        signerSocketPath: signerSock,
        receiptDir,
      },
      {
        receiptOutPath: '/tmp/out.json',
        workItemId: 'wi-anchor-1',
        attemptId: 'att-1',
        leaseId: 'lease-1',
        invocationHash: 'b'.repeat(64),
      },
      ['/usr/bin/bwrap', '--', '/bin/true'],
    );
    assert.ok(builtArgv.includes('--signer-socket'));
    assert.equal(builtArgv[builtArgv.indexOf('--signer-socket') + 1], signerSock);
    assert.ok(builtArgv.includes('--acs-anchor-ref'));
    assert.equal(builtArgv[builtArgv.indexOf('--acs-anchor-ref') + 1], 'wi-anchor-1');

    // [P0-01] Raw signingKeyPath is forbidden in live mode or managed mode
    assert.throws(
      () => assertWitnessBinaryReady({
        enabled: true,
        required: true,
        mode: 'live',
        binaryPath: mockBin,
        signingKeyPath: keyFile,
        receiptDir,
      }),
      (err) => err.code === 'JC_WITNESS_KEY_CUSTODY_INVALID',
    );
    assert.throws(
      () => assertWitnessBinaryReady(
        {
          enabled: true,
          required: true,
          mode: 'synthetic',
          binaryPath: mockBin,
          signingKeyPath: keyFile,
          receiptDir,
        },
        { managed: true },
      ),
      (err) => err.code === 'JC_WITNESS_KEY_CUSTODY_INVALID',
    );

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
      signerSocketPath: signerSock,
      publicKeyPem,
      signingKeyId: 'mock-key-1',
      receiptDir,
    };
    const context = {
      workItemId: 'wi-proc-1',
      attemptId: 'att-proc-1',
      leaseId: 'lease-proc-1',
      invocationHash: 'b'.repeat(64),
      managed: true,
      witness,
    };
    const out = await registry.run({ command: 'printf WITNESS_OK', cwd: work, waitMs: 10_000 }, policy, 'alice', context);
    assert.equal(out.exitCode, 0);
    assert.equal(out.stdout, 'WITNESS_OK');
    assert.ok(out.witness, 'witness outcome attached');
    assert.equal(out.witness.verification.valid, true);
    assert.equal(out.witness.verification.complete, true);
    assert.equal(out.witness.receipt.acsAnchorRef, 'wi-proc-1');

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

  await test('server.ts emits witness LoopTrace events once on close (including async start_process and repeated read_process_output), persists chain head, submits receipt to ACS, and fails closed on incomplete/tampered', async () => {
    const srvTmp = path.join(tmp, 'srv');
    const srvWork = path.join(srvTmp, 'work');
    const srvState = path.join(srvTmp, 'state');
    fs.mkdirSync(srvWork, { recursive: true });
    const issuer = makeIssuer();
    const mockBin = path.join(tmp, 'mock-witness.mjs');
    const signerSock = path.join(tmp, 'signer.sock');

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
      JC_WITNESS_SIGNER_SOCKET: signerSock,
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
      assert.equal(submittedReceipts[0].body.receipt.acsAnchorRef, 'wi-srv-1');
      assert.equal(submittedReceipts[0].auth, 'Bearer test-authority-read-token');

      // Verify persistent chain head store was updated
      const chainStore = new WitnessChainStateStore(srvState);
      assert.equal(chainStore.getHeadHash(), submittedReceipts[0].body.receipt.evidenceHash);

      // [P1-06] Async start_process + repeated read_process_output emits witness LoopTrace and ACS POST exactly once!
      const startArgs = { argv: ['/usr/bin/printf', 'ASYNC_OK'], cwd: srvWork };
      const startCap = issuer.mint('start_process', startArgs, { workItemId: 'wi-srv-2', attemptId: 'att-srv-2', leaseId: 'lease-srv-2' });
      const startRes = await client.callTool({
        name: 'start_process',
        arguments: startArgs,
        _meta: { gateway: { sub: 'alice', client_id: 'c1' }, acsCapability: startCap },
      });
      assert.equal(startRes.isError, undefined, JSON.stringify(startRes));
      const sessionId = startRes.structuredContent.sessionId;
      let readRes1;
      for (let i = 0; i < 50; i += 1) {
        const pollArgs = { sessionId, waitMs: 200 };
        readRes1 = await client.callTool({
          name: 'read_process_output',
          arguments: pollArgs,
          _meta: { gateway: { sub: 'alice', client_id: 'c1' }, acsCapability: issuer.mint('read_process_output', pollArgs) },
        });
        assert.equal(readRes1.isError, undefined, JSON.stringify(readRes1));
        if (!readRes1.structuredContent.running) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(readRes1.structuredContent.running, false);
      const readArgs = { sessionId, waitMs: 500 };
      const readRes2 = await client.callTool({
        name: 'read_process_output',
        arguments: readArgs,
        _meta: { gateway: { sub: 'alice', client_id: 'c1' }, acsCapability: issuer.mint('read_process_output', readArgs) },
      });
      assert.equal(readRes2.isError, undefined, JSON.stringify(readRes2));
      const readRes3 = await client.callTool({
        name: 'read_process_output',
        arguments: readArgs,
        _meta: { gateway: { sub: 'alice', client_id: 'c1' }, acsCapability: issuer.mint('read_process_output', readArgs) },
      });
      assert.equal(readRes3.isError, undefined, JSON.stringify(readRes3));
      // Only 2 total receipts submitted (1 from run_command, 1 from start_process — NOT duplicated by read_process_output!)
      assert.equal(submittedReceipts.length, 2);
      assert.equal(submittedReceipts[1].body.receipt.previousEvidenceHash, submittedReceipts[0].body.receipt.evidenceHash);

      const traceDir = path.join(srvState, 'traces');
      const files = fs.readdirSync(traceDir).filter((f) => f.endsWith('.jsonl'));
      const events = readTraceFile(path.join(traceDir, files[0])).events;
      assert.equal(verifyChain(events).ok, true);
      const witnessEvents = events.filter((e) => e.type === 'witness_observation_recorded');
      assert.equal(witnessEvents.length, 2, 'exactly 2 witness_observation_recorded events emitted');
      assert.equal(witnessEvents[0].payload.workItemId, 'wi-srv-1');
      assert.equal(witnessEvents[0].payload.attemptId, 'att-srv-1');
      assert.equal(witnessEvents[0].payload.leaseId, 'lease-srv-1');
      assert.equal(witnessEvents[0].payload.invocationHash, cap.payload.invocationHash);

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

  await test('sandbox.ts masks witness signer socket, signing key, and receipt dirs even when inside JC_FS_ROOTS', async () => {
    const sbRoot = path.join(tmp, 'sb-root');
    const sbState = path.join(sbRoot, 'state');
    const sbReceipts = path.join(sbRoot, 'witness-receipts');
    const sbSockDir = path.join(sbRoot, 'signer-dir');
    const sbSock = path.join(sbSockDir, 'sign.sock');
    const sbKey = path.join(sbRoot, 'priv.pem');
    fs.mkdirSync(sbState, { recursive: true });
    fs.mkdirSync(sbReceipts, { recursive: true });
    fs.mkdirSync(sbSockDir, { recursive: true });
    fs.writeFileSync(sbSock, 'sock', { mode: 0o600 });
    fs.writeFileSync(sbKey, 'key', { mode: 0o600 });

    const policy = sandboxPolicyFromEnv({
      homeDir: tmp,
      stateDir: sbState,
      fsRoots: [sbRoot],
      fsDeniedRoots: [],
      managed: true,
      witness: {
        signingKeyPath: sbKey,
        signerSocketPath: sbSock,
        receiptDir: sbReceipts,
      },
    });
    const argv = sandboxArgv(policy, ['/bin/true'], sbRoot);
    assert.ok(argv.includes(fs.realpathSync(sbReceipts)));
    assert.ok(argv.includes(fs.realpathSync(sbSockDir)));
    assert.ok(argv.includes(fs.realpathSync(sbKey)));
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
    fs.chmodSync(privPath, 0o600);

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

  await test('enforces signing-key custody (0600, non-symlink) and supports observerId/signingKeyId key rotation', async () => {
    const goodKey = path.join(tmp, 'custody-good.pem');
    fs.writeFileSync(goodKey, privateKeyPem, { mode: 0o600 });
    assertSigningKeyCustody(goodKey);

    const badPermKey = path.join(tmp, 'custody-bad-perm.pem');
    fs.writeFileSync(badPermKey, privateKeyPem, { mode: 0o644 });
    assert.throws(() => assertSigningKeyCustody(badPermKey), (err) => err.code === 'JC_WITNESS_KEY_CUSTODY_INVALID');

    const linkKey = path.join(tmp, 'custody-link.pem');
    fs.symlinkSync(goodKey, linkKey);
    assert.throws(() => assertSigningKeyCustody(linkKey), (err) => err.code === 'JC_WITNESS_KEY_CUSTODY_INVALID');

    // Key rotation: verifyKernelWitnessReceipt resolves key by receipt.signingKeyId via publicKeysByKeyId
    const kp2 = crypto.generateKeyPairSync('ed25519');
    const pub2Pem = kp2.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const priv2Pem = kp2.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const baseRotated = {
      ...makeReceipt({ observerId: 'obs-rot-1', signingKeyId: 'witness-key-2' }),
    };
    delete baseRotated.evidenceHash;
    delete baseRotated.signature;
    const bodyRot = canonicalWitnessBody(baseRotated);
    const rotatedReceipt = {
      ...baseRotated,
      evidenceHash: crypto.createHash('sha256').update(bodyRot, 'utf8').digest('hex'),
      signature: crypto.sign(null, Buffer.from(bodyRot, 'utf8'), priv2Pem).toString('base64'),
    };
    const resRot = verifyKernelWitnessReceipt(rotatedReceipt, {
      publicKeysByKeyId: { 'witness-key-1': publicKeyPem, 'witness-key-2': pub2Pem },
      expected: { observerId: 'obs-rot-1', signingKeyId: 'witness-key-2' },
    });
    assert.equal(resRot.valid, true, JSON.stringify(resRot));

    const resWrongObs = verifyKernelWitnessReceipt(rotatedReceipt, {
      publicKeysByKeyId: { 'witness-key-2': pub2Pem },
      expected: { observerId: 'obs-other' },
    });
    assert.equal(resWrongObs.valid, false);
    assert.ok(resWrongObs.reasons.includes('correlation_mismatch:observerId'));

    // rootPid verification: matching rootPid passes, missing from processTree or mismatched rootPid fails
    const withRoot = makeReceipt({ rootPid: 101 });
    assert.equal(verifyKernelWitnessReceipt(withRoot, { publicKeyPem, expected: { rootPid: 101 } }).valid, true);
    const badRoot = makeReceipt({ rootPid: 999 });
    const resBadRoot = verifyKernelWitnessReceipt(badRoot, { publicKeyPem, expected: { rootPid: 999 } });
    assert.equal(resBadRoot.valid, false);
    assert.ok(resBadRoot.reasons.includes('root_pid_missing_from_tree'));
    const resMismatchRoot = verifyKernelWitnessReceipt(withRoot, { publicKeyPem, expected: { rootPid: 202 } });
    assert.equal(resMismatchRoot.valid, false);
    assert.ok(resMismatchRoot.reasons.includes('correlation_mismatch:rootPid'));
  });

  await test('ops/jc-kernel-witness scripts support --dry-run, staged prefix install, upgrade, rollback, retention, and uninstall', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const opsDir = path.resolve(here, '..', '..', '..', 'ops', 'jc-kernel-witness');
    const stagePrefix = path.join(tmp, 'ops-stage');

    const dry = spawnSync(path.join(opsDir, 'install-kernel-witness.sh'), ['--dry-run'], { encoding: 'utf8' });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /\[DRY-RUN\]/);

    const inst = spawnSync(
      path.join(opsDir, 'install-kernel-witness.sh'),
      ['--prefix', stagePrefix, '--skip-useradd', '--skip-systemd'],
      { encoding: 'utf8' },
    );
    assert.equal(inst.status, 0, inst.stderr);
    assert.ok(fs.existsSync(path.join(stagePrefix, 'usr/lib/jace-commander/jc-kernel-witness')));
    assert.ok(fs.existsSync(path.join(stagePrefix, 'usr/lib/jace-commander/witness.bpf.o')));
    assert.ok(fs.existsSync(path.join(stagePrefix, 'etc/jace-commander/witness-manifest.sha256')));
    assert.ok(fs.existsSync(path.join(stagePrefix, 'etc/jace-commander/observer.pub.pem')));
    assert.ok(fs.existsSync(path.join(stagePrefix, 'etc/acs-secrets/witness-path-hmac.key')));

    const upg = spawnSync(path.join(opsDir, 'upgrade-kernel-witness.sh'), ['--prefix', stagePrefix], { encoding: 'utf8' });
    assert.equal(upg.status, 0, upg.stderr);
    assert.ok(fs.existsSync(path.join(stagePrefix, 'usr/lib/jace-commander/jc-kernel-witness.prev')));

    const rb = spawnSync(path.join(opsDir, 'rollback-kernel-witness.sh'), ['--prefix', stagePrefix], { encoding: 'utf8' });
    assert.equal(rb.status, 0, rb.stderr);

    const ret = spawnSync(
      path.join(opsDir, 'retention-policy.sh'),
      [
        '--dry-run',
        '--worm-dir',
        path.join(stagePrefix, 'var/lib/acs-core/worm-vault'),
        '--receipt-scratch-dir',
        path.join(stagePrefix, 'var/lib/acs-jc/witness-receipts'),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(ret.status, 0, ret.stderr);

    const uninst = spawnSync(path.join(opsDir, 'uninstall-kernel-witness.sh'), ['--prefix', stagePrefix], { encoding: 'utf8' });
    assert.equal(uninst.status, 0, uninst.stderr);
    assert.ok(!fs.existsSync(path.join(stagePrefix, 'usr/lib/jace-commander/jc-kernel-witness')));
    assert.ok(fs.existsSync(path.join(stagePrefix, 'var/lib/acs-core/acs.sqlite')), 'durable DB preserved on default uninstall');
  });

  console.log(`\njace-commander kernel-witness: ${passed} passed`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
