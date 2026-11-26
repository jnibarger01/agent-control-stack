/**
 * OS-native credential storage abstraction with headless AES-256-GCM fallback.
 *
 * Zero native npm addons (`--ignore-scripts` release safe):
 *   - Linux: Secret Service (`secret-tool`), fallback KWallet (`kwallet-query`)
 *   - macOS: Keychain (`security` interactive stdin mode)
 *   - Windows: Credential/DPAPI store (`powershell.exe` stdin JSON)
 *   - Headless fallback: EncryptedFileStore (AES-256-GCM, 0700/0600, separate KEK)
 *
 * Never stores key material inside the encrypted credential file and never falls
 * back to plaintext storage.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensurePrivateDir, writePrivateFileAtomic } from './auth-lock.js';

export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, secret: string): Promise<void>;
  delete(key: string): Promise<void>;
  backendName(): string;
}

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type ExecCommand = (cmd: string, args: string[], input?: string) => Promise<CommandResult>;

export function defaultExec(cmd: string, args: string[], input?: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ status: 127, stdout: '', stderr: error instanceof Error ? error.message : String(error) });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ status: 124, stdout: '', stderr: 'command timed out' });
    }, 8_000);
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: 127, stdout: '', stderr: error.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status: code ?? 1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

function accountId(key: string): string {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 32) + ':' + key.replace(/[^A-Za-z0-9._:@/-]/g, '_').slice(0, 64);
}

/** Linux Secret Service (`secret-tool`). */
export class SecretServiceStore implements SecretStore {
  constructor(private readonly exec: ExecCommand = defaultExec, private readonly service = 'jace-commander') {}

  backendName(): string {
    return 'linux-secret-service';
  }

  async isAvailable(): Promise<boolean> {
    const res = await this.exec('secret-tool', ['lookup', 'service', this.service, 'account', '__jc_probe__']);
    // Exit 0 (found) or 1 (not found) with clean stderr means daemon is reachable; D-Bus errors return >1 or D-Bus error text.
    if (res.status === 127 || res.status === 124) return false;
    if (/dbus|cannot autolaunch|no such interface|org\.freedesktop\.secrets/i.test(res.stderr)) return false;
    return res.status === 0 || res.status === 1;
  }

  async get(key: string): Promise<string | undefined> {
    const res = await this.exec('secret-tool', ['lookup', 'service', this.service, 'account', accountId(key)]);
    if (res.status !== 0) return undefined;
    return res.stdout.replace(/\r?\n$/, '') || undefined;
  }

  async set(key: string, secret: string): Promise<void> {
    const acct = accountId(key);
    const res = await this.exec(
      'secret-tool',
      ['store', `--label=Jace Commander (${key.slice(0, 40)})`, 'service', this.service, 'account', acct],
      secret,
    );
    if (res.status !== 0) {
      throw new Error(`secret-tool store failed (exit ${res.status}): ${res.stderr.trim()}`);
    }
  }

  async delete(key: string): Promise<void> {
    await this.exec('secret-tool', ['clear', 'service', this.service, 'account', accountId(key)]);
  }
}

/** Linux KWallet fallback (`kwallet-query`). */
export class KWalletStore implements SecretStore {
  constructor(
    private readonly exec: ExecCommand = defaultExec,
    private readonly wallet = 'kdewallet',
    private readonly folder = 'jace-commander',
  ) {}

  backendName(): string {
    return 'linux-kwallet';
  }

  async isAvailable(): Promise<boolean> {
    const res = await this.exec('kwallet-query', ['-l', '-f', this.folder, this.wallet]);
    return res.status === 0;
  }

  async get(key: string): Promise<string | undefined> {
    const res = await this.exec('kwallet-query', ['-r', accountId(key), '-f', this.folder, this.wallet]);
    if (res.status !== 0) return undefined;
    const val = res.stdout.replace(/\r?\n$/, '');
    return val.length > 0 ? val : undefined;
  }

  async set(key: string, secret: string): Promise<void> {
    const res = await this.exec('kwallet-query', ['-w', accountId(key), '-f', this.folder, this.wallet], secret);
    if (res.status !== 0) {
      throw new Error(`kwallet-query write failed (exit ${res.status})`);
    }
  }

  async delete(key: string): Promise<void> {
    await this.exec('kwallet-query', ['-w', accountId(key), '-f', this.folder, this.wallet], '');
  }
}

/** macOS Keychain (`security -i` interactive stdin avoids leaking secret in argv). */
export class KeychainStore implements SecretStore {
  constructor(private readonly exec: ExecCommand = defaultExec, private readonly service = 'jace-commander') {}

  backendName(): string {
    return 'macos-keychain';
  }

  async isAvailable(): Promise<boolean> {
    const res = await this.exec('security', ['default-keychain']);
    return res.status === 0;
  }

  async get(key: string): Promise<string | undefined> {
    const res = await this.exec('security', ['find-generic-password', '-s', this.service, '-a', accountId(key), '-w']);
    if (res.status !== 0) return undefined;
    return res.stdout.replace(/\r?\n$/, '') || undefined;
  }

  async set(key: string, secret: string): Promise<void> {
    const escapedSecret = secret.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const escapedAcct = accountId(key).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const line = `add-generic-password -U -s "${this.service}" -a "${escapedAcct}" -w "${escapedSecret}"\n`;
    const res = await this.exec('security', ['-i'], line);
    if (res.status !== 0) {
      throw new Error(`macOS Keychain store failed (exit ${res.status})`);
    }
  }

  async delete(key: string): Promise<void> {
    await this.exec('security', ['delete-generic-password', '-s', this.service, '-a', accountId(key)]);
  }
}

/** Windows DPAPI-protected store via PowerShell stdin (never exposes secret on argv). */
export class WindowsCredentialStore implements SecretStore {
  constructor(private readonly exec: ExecCommand = defaultExec) {}

  backendName(): string {
    return 'windows-dpapi';
  }

  async isAvailable(): Promise<boolean> {
    const res = await this.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major']);
    return res.status === 0;
  }

  private script(): string {
    return [
      '$ErrorActionPreference = "Stop"',
      '$raw = [Console]::In.ReadToEnd()',
      '$req = $raw | ConvertFrom-Json',
      'Add-Type -AssemblyName System.Security',
      '$dir = Join-Path $env:LOCALAPPDATA "jace-commander\\cred"',
      'New-Item -ItemType Directory -Force -Path $dir | Out-Null',
      '$hash = [System.BitConverter]::ToString(([System.Security.Cryptography.SHA256]::Create()).ComputeHash([System.Text.Encoding]::UTF8.GetBytes($req.key))).Replace("-","").ToLowerInvariant()',
      '$file = Join-Path $dir ($hash + ".dpapi")',
      'if ($req.op -eq "set") {',
      '  $bytes = [System.Text.Encoding]::UTF8.GetBytes($req.secret)',
      '  $prot = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
      '  [System.IO.File]::WriteAllBytes($file, $prot)',
      '} elseif ($req.op -eq "get") {',
      '  if (-not (Test-Path $file)) { Write-Output \'{"missing":true}\'; exit 0 }',
      '  $prot = [System.IO.File]::ReadAllBytes($file)',
      '  $bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($prot, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
      '  $sec = [System.Text.Encoding]::UTF8.GetString($bytes)',
      '  @{ secret = $sec } | ConvertTo-Json -Compress | Write-Output',
      '} elseif ($req.op -eq "delete") {',
      '  if (Test-Path $file) { Remove-Item -Force $file }',
      '}',
    ].join('; ');
  }

  async get(key: string): Promise<string | undefined> {
    const res = await this.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', this.script()], JSON.stringify({ op: 'get', key }));
    if (res.status !== 0) return undefined;
    try {
      const parsed = JSON.parse(res.stdout.trim()) as { missing?: boolean; secret?: string };
      return parsed.missing ? undefined : parsed.secret;
    } catch {
      return undefined;
    }
  }

  async set(key: string, secret: string): Promise<void> {
    const res = await this.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', this.script()], JSON.stringify({ op: 'set', key, secret }));
    if (res.status !== 0) {
      throw new Error(`Windows DPAPI credential store failed (exit ${res.status})`);
    }
  }

  async delete(key: string): Promise<void> {
    await this.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', this.script()], JSON.stringify({ op: 'delete', key }));
  }
}

interface EncryptedEnvelope {
  v: 1;
  alg: 'aes-256-gcm';
  kdf: 'scrypt' | 'keyfile';
  salt?: string;
  iv: string;
  tag: string;
  ct: string;
}

function assertSafePrivateFile(filePath: string): void {
  const st = fs.lstatSync(filePath);
  if (st.isSymbolicLink()) {
    throw new Error(`refusing symlink credential/key file: ${filePath}`);
  }
  if (!st.isFile()) {
    throw new Error(`expected regular file: ${filePath}`);
  }
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(`unexpected file owner on ${filePath}`);
  }
  if ((st.mode & 0o077) !== 0) {
    throw new Error(`insecure permissions on ${filePath} (expected 0600)`);
  }
}

function readKeyMaterialFromFile(keyPath: string): Buffer {
  assertSafePrivateFile(keyPath);
  const raw = fs.readFileSync(keyPath, 'utf8').trim();
  const decoded = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (decoded.length !== 32) {
    throw new Error(`key file ${keyPath} must decode to 32 bytes`);
  }
  return decoded;
}

/**
 * Headless AES-256-GCM encrypted file store.
 * Key material is NEVER stored in the encrypted credential file itself.
 */
export class EncryptedFileStore implements SecretStore {
  private readonly secretsDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly stateDir: string;

  constructor(options: { stateDir: string; env?: NodeJS.ProcessEnv }) {
    this.stateDir = options.stateDir;
    this.secretsDir = path.join(options.stateDir, 'secrets');
    this.env = options.env ?? process.env;
  }

  backendName(): string {
    return 'encrypted-file';
  }

  private secretFilePath(key: string): string {
    const hash = crypto.createHash('sha256').update(key, 'utf8').digest('hex');
    return path.join(this.secretsDir, `${hash}.enc`);
  }

  private headlessKeyPath(): string {
    const xdgRuntime = this.env.XDG_RUNTIME_DIR?.trim();
    if (xdgRuntime) {
      try {
        const st = fs.lstatSync(xdgRuntime);
        if (!st.isSymbolicLink() && st.isDirectory() && (st.mode & 0o077) === 0) {
          const stateHash = crypto.createHash('sha256').update(path.resolve(this.stateDir)).digest('hex').slice(0, 12);
          return path.join(xdgRuntime, 'jace-commander', `keystore-${stateHash}.key`);
        }
      } catch {
        // fall through to stateDir/keystore
      }
    }
    return path.join(this.stateDir, 'keystore', 'master.key');
  }

  private resolveKek(createIfMissing: boolean, kdfHint?: 'scrypt' | 'keyfile', saltB64?: string): { kek: Buffer; kdf: 'scrypt' | 'keyfile'; salt?: string } {
    if (this.env.JC_KEYRING_PASSPHRASE) {
      const salt = saltB64 ? Buffer.from(saltB64, 'base64url') : crypto.randomBytes(16);
      const kek = crypto.scryptSync(this.env.JC_KEYRING_PASSPHRASE, salt, 32, { N: 16384, r: 8, p: 1 });
      return { kek, kdf: 'scrypt', salt: salt.toString('base64url') };
    }
    if (kdfHint === 'scrypt') {
      throw new Error('JC_KEYRING_PASSPHRASE is required to decrypt passphrase-protected secrets');
    }
    if (this.env.JC_KEYRING_KEY_FILE) {
      return { kek: readKeyMaterialFromFile(path.resolve(this.env.JC_KEYRING_KEY_FILE)), kdf: 'keyfile' };
    }
    const keyPath = this.headlessKeyPath();
    if (fs.existsSync(keyPath)) {
      return { kek: readKeyMaterialFromFile(keyPath), kdf: 'keyfile' };
    }
    if (!createIfMissing) {
      throw new Error('headless keystore key is missing');
    }
    const keyDir = path.dirname(keyPath);
    ensurePrivateDir(keyDir);
    const key = crypto.randomBytes(32);
    writePrivateFileAtomic(keyPath, key.toString('base64'));
    return { kek: key, kdf: 'keyfile' };
  }

  async get(key: string): Promise<string | undefined> {
    const file = this.secretFilePath(key);
    if (!fs.existsSync(file)) return undefined;
    assertSafePrivateFile(file);
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8')) as EncryptedEnvelope;
    if (envelope.v !== 1 || envelope.alg !== 'aes-256-gcm') {
      throw new Error(`unsupported encrypted secret envelope in ${file}`);
    }
    const { kek } = this.resolveKek(false, envelope.kdf, envelope.salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', kek, Buffer.from(envelope.iv, 'base64url'));
    decipher.setAAD(Buffer.from(key, 'utf8'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ct, 'base64url')),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  }

  async set(key: string, secret: string): Promise<void> {
    ensurePrivateDir(this.secretsDir);
    const { kek, kdf, salt } = this.resolveKek(true);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv);
    cipher.setAAD(Buffer.from(key, 'utf8'));
    const ct = Buffer.concat([cipher.update(Buffer.from(secret, 'utf8')), cipher.final()]);
    const tag = cipher.getAuthTag();
    const envelope: EncryptedEnvelope = {
      v: 1,
      alg: 'aes-256-gcm',
      kdf,
      ...(salt ? { salt } : {}),
      iv: iv.toString('base64url'),
      tag: tag.toString('base64url'),
      ct: ct.toString('base64url'),
    };
    writePrivateFileAtomic(this.secretFilePath(key), JSON.stringify(envelope, null, 2));
  }

  async delete(key: string): Promise<void> {
    fs.rmSync(this.secretFilePath(key), { force: true });
  }
}

export interface CreateSecretStoreOptions {
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exec?: ExecCommand;
}

export async function createSecretStore(options: CreateSecretStoreOptions): Promise<SecretStore> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? os.platform();
  const exec = options.exec ?? defaultExec;
  const mode = (env.JC_SECRET_BACKEND ?? 'auto').toLowerCase();

  if (mode === 'encrypted' || mode === 'file') {
    return new EncryptedFileStore({ stateDir: options.stateDir, env });
  }

  // If explicit passphrase or keyfile is configured in auto mode, honor encrypted store directly.
  if (mode === 'auto' && (env.JC_KEYRING_PASSPHRASE || env.JC_KEYRING_KEY_FILE)) {
    return new EncryptedFileStore({ stateDir: options.stateDir, env });
  }

  if (platform === 'linux') {
    const ss = new SecretServiceStore(exec);
    if (await ss.isAvailable()) return ss;
    const kw = new KWalletStore(exec);
    if (await kw.isAvailable()) return kw;
  } else if (platform === 'darwin') {
    const kc = new KeychainStore(exec);
    if (await kc.isAvailable()) return kc;
  } else if (platform === 'win32') {
    const win = new WindowsCredentialStore(exec);
    if (await win.isAvailable()) return win;
  }

  if (mode === 'keyring') {
    throw new Error(`OS keyring unavailable on ${platform} and JC_SECRET_BACKEND=keyring forbids fallback`);
  }

  return new EncryptedFileStore({ stateDir: options.stateDir, env });
}
