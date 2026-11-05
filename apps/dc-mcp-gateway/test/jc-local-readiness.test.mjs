/**
 * Local-preset readiness: /ready must mean the pinned release's policy loads
 * and bubblewrap works for the executor, not merely that a listener or child
 * process exists. Managed readiness keeps its ACS rules.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { jcBridgeReady, jcServiceNotReadyReasons } from '../readiness.js';
import { localReadinessInvocation } from '../local-readiness.js';

const readyLocal = () => ({
  variant: 'jc',
  configuredExecutionMode: 'unmanaged_gateway',
  childMode: 'local',
  bridge: { hasUpstreamPair: true, upstreamStarted: true, initialized: true },
  runtime: {
    releaseRequired: true,
    installedRelease: { realDir: '/opt/jace-commander/1.0.0', readOnly: true },
  },
  enforcement: { executionTokenConfigured: true },
  local: {
    preset: 'local',
    uidDrop: { required: true, configured: true, sameUidAllowed: false },
    readiness: {
      status: 'ok',
      ok: true,
      policy: { state: 'loaded', ok: true, immutable: true },
      sandbox: { ok: true, isolation: 'bwrap', network: 'none', detail: 'bubblewrap namespaces verified' },
      detail: 'bubblewrap namespaces verified',
    },
  },
  authoritative: true,
});

test('a local lane is ready only when the pinned release, uid drop, policy and sandbox all hold', () => {
  const authority = readyLocal();
  assert.deepEqual(jcServiceNotReadyReasons(authority), []);
  assert.equal(jcBridgeReady(authority), true);
});

test('local readiness does not require managed ACS authority material', () => {
  const authority = readyLocal();
  authority.enforcement = { executionTokenConfigured: true, capabilityVerificationConfigured: false, currentAuthorityCredentialConfigured: false };
  assert.deepEqual(jcServiceNotReadyReasons(authority), []);
  assert.equal(jcBridgeReady(authority), true);
});

test('local readiness fails closed while the probe is pending or failed', () => {
  const pending = readyLocal();
  pending.local.readiness = { status: 'pending', ok: false, detail: 'not run' };
  assert.match(jcServiceNotReadyReasons(pending).join(' '), /probe has not completed/);
  assert.equal(jcBridgeReady(pending), false);

  const failed = readyLocal();
  failed.local.readiness = {
    status: 'failed',
    ok: false,
    detail: 'sandbox self-test failed (cannot plant state canary)',
    policy: { state: 'loaded', ok: true },
    sandbox: { ok: false, detail: 'sandbox self-test failed' },
  };
  assert.match(jcServiceNotReadyReasons(failed).join(' '), /local readiness probe failed: sandbox self-test failed/);
  assert.equal(jcBridgeReady(failed), false);
});

test('local readiness reports unusable policy and unavailable sandbox explicitly', () => {
  const badPolicy = readyLocal();
  badPolicy.local.readiness = {
    status: 'ok',
    ok: true,
    policy: { state: 'invalid', ok: false },
    sandbox: { ok: true, detail: 'ok' },
  };
  assert.match(jcServiceNotReadyReasons(badPolicy).join(' '), /local policy is not usable \(invalid\)/);
  assert.equal(jcBridgeReady(badPolicy), false);

  const badSandbox = readyLocal();
  badSandbox.local.readiness = {
    status: 'ok',
    ok: true,
    policy: { state: 'loaded', ok: true },
    sandbox: { ok: false, detail: 'bubblewrap not found' },
  };
  assert.match(jcServiceNotReadyReasons(badSandbox).join(' '), /workload sandbox is unavailable \(bubblewrap not found\)/);
  assert.equal(jcBridgeReady(badSandbox), false);
});

test('an unpinned, writable or same-uid local lane is never ready', () => {
  const unpinned = readyLocal();
  unpinned.runtime.releaseRequired = false;
  assert.match(jcServiceNotReadyReasons(unpinned).join(' '), /pinned installed release is not required/);

  const writable = readyLocal();
  writable.runtime.installedRelease.readOnly = false;
  assert.match(jcServiceNotReadyReasons(writable).join(' '), /not a read-only installed release/);

  const sameUid = readyLocal();
  sameUid.local.uidDrop.configured = false;
  assert.match(jcServiceNotReadyReasons(sameUid).join(' '), /uid drop .* is not configured/);
  assert.equal(jcBridgeReady(sameUid), false);
});

test('the local edge predicate additionally requires an initialized child', () => {
  const authority = readyLocal();
  authority.authoritative = false;
  authority.bridge.initialized = false;
  assert.equal(jcServiceNotReadyReasons(authority).length, 0, 'the bridge own /ready need not be initialized');
  assert.equal(jcBridgeReady(authority), false);
});

test('managed readiness is unchanged: local assertions cannot satisfy it', () => {
  const managed = {
    variant: 'jc',
    configuredExecutionMode: 'managed',
    childMode: 'managed',
    bridge: { hasUpstreamPair: true, upstreamStarted: true, initialized: true },
    enforcement: {
      executionTokenConfigured: true,
      capabilityVerificationConfigured: true,
      currentAuthorityCredentialConfigured: false,
    },
    authoritative: true,
  };
  assert.match(jcServiceNotReadyReasons(managed).join(' '), /JC_ACS_AUTHORITY_TOKEN_FILE/);
  assert.equal(jcBridgeReady(managed), false);
  managed.enforcement.currentAuthorityCredentialConfigured = true;
  assert.deepEqual(jcServiceNotReadyReasons(managed), []);
  assert.equal(jcBridgeReady(managed), true);
});

test('the probe reuses the executor wrapper and replaces only the serve verb', () => {
  const node = '/usr/bin/node';
  const entry = '/opt/jace-commander/current/dist/cli.js';
  const invocation = localReadinessInvocation({
    cmd: '/usr/bin/setpriv',
    args: ['--reuid=jc', '--regid=jc', '--init-groups', '--inh-caps=-all', '--bounding-set=-all', node, entry, 'serve', '--preset', 'local'],
  });
  assert.deepEqual(invocation, {
    command: '/usr/bin/setpriv',
    args: ['--reuid=jc', '--regid=jc', '--init-groups', '--inh-caps=-all', '--bounding-set=-all', node, entry, 'local-readiness', '--json'],
  });
  assert.deepEqual(
    localReadinessInvocation({ cmd: node, args: [entry, 'serve', '--preset', 'local'] }),
    { command: node, args: [entry, 'local-readiness', '--json'] },
  );
  assert.equal(localReadinessInvocation({ cmd: node, args: [path.join(path.sep, 'tmp', 'other.js'), 'serve'] }), null);
});
