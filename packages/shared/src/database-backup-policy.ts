import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  backupControlPlaneDatabase,
  restoreControlPlaneDatabase,
  verifyControlPlaneDatabaseFile
} from "./database-operations.js";
import type { ControlPlaneDatabaseHealth } from "./database-health.js";

const MANIFEST_VERSION = 1;
const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;

export interface ManagedDatabaseBackupManifest {
  version: 1;
  backupId: string;
  createdAt: string;
  sourceName: string;
  artifact: string;
  artifactBytes: number;
  encryption: {
    algorithm: "aes-256-gcm";
    iv: string;
    authTag: string;
  };
  checksums: {
    encryptedSha256: string;
    plaintextSha256: string;
  };
  health: ControlPlaneDatabaseHealth;
  authentication: {
    algorithm: "hmac-sha256";
    value: string;
  };
}

export interface ManagedDatabaseBackupResult {
  manifestPath: string;
  artifactPath: string;
  manifest: ManagedDatabaseBackupManifest;
  retainedBackups: number;
}

export interface ManagedDatabaseBackupOptions {
  encryptionKey: Buffer;
  retentionCount: number;
  now?: Date;
  backupId?: string;
  beforePublish?: () => void | Promise<void>;
}

export interface RestoreDrillOptions {
  encryptionKey: Buffer;
  maximumBackupAgeMs: number;
  maximumRestoreDurationMs: number;
  now?: Date;
  temporaryRoot?: string;
}

export interface RestoreDrillResult {
  manifestPath: string;
  backupId: string;
  backupAgeMs: number;
  restoreDurationMs: number;
  rpoWithinTarget: boolean;
  rtoWithinTarget: boolean;
  readiness: ControlPlaneDatabaseHealth;
}

export async function createManagedDatabaseBackup(
  sourcePath: string,
  backupDirectoryPath: string,
  options: ManagedDatabaseBackupOptions
): Promise<ManagedDatabaseBackupResult> {
  assertEncryptionKey(options.encryptionKey);
  assertPositiveInteger(options.retentionCount, "retention count");
  const source = resolve(sourcePath);
  const backupDirectory = resolve(backupDirectoryPath);
  mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  chmodSync(backupDirectory, 0o700);

  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("backup timestamp must be valid");
  const backupId = options.backupId ?? randomUUID();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(backupId)) throw new Error("backup id contains unsupported characters");
  const prefix = `control-${now.toISOString().replace(/[:.]/g, "-")}-${backupId}`;
  const artifactPath = join(backupDirectory, `${prefix}.acsdb`);
  const manifestPath = `${artifactPath}.manifest.json`;
  if (existsSync(artifactPath) || existsSync(manifestPath))
    throw new Error("managed backup destination already exists");

  const rawTemporary = join(backupDirectory, `.${prefix}.${randomUUID()}.raw.tmp`);
  const encryptedTemporary = join(backupDirectory, `.${prefix}.${randomUUID()}.encrypted.tmp`);
  const manifestTemporary = join(backupDirectory, `.${prefix}.${randomUUID()}.manifest.tmp`);
  let artifactPublished = false;
  try {
    const backup = await backupControlPlaneDatabase(source, rawTemporary);
    const encrypted = await encryptFile(rawTemporary, encryptedTemporary, options.encryptionKey);
    const manifestWithoutAuthentication = {
      version: MANIFEST_VERSION,
      backupId,
      createdAt: now.toISOString(),
      sourceName: basename(source),
      artifact: basename(artifactPath),
      artifactBytes: statSync(encryptedTemporary).size,
      encryption: {
        algorithm: ENCRYPTION_ALGORITHM,
        iv: encrypted.iv.toString("base64"),
        authTag: encrypted.authTag.toString("base64")
      },
      checksums: {
        encryptedSha256: encrypted.encryptedSha256,
        plaintextSha256: encrypted.plaintextSha256
      },
      health: backup.health
    } satisfies Omit<ManagedDatabaseBackupManifest, "authentication">;
    const manifest: ManagedDatabaseBackupManifest = {
      ...manifestWithoutAuthentication,
      authentication: {
        algorithm: "hmac-sha256",
        value: authenticateManifest(manifestWithoutAuthentication, options.encryptionKey)
      }
    };
    writeFileSync(manifestTemporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    syncFile(manifestTemporary);
    await options.beforePublish?.();
    renameSync(encryptedTemporary, artifactPath);
    artifactPublished = true;
    renameSync(manifestTemporary, manifestPath);
    syncDirectory(backupDirectory);
    const retainedBackups = enforceRetention(backupDirectory, options.retentionCount, options.encryptionKey);
    return { manifestPath, artifactPath, manifest, retainedBackups };
  } finally {
    removeFile(rawTemporary);
    removeFile(encryptedTemporary);
    removeFile(manifestTemporary);
    if (artifactPublished && !existsSync(manifestPath)) removeFile(artifactPath);
  }
}

export async function verifyManagedDatabaseBackup(
  manifestPath: string,
  encryptionKey: Buffer,
  temporaryRoot?: string
): Promise<{ manifest: ManagedDatabaseBackupManifest; health: ControlPlaneDatabaseHealth }> {
  assertEncryptionKey(encryptionKey);
  const resolvedManifest = resolve(manifestPath);
  const manifest = readManifest(resolvedManifest);
  verifyManifestAuthentication(manifest, encryptionKey);
  const artifact = resolve(dirname(resolvedManifest), manifest.artifact);
  if (dirname(artifact) !== dirname(resolvedManifest)) throw new Error("backup artifact must be beside its manifest");
  if (!existsSync(artifact)) throw new Error("backup artifact is missing");
  if (statSync(artifact).size !== manifest.artifactBytes) throw new Error("backup artifact size mismatch");
  if ((await sha256File(artifact)) !== manifest.checksums.encryptedSha256) {
    throw new Error("encrypted backup checksum mismatch");
  }

  const temporaryDirectory = await mkdtemp(join(resolve(temporaryRoot ?? tmpdir()), "acs-backup-verify-"));
  const plaintext = join(temporaryDirectory, "control.db");
  try {
    await decryptFile(artifact, plaintext, encryptionKey, manifest);
    if ((await sha256File(plaintext)) !== manifest.checksums.plaintextSha256) {
      throw new Error("decrypted backup checksum mismatch");
    }
    return { manifest, health: verifyControlPlaneDatabaseFile(plaintext) };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function runManagedDatabaseRestoreDrill(
  manifestPath: string,
  options: RestoreDrillOptions
): Promise<RestoreDrillResult> {
  assertEncryptionKey(options.encryptionKey);
  assertPositiveInteger(options.maximumBackupAgeMs, "maximum backup age");
  assertPositiveInteger(options.maximumRestoreDurationMs, "maximum restore duration");
  const now = options.now ?? new Date();
  const resolvedManifest = resolve(manifestPath);
  const manifest = readManifest(resolvedManifest);
  verifyManifestAuthentication(manifest, options.encryptionKey);
  const backupAgeMs = now.getTime() - new Date(manifest.createdAt).getTime();
  if (!Number.isFinite(backupAgeMs) || backupAgeMs < 0) throw new Error("backup timestamp is invalid or in the future");

  const temporaryDirectory = await mkdtemp(join(resolve(options.temporaryRoot ?? tmpdir()), "acs-restore-drill-"));
  const decrypted = join(temporaryDirectory, "source.db");
  const restored = join(temporaryDirectory, "restored.db");
  const started = performance.now();
  try {
    const artifact = resolve(dirname(resolvedManifest), manifest.artifact);
    if (dirname(artifact) !== dirname(resolvedManifest)) throw new Error("backup artifact must be beside its manifest");
    if ((await sha256File(artifact)) !== manifest.checksums.encryptedSha256) {
      throw new Error("encrypted backup checksum mismatch");
    }
    await decryptFile(artifact, decrypted, options.encryptionKey, manifest);
    if ((await sha256File(decrypted)) !== manifest.checksums.plaintextSha256) {
      throw new Error("decrypted backup checksum mismatch");
    }
    verifyControlPlaneDatabaseFile(decrypted);
    await restoreControlPlaneDatabase(decrypted, restored, { writersStopped: true });
    const readiness = verifyControlPlaneDatabaseFile(restored);
    const restoreDurationMs = Math.ceil(performance.now() - started);
    return {
      manifestPath: resolvedManifest,
      backupId: manifest.backupId,
      backupAgeMs,
      restoreDurationMs,
      rpoWithinTarget: backupAgeMs <= options.maximumBackupAgeMs,
      rtoWithinTarget: restoreDurationMs <= options.maximumRestoreDurationMs,
      readiness
    };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function latestManagedBackupManifest(backupDirectoryPath: string): string {
  const backupDirectory = resolve(backupDirectoryPath);
  const manifests = listManifests(backupDirectory);
  if (manifests.length === 0) throw new Error("no managed backup manifests found");
  return manifests.at(-1)!.path;
}

export function readDatabaseBackupKey(keyFilePath: string): Buffer {
  const keyPath = resolve(keyFilePath);
  const metadata = lstatSync(keyPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("backup key path must be a regular file");
  if ((metadata.mode & 0o077) !== 0) throw new Error("backup key file must not be accessible by group or others");
  const contents = readFileSync(keyPath);
  const key =
    contents.length === KEY_BYTES
      ? contents
      : /^[a-fA-F0-9]{64}\s*$/.test(contents.toString("utf8"))
        ? Buffer.from(contents.toString("utf8").trim(), "hex")
        : Buffer.alloc(0);
  assertEncryptionKey(key);
  return key;
}

function enforceRetention(backupDirectory: string, retentionCount: number, encryptionKey: Buffer): number {
  const manifests = listManifests(backupDirectory);
  for (const candidate of manifests) {
    verifyManifestAuthentication(candidate.manifest, encryptionKey);
  }
  for (const expired of manifests.slice(0, Math.max(0, manifests.length - retentionCount))) {
    const artifact = resolve(backupDirectory, expired.manifest.artifact);
    if (dirname(artifact) !== backupDirectory) throw new Error("retention candidate escapes backup directory");
    removeFile(artifact);
    removeFile(expired.path);
  }
  syncDirectory(backupDirectory);
  return Math.min(manifests.length, retentionCount);
}

function listManifests(directory: string): Array<{ path: string; manifest: ManagedDatabaseBackupManifest }> {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".acsdb.manifest.json"))
    .map((name) => {
      const path = join(directory, name);
      return { path, manifest: readManifest(path) };
    })
    .sort((left, right) => left.manifest.createdAt.localeCompare(right.manifest.createdAt));
}

function readManifest(path: string): ManagedDatabaseBackupManifest {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(value) || value.version !== MANIFEST_VERSION) throw new Error("unsupported backup manifest version");
  if (
    typeof value.backupId !== "string" ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.sourceName !== "string" ||
    typeof value.artifact !== "string" ||
    basename(value.artifact) !== value.artifact ||
    typeof value.artifactBytes !== "number" ||
    !Number.isSafeInteger(value.artifactBytes) ||
    value.artifactBytes < 1 ||
    !isRecord(value.encryption) ||
    value.encryption.algorithm !== ENCRYPTION_ALGORITHM ||
    typeof value.encryption.iv !== "string" ||
    typeof value.encryption.authTag !== "string" ||
    !isRecord(value.checksums) ||
    !isSha256(value.checksums.encryptedSha256) ||
    !isSha256(value.checksums.plaintextSha256) ||
    !isRecord(value.health) ||
    value.health.ok !== true ||
    !isRecord(value.authentication) ||
    value.authentication.algorithm !== "hmac-sha256" ||
    !isSha256(value.authentication.value)
  ) {
    throw new Error("backup manifest is malformed");
  }
  return value as unknown as ManagedDatabaseBackupManifest;
}

function authenticateManifest(
  manifest: Omit<ManagedDatabaseBackupManifest, "authentication">,
  encryptionKey: Buffer
): string {
  return createHmac("sha256", manifestAuthenticationKey(encryptionKey)).update(JSON.stringify(manifest)).digest("hex");
}

function verifyManifestAuthentication(manifest: ManagedDatabaseBackupManifest, encryptionKey: Buffer): void {
  const { authentication, ...authenticatedFields } = manifest;
  const expected = Buffer.from(authenticateManifest(authenticatedFields, encryptionKey), "hex");
  const actual = Buffer.from(authentication.value, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("backup manifest authentication failed");
  }
}

function manifestAuthenticationKey(encryptionKey: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", encryptionKey, Buffer.alloc(0), "acs-database-backup-manifest-v1", 32));
}

async function encryptFile(
  source: string,
  destination: string,
  key: Buffer
): Promise<{ iv: Buffer; authTag: Buffer; plaintextSha256: string; encryptedSha256: string }> {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const plaintextHash = createHash("sha256");
  const encryptedHash = createHash("sha256");
  await pipeline(
    createReadStream(source),
    hashTransform(plaintextHash),
    cipher,
    hashTransform(encryptedHash),
    createWriteStream(destination, { flags: "wx", mode: 0o600 })
  );
  syncFile(destination);
  return {
    iv,
    authTag: cipher.getAuthTag(),
    plaintextSha256: plaintextHash.digest("hex"),
    encryptedSha256: encryptedHash.digest("hex")
  };
}

async function decryptFile(
  source: string,
  destination: string,
  key: Buffer,
  manifest: ManagedDatabaseBackupManifest
): Promise<void> {
  const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, Buffer.from(manifest.encryption.iv, "base64"));
  decipher.setAuthTag(Buffer.from(manifest.encryption.authTag, "base64"));
  try {
    await pipeline(createReadStream(source), decipher, createWriteStream(destination, { flags: "wx", mode: 0o600 }));
  } catch (error) {
    removeFile(destination);
    throw new Error("backup decryption or authentication failed", { cause: error });
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function hashTransform(hash: ReturnType<typeof createHash>): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    }
  });
}

function assertEncryptionKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error(`backup encryption key must contain exactly ${KEY_BYTES} bytes`);
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function syncFile(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function removeFile(path: string): void {
  rmSync(path, { force: true });
}
