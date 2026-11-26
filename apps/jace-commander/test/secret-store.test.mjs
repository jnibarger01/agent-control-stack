#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EncryptedFileStore,
  KeychainStore,
  KWalletStore,
  SecretServiceStore,
  WindowsCredentialStore,
  createSecretStore,
} from '../dist/secret-store.js';

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};

await test('EncryptedFileStore encrypts at rest with separate keyfile, 0700/0600 perms, and no key in ciphertext', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-enc-store-'));
  const store = new EncryptedFileStore({ stateDir: dir, env: { JC_HEADLESS_KEYSTORE: '1' } });
  assert.equal(store.backendName(), 'encrypted-file');

  await store.set('jc-mcp:refresh', 'super-secret-refresh-token-123');
  assert.equal(await store.get('jc-mcp:refresh'), 'super-secret-refresh-token-123');

  const secretFiles = fs.readdirSync(path.join(dir, 'secrets'));
  assert.equal(secretFiles.length, 1);
  const encPath = path.join(dir, 'secrets', secretFiles[0]);
  const encRaw = fs.readFileSync(encPath, 'utf8');
  assert.equal(encRaw.includes('super-secret-refresh-token-123'), false, 'secret must not appear in plaintext');
  assert.equal(fs.statSync(path.join(dir, 'secrets')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(encPath).mode & 0o777, 0o600);

  // Key material must be in a separate file from the ciphertext.
  const keyPath = path.join(dir, 'keystore', 'master.key');
  assert.equal(fs.existsSync(keyPath), true);
  assert.equal(fs.statSync(path.join(dir, 'keystore')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
  const keyBytes = fs.readFileSync(keyPath, 'utf8').trim();
  assert.equal(encRaw.includes(keyBytes), false, 'key material must never be stored in encrypted credential file');

  await store.delete('jc-mcp:refresh');
  assert.equal(await store.get('jc-mcp:refresh'), undefined);
});

await test('EncryptedFileStore supports JC_KEYRING_PASSPHRASE without writing any keyfile on disk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-passphrase-store-'));
  const env = { JC_KEYRING_PASSPHRASE: 'correct-horse-battery-staple' };
  const store = new EncryptedFileStore({ stateDir: dir, env });
  await store.set('k1', 'secret-val');
  assert.equal(fs.existsSync(path.join(dir, 'keystore')), false, 'no master.key written when passphrase is used');
  assert.equal(await store.get('k1'), 'secret-val');

  const wrongStore = new EncryptedFileStore({ stateDir: dir, env: { JC_KEYRING_PASSPHRASE: 'wrong-passphrase' } });
  await assert.rejects(() => wrongStore.get('k1'));
});

await test('EncryptedFileStore rejects symlinks and loose permissions on JC_KEYRING_KEY_FILE', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-perm-store-'));
  const keyFile = path.join(dir, 'ext.key');
  fs.writeFileSync(keyFile, Buffer.alloc(32, 7).toString('base64'), { mode: 0o644 });
  const looseStore = new EncryptedFileStore({ stateDir: dir, env: { JC_KEYRING_KEY_FILE: keyFile } });
  await assert.rejects(() => looseStore.set('k', 'v'), /permission/i);

  fs.chmodSync(keyFile, 0o600);
  const goodStore = new EncryptedFileStore({ stateDir: dir, env: { JC_KEYRING_KEY_FILE: keyFile } });
  await goodStore.set('k', 'v');
  assert.equal(await goodStore.get('k'), 'v');

  const sym = path.join(dir, 'sym.key');
  fs.symlinkSync(keyFile, sym);
  const symStore = new EncryptedFileStore({ stateDir: dir, env: { JC_KEYRING_KEY_FILE: sym } });
  await assert.rejects(() => symStore.get('k'), /symlink/i);
});

await test('SecretServiceStore uses secret-tool and passes secret via stdin (never argv)', async () => {
  const db = new Map();
  const calls = [];
  const exec = async (cmd, args, input) => {
    calls.push({ cmd, args, input });
    assert.equal(cmd, 'secret-tool');
    const account = args[args.indexOf('account') + 1];
    if (args[0] === 'store') {
      assert.equal(args.some((a) => a.includes('my-secret')), false, 'secret must not be in argv');
      db.set(account, input);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'lookup') {
      return db.has(account) ? { status: 0, stdout: db.get(account), stderr: '' } : { status: 1, stdout: '', stderr: '' };
    }
    if (args[0] === 'clear') {
      db.delete(account);
      return { status: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  const store = new SecretServiceStore(exec);
  assert.equal(store.backendName(), 'linux-secret-service');
  await store.set('acct-1', 'my-secret');
  assert.equal(await store.get('acct-1'), 'my-secret');
  await store.delete('acct-1');
  assert.equal(await store.get('acct-1'), undefined);
  assert.equal(calls.length, 4);
});

await test('KWalletStore, KeychainStore (macOS), and WindowsCredentialStore handle set/get/delete via stdin/secure runners', async () => {
  const kv = new Map();
  const kw = new KWalletStore(async (cmd, args, input) => {
    assert.equal(cmd, 'kwallet-query');
    if (args.includes('-w')) {
      assert.equal(args.some((a) => a.includes('kw-sec')), false);
      kv.set(args[args.indexOf('-w') + 1], input);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args.includes('-r')) {
      const k = args[args.indexOf('-r') + 1];
      return kv.has(k) && kv.get(k) !== '' ? { status: 0, stdout: kv.get(k), stderr: '' } : { status: 1, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: '' };
  });
  await kw.set('k', 'kw-sec');
  assert.equal(await kw.get('k'), 'kw-sec');
  await kw.delete('k');
  assert.equal(await kw.get('k'), undefined);

  const kc = new Map();
  const mac = new KeychainStore(async (cmd, args, input) => {
    assert.equal(cmd, 'security');
    if (args[0] === '-i') {
      const m = /add-generic-password .* -a "([^"]+)" -w "([^"]*)"/.exec(input);
      assert.ok(m);
      kc.set(m[1], m[2]);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'find-generic-password') {
      const a = args[args.indexOf('-a') + 1];
      return kc.has(a) ? { status: 0, stdout: `${kc.get(a)}\n`, stderr: '' } : { status: 44, stdout: '', stderr: '' };
    }
    if (args[0] === 'delete-generic-password') {
      kc.delete(args[args.indexOf('-a') + 1]);
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: '' };
  });
  assert.equal(mac.backendName(), 'macos-keychain');
  await mac.set('a1', 'mac-secret');
  assert.equal(await mac.get('a1'), 'mac-secret');
  await mac.delete('a1');
  assert.equal(await mac.get('a1'), undefined);

  const winDb = new Map();
  const win = new WindowsCredentialStore(async (cmd, _args, input) => {
    assert.equal(cmd, 'powershell.exe');
    const req = JSON.parse(input);
    if (req.op === 'set') {
      winDb.set(req.key, req.secret);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (req.op === 'get') {
      return winDb.has(req.key) ? { status: 0, stdout: JSON.stringify({ secret: winDb.get(req.key) }), stderr: '' } : { status: 0, stdout: JSON.stringify({ missing: true }), stderr: '' };
    }
    if (req.op === 'delete') {
      winDb.delete(req.key);
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: '' };
  });
  assert.equal(win.backendName(), 'windows-dpapi');
  await win.set('w1', 'win-secret');
  assert.equal(await win.get('w1'), 'win-secret');
  await win.delete('w1');
  assert.equal(await win.get('w1'), undefined);
});

await test('createSecretStore falls back to EncryptedFileStore in headless environments and fails closed when keyring forced', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-auto-store-'));
  const noKeyringExec = async () => ({ status: 1, stdout: '', stderr: 'Cannot autolaunch D-Bus without X11 $DISPLAY' });
  const store = await createSecretStore({
    stateDir: dir,
    platform: 'linux',
    env: { JC_HEADLESS_KEYSTORE: '1' },
    exec: noKeyringExec,
  });
  assert.equal(store.backendName(), 'encrypted-file');

  await assert.rejects(
    () => createSecretStore({
      stateDir: dir,
      platform: 'linux',
      env: { JC_SECRET_BACKEND: 'keyring' },
      exec: noKeyringExec,
    }),
    /keyring unavailable/i,
  );
});

console.log(`\njace-commander secret-store: ${passed} passed`);
