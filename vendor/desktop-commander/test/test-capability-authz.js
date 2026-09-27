import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LocalCapabilityIssuer,
  issueCapabilityWithKey,
  verifyCapability,
} from '../dist/security/capability.js';
import { canonicalizeAndAuthorizePath } from '../dist/security/path-policy.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-capability-'));

async function testIssueAndVerifyHappyPath() {
  const issuer = new LocalCapabilityIssuer(path.join(tmp, 'key-1'));
  const cap = issuer.issue({
    workItemId: 'wi-1',
    agent: 'agent-a',
    tool: 'write_file',
    paths: ['/home/jacen/projects/demo'],
    commandClass: 'local-write',
    network: 'none',
  });
  assert.ok(cap.signature.length > 0);
  assert.ok(cap.expiresAt - cap.issuedAt <= 5 * 60 * 1000, 'default TTL must be <= 5 minutes');
  const result = issuer.verify(cap, {
    tool: 'write_file',
    paths: ['/home/jacen/projects/demo/file.txt'],
    commandClass: 'local-write',
    network: 'none',
  });
  assert.equal(result.ok, true);
}

async function testRejections() {
  const issuer = new LocalCapabilityIssuer(path.join(tmp, 'key-2'));
  const cap = issuer.issue({
    workItemId: 'wi-2',
    agent: 'agent-a',
    tool: 'write_file',
    paths: ['/home/jacen/projects/demo'],
    commandClass: 'local-write',
    network: 'none',
  });

  // Unknown / mismatched tool
  const tool = issuer.verify(cap, { tool: 'start_process', commandClass: 'local-write', network: 'none' });
  assert.equal(tool.ok, false, 'unknown tool must be rejected');
  assert.equal(tool.ok === false && tool.code, 'CAPABILITY_TOOL_MISMATCH');

  // Path outside granted roots
  const escape = issuer.verify(cap, {
    tool: 'write_file',
    paths: ['/home/jacen/projects/other/file.txt'],
    commandClass: 'local-write',
    network: 'none',
  });
  assert.equal(escape.ok, false, 'path outside roots must be rejected');
  assert.equal(escape.ok === false && escape.code, 'CAPABILITY_PATH_ESCALATION');

  // Prefix trick must not pass (/demo-sibling must not match /demo)
  const prefix = issuer.verify(cap, {
    tool: 'write_file',
    paths: ['/home/jacen/projects/demo-sibling/file.txt'],
    commandClass: 'local-write',
    network: 'none',
  });
  assert.equal(prefix.ok, false, 'directory-prefix trick must be rejected');

  // Command class escalation
  const escalation = issuer.verify(cap, {
    tool: 'write_file',
    commandClass: 'destructive',
    network: 'none',
  });
  assert.equal(escalation.ok, false, 'command class escalation must be rejected');
  assert.equal(escalation.ok === false && escalation.code, 'CAPABILITY_COMMAND_CLASS_ESCALATION');

  // Network escalation
  const net = issuer.verify(cap, {
    tool: 'write_file',
    commandClass: 'local-write',
    network: 'full',
  });
  assert.equal(net.ok, false, 'network escalation must be rejected');
  assert.equal(net.ok === false && net.code, 'CAPABILITY_NETWORK_ESCALATION');

  // Tampered signature
  const forged = { ...cap, signature: cap.signature.slice(0, -2) + 'AA' };
  const sig = verifyCapability(forged, { tool: 'write_file', commandClass: 'local-write', network: 'none' }, issuer.getKey());
  assert.equal(sig.ok, false, 'forged signature must be rejected');

  // Expiry
  const expired = issueCapabilityWithKey(
    { workItemId: 'wi-3', agent: 'a', tool: 'read_file', commandClass: 'read-only', network: 'none' },
    issuer.getKey(),
    'cap-expired',
  );
  const afterExpiry = verifyCapability(
    expired,
    { tool: 'read_file', commandClass: 'read-only', network: 'none', now: expired.expiresAt + 1 },
    issuer.getKey(),
  );
  assert.equal(afterExpiry.ok, false, 'expired capability must be rejected');
  assert.equal(afterExpiry.ok === false && afterExpiry.code, 'CAPABILITY_EXPIRED');

  // Oversized TTL rejected at issue time
  assert.throws(
    () => issueCapabilityWithKey(
      { workItemId: 'wi-4', agent: 'a', tool: 'read_file', commandClass: 'read-only', network: 'none', ttlMs: 6 * 60 * 1000 },
      issuer.getKey(),
    ),
    /ttlMs/,
    'TTL above 5 minutes must be rejected',
  );
}

async function testKeyPersistenceAndPermissions() {
  const keyPath = path.join(tmp, 'keydir', 'capability-key');
  const issuer = new LocalCapabilityIssuer(keyPath);
  issuer.getKey(); // creates the file
  const stat = fs.statSync(keyPath);
  assert.equal(stat.mode & 0o777, 0o600, `key file must be mode 0600, got ${stat.mode.toString(8)}`);
  const material = fs.readFileSync(keyPath, 'utf8').trim();
  assert.ok(material.length > 0, 'persisted key material must be non-empty');

  // Second issuer over the same file shares the key (caps cross-verify).
  const second = new LocalCapabilityIssuer(keyPath);
  const cap = second.issue({
    workItemId: 'wi-5', agent: 'a', tool: 'read_file',
    commandClass: 'read-only', network: 'none',
  });
  const result = issuer.verify(cap, { tool: 'read_file', commandClass: 'read-only', network: 'none' });
  assert.equal(result.ok, true, 'persisted key must round-trip between issuer instances');
}

async function testSymlinkPathIsolation() {
  const root = path.join(tmp, 'workspace-root');
  const inside = path.join(root, 'inside');
  const outside = path.join(tmp, 'outside-secret');
  fs.mkdirSync(inside, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.writeFileSync(path.join(inside, 'ok.txt'), 'ok');

  // Symlink INSIDE the root pointing OUTSIDE: must be rejected.
  const escapeLink = path.join(root, 'escape-link');
  fs.symlinkSync(outside, escapeLink);

  const good = await canonicalizeAndAuthorizePath(path.join(inside, 'ok.txt'), [root]);
  assert.equal(good.ok, true, `plain in-root path must pass: ${JSON.stringify(good)}`);

  const bad = await canonicalizeAndAuthorizePath(path.join(escapeLink, 'secret.txt'), [root]);
  assert.equal(bad.ok, false, 'symlink pointing outside the root must be rejected');
  assert.match(bad.reason ?? '', /escape/);

  // Direct traversal outside the root.
  const traversal = await canonicalizeAndAuthorizePath(path.join(root, '..', 'outside-secret', 'secret.txt'), [root]);
  assert.equal(traversal.ok, false, 'traversal outside the root must be rejected');

  // Nonexistent leaf under an existing in-root ancestor resolves fine.
  const future = await canonicalizeAndAuthorizePath(path.join(inside, 'not-yet.txt'), [root]);
  assert.equal(future.ok, true, 'nonexistent leaf with in-root ancestors must be authorized');
}

async function testLexicalTraversalEscape() {
  // Red-team fix #4: raw lexical prefix matching let
  // '/allowed/project/../../../home/user/.ssh' pass. Both sides must be
  // normalized (and realpath'd when they exist) before containment compare.
  const issuer = new LocalCapabilityIssuer(path.join(tmp, 'key-3'));
  const root = fs.realpathSync(tmp);
  const cap = issuer.issue({
    workItemId: 'wi-6',
    agent: 'agent-a',
    tool: 'read_file',
    paths: [path.join(root, 'allowed', 'project')],
    commandClass: 'read-only',
    network: 'none',
  });
  const request = { tool: 'read_file', commandClass: 'read-only', network: 'none' };

  const traversal = issuer.verify(cap, {
    ...request,
    paths: [path.join(root, 'allowed', 'project', '..', '..', '..', 'tmp', 'escape-target')],
  });
  assert.equal(traversal.ok, false, 'dot-dot traversal outside the root must be rejected');
  assert.equal(traversal.ok === false && traversal.code, 'CAPABILITY_PATH_ESCALATION');

  // A traversal that lands back INSIDE the root is fine.
  const inside = issuer.verify(cap, {
    ...request,
    paths: [path.join(root, 'allowed', 'project', 'sub', '..', 'file.txt')],
  });
  assert.equal(inside.ok, true, 'traversal that normalizes back inside the root must pass');

  // Symlink escape: requested path resolves (realpath) outside the root.
  const outside = path.join(tmp, 'outside-real');
  fs.mkdirSync(outside, { recursive: true });
  const linkPath = path.join(root, 'allowed', 'project', 'in-link');
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  try { fs.symlinkSync(outside, linkPath); } catch { /* already exists */ }
  const viaSymlink = issuer.verify(cap, { ...request, paths: [path.join(linkPath, 'file.txt')] });
  assert.equal(viaSymlink.ok, false, 'symlink resolving outside the root must be rejected');
}

await testIssueAndVerifyHappyPath();
await testRejections();
await testKeyPersistenceAndPermissions();
await testSymlinkPathIsolation();
await testLexicalTraversalEscape();
console.log('Capability authz tests passed.');
