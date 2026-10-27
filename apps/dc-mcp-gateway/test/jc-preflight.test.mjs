// Preflight for the canonical Jace Commander service set, against fixture secret directories. No secret is real.
// Host-only checks (service identities, root ownership of the policy and its directory) fail here by design: this
// environment has no acs-* accounts and runs unprivileged. The tests assert that every other check passes on a
// correct fixture, and that each deliberate mistake fails with its specific message. Run: node --test test/jc-preflight.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const UNITS = fileURLToPath(new URL('../../../ops/jc-hardening/', import.meta.url));
const PREFLIGHT = path.join(UNITS, 'preflight.sh');
const HOST_ONLY = /identity acs-|policy owned by|policy directory/;

const GOOD = {
  'acs-edge.env': [
    'SIGNING_KEY=signing-fixture-value',
    'CONSENT_PASSPHRASE=passphrase-fixture-value',
    'GATEWAY_EXECUTION_TOKEN=attest-fixture-value',
    'ACS_GATEWAY_URL=http://127.0.0.1:1',
    'ACS_JC_GATEWAY_TOKEN=gateway-acs-fixture-value',
  ],
  'acs-jc.env': [
    'DC_GATEWAY_EXECUTION_TOKEN=attest-fixture-value',
    'DC_GATEWAY_ATTESTATION_SIGNING_KEY=signing-pem-fixture-value',
    'ACS_WORKER_TOKEN=bridge-acs-fixture-value',
    'JC_ACS_PUBLIC_KEY=public-fixture-value',
  ],
  'acs-ingress.env': ['JC_PUBLIC_HOST=edge.test', 'PUBLIC_INGRESS_PORT=8011'],
};
const SECRET_VALUES = ['signing-fixture-value', 'passphrase-fixture-value', 'attest-fixture-value', 'gateway-acs-fixture-value', 'bridge-acs-fixture-value', 'public-fixture-value', 'signing-pem-fixture-value'];

function fixture(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-preflight-'));
  const policy = path.join(dir, 'policy.json');
  const files = { ...GOOD, ...(overrides.files || {}) };
  for (const [name, lines] of Object.entries(files)) {
    if (lines === null) continue;
    const file = path.join(dir, name);
    fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
    fs.chmodSync(file, overrides.modes?.[name] ?? 0o640);
  }
  fs.writeFileSync(policy, '{}\n', { mode: 0o644 });
  return { dir, policy };
}

function run(f) {
  const r = spawnSync('bash', [PREFLIGHT, '--secrets', f.dir, '--policy', f.policy, '--units', UNITS], { encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
const failLines = (out) => out.split('\n').filter((l) => l.startsWith('FAIL'));

test('a correct fixture passes every non-host check', () => {
  const r = run(fixture());
  const unexpected = failLines(r.out).filter((l) => !HOST_ONLY.test(l));
  assert.deepEqual(unexpected, [], `unexpected failures:\n${r.out}`);
  assert.match(r.out, /PASS  attestation secret matches gateway and bridge/);
  assert.match(r.out, /PASS  ACS gateway and bridge identities are distinct/);
  assert.match(r.out, /PASS  bridge env excludes ACS_JC_GATEWAY_TOKEN/);
  assert.match(r.out, /PASS  gateway env excludes the bridge ACS worker token and the Ed25519 signing key/);
  assert.match(r.out, /PASS  ingress env holds no secrets/);
  assert.match(r.out, /PASS  no env file sets the retired shared attestation key/);
  assert.match(r.out, /PASS  unit verifies: acs-jc-bridge/);
  assert.match(r.out, /PASS  executor is dropped to acs-jc-exec, not the bridge uid/);
  assert.match(r.out, /PASS  public ingress runs the hardened edge\/ingress\.js/);
  assert.match(r.out, /PASS  no unit references the retired shared attestation key/);
  assert.notEqual(r.status, 0, 'host-only checks must still fail closed in this environment');
});

test('the preflight never prints a secret value', () => {
  const r = run(fixture());
  for (const secret of SECRET_VALUES) assert.ok(!r.out.includes(secret), `output leaked ${secret}`);
});

test('the bridge holding the gateway ACS JC token is refused', () => {
  const f = fixture({ files: { 'acs-jc.env': [...GOOD['acs-jc.env'], 'ACS_JC_GATEWAY_TOKEN=x'] } });
  assert.match(run(f).out, /FAIL  bridge env holds ACS_JC_GATEWAY_TOKEN/);
});

test('the bridge holding the gateway OAuth signing key is refused', () => {
  const f = fixture({ files: { 'acs-jc.env': [...GOOD['acs-jc.env'], 'SIGNING_KEY=x'] } });
  assert.match(run(f).out, /FAIL  bridge env holds SIGNING_KEY/);
});

test('a bridge without its Ed25519 signing key is refused', () => {
  const f = fixture({ files: { 'acs-jc.env': GOOD['acs-jc.env'].filter((l) => !l.startsWith('DC_GATEWAY_ATTESTATION_SIGNING_KEY')) } });
  assert.match(run(f).out, /FAIL  bridge env missing DC_GATEWAY_ATTESTATION_SIGNING_KEY/);
});

test('the gateway holding the Ed25519 signing key is refused: only the bridge may sign attribution', () => {
  const f = fixture({ files: { 'acs-edge.env': [...GOOD['acs-edge.env'], 'DC_GATEWAY_ATTESTATION_SIGNING_KEY=x'] } });
  assert.match(run(f).out, /FAIL  gateway env holds the bridge ACS worker token or the Ed25519 SIGNING key/);
});

test('the public ingress holding any secret is refused', () => {
  const f = fixture({ files: { 'acs-ingress.env': ['JC_PUBLIC_HOST=edge.test', 'SIGNING_KEY=leak'] } });
  assert.match(run(f).out, /FAIL  ingress env holds a secret/);
});

test('the retired shared attestation key is refused in any env file', () => {
  const f = fixture({ files: { 'acs-jc.env': [...GOOD['acs-jc.env'], 'DC_GATEWAY_ATTESTATION_KEY=legacy'] } });
  assert.match(run(f).out, /FAIL  acs-jc\.env still sets the retired shared attestation key/);
});

test('a mismatched attestation secret is refused', () => {
  const f = fixture({ files: { 'acs-jc.env': GOOD['acs-jc.env'].map((l) => (l.startsWith('DC_GATEWAY_EXECUTION_TOKEN') ? 'DC_GATEWAY_EXECUTION_TOKEN=different' : l)) } });
  assert.match(run(f).out, /FAIL  attestation secret differs/);
});

test('ACS identities that are the same credential are refused', () => {
  const f = fixture({ files: { 'acs-jc.env': GOOD['acs-jc.env'].map((l) => (l.startsWith('ACS_WORKER_TOKEN') ? 'ACS_WORKER_TOKEN=gateway-acs-fixture-value' : l)) } });
  assert.match(run(f).out, /FAIL  gateway ACS token equals the bridge ACS worker token/);
});

test('a group- or world-readable secret file is refused', () => {
  const f = fixture({ modes: { 'acs-edge.env': 0o644 } });
  assert.match(run(f).out, /FAIL  mode 644 is more permissive than 0640: acs-edge\.env/);
});

test('a missing secret file fails closed', () => {
  const f = fixture({ files: { 'acs-jc.env': null } });
  assert.match(run(f).out, /FAIL  file missing or symlink: acs-jc\.env/);
});

test('a missing policy fails closed (otherwise the local preset would default to uniform local)', () => {
  const f = fixture();
  fs.rmSync(f.policy);
  const r = run(f);
  assert.match(r.out, /FAIL  policy missing or a symlink/);
  assert.notEqual(r.status, 0);
});

test('an unknown argument is a usage error', () => {
  const r = spawnSync('bash', [PREFLIGHT, '--nope'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});
