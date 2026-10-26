// Preflight for the hardened services, against fixture credential directories. No secrets are real.
// Host-only checks (service identities, root ownership of the policy) fail here by design: this environment has no
// jc-* accounts and runs unprivileged. The tests assert that every other check passes on a correct fixture, and that
// each deliberate mistake fails with its specific message. Run: node --test test/jc-preflight.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HARDENED = fileURLToPath(new URL('../deploy/systemd/hardened/', import.meta.url));
const PREFLIGHT = path.join(HARDENED, 'preflight.sh');
const HOST_ONLY = /identity jc-|policy owned by|policy directory|unit missing/;

function fixture(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-preflight-'));
  const policy = path.join(dir, 'policy.json');
  const files = {
    'gateway.env': [
      'SIGNING_KEY=signing-fixture-value',
      'CONSENT_PASSPHRASE=passphrase-fixture-value',
      'GATEWAY_EXECUTION_TOKEN=attest-fixture-value',
      'ACS_GATEWAY_URL=http://127.0.0.1:1',
      'ACS_JC_GATEWAY_TOKEN=gateway-acs-fixture-value',
    ],
    'bridge.env': [
      'DC_GATEWAY_EXECUTION_TOKEN=attest-fixture-value',
      'ACS_WORKER_TOKEN=bridge-acs-fixture-value',
      'JC_ACS_PUBLIC_KEY=public-fixture-value',
    ],
    'edge.env': ['JC_PUBLIC_HOST=edge.test', 'PUBLIC_INGRESS_PORT=8011'],
  };
  for (const [name, lines] of Object.entries({ ...files, ...(overrides.files || {}) })) {
    const file = path.join(dir, name);
    if (lines === null) continue;
    fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
    fs.chmodSync(file, overrides.modes?.[name] ?? 0o640);
  }
  fs.writeFileSync(policy, '{}\n', { mode: 0o644 });
  return { dir, policy };
}

function run(f, extra = []) {
  const r = spawnSync('bash', [PREFLIGHT, '--etc', f.dir, '--policy', f.policy, '--units', HARDENED, ...extra], { encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
const failLines = (out) => out.split('\n').filter((l) => l.startsWith('FAIL'));

test('a correct fixture passes every check except the host-only ones', () => {
  const f = fixture();
  const r = run(f);
  const unexpected = failLines(r.out).filter((l) => !HOST_ONLY.test(l));
  assert.deepEqual(unexpected, [], `unexpected failures:\n${r.out}`);
  assert.match(r.out, /PASS  attestation secret matches gateway and bridge/);
  assert.match(r.out, /PASS  ACS gateway and bridge identities are distinct/);
  assert.match(r.out, /PASS  bridge\.env excludes ACS_JC_GATEWAY_TOKEN/);
  assert.match(r.out, /PASS  edge\.env holds no secrets/);
  assert.match(r.out, /PASS  unit verifies: jace-commander-gateway/);
  assert.notEqual(r.status, 0, 'host-only checks must still fail closed in this environment');
});

test('the preflight never prints a secret value', () => {
  const f = fixture();
  const r = run(f);
  for (const secret of ['signing-fixture-value', 'passphrase-fixture-value', 'attest-fixture-value', 'gateway-acs-fixture-value', 'bridge-acs-fixture-value', 'public-fixture-value']) {
    assert.ok(!r.out.includes(secret), `output leaked ${secret}`);
  }
});

test('the bridge holding the gateway ACS JC token is refused', () => {
  const f = fixture({ files: { 'bridge.env': ['DC_GATEWAY_EXECUTION_TOKEN=attest-fixture-value', 'ACS_JC_GATEWAY_TOKEN=x', 'JC_ACS_PUBLIC_KEY=p'] } });
  assert.match(run(f).out, /FAIL  bridge\.env holds the gateway's ACS JC token/);
});

test('a mismatched attestation secret is refused', () => {
  const f = fixture({ files: { 'bridge.env': ['DC_GATEWAY_EXECUTION_TOKEN=different', 'ACS_WORKER_TOKEN=b', 'JC_ACS_PUBLIC_KEY=p'] } });
  assert.match(run(f).out, /FAIL  attestation secret differs/);
});

test('ACS identities that are the same credential are refused', () => {
  const f = fixture({ files: { 'bridge.env': ['DC_GATEWAY_EXECUTION_TOKEN=attest-fixture-value', 'ACS_WORKER_TOKEN=gateway-acs-fixture-value', 'JC_ACS_PUBLIC_KEY=p'] } });
  assert.match(run(f).out, /FAIL  gateway ACS token equals the bridge ACS worker token/);
});

test('the public edge holding any secret is refused', () => {
  const f = fixture({ files: { 'edge.env': ['JC_PUBLIC_HOST=edge.test', 'SIGNING_KEY=leak'] } });
  assert.match(run(f).out, /FAIL  edge\.env holds a secret/);
});

test('a group- or world-readable credential file is refused', () => {
  const f = fixture({ modes: { 'gateway.env': 0o644 } });
  assert.match(run(f).out, /FAIL  mode 644 is not 0640 or stricter: gateway\.env/);
});

test('a missing credential file fails closed', () => {
  const f = fixture({ files: { 'bridge.env': null } });
  assert.match(run(f).out, /FAIL  file missing or symlink: bridge\.env/);
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
