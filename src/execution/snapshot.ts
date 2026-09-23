import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { getRuntimeIdentityState } from '../runtime-identity.js';
import { strictCanonicalJsonV1 } from '../managed-acs.js';
import { DcToolError } from './errors.js';
import { assertHex, dcStateDirectory, resolveAllowedPath } from './scope.js';
import { currentRequestContext, recordEvidence, sha256Hex } from './context.js';
import { redactText } from './secret-scan.js';

/**
 * snapshot_path / restore_snapshot: mechanical backups before risky mutations.
 *
 * Snapshots live in DC's private state area (<state>/snapshots/<snapshotId>,
 * mode 0700) as content-addressed objects plus a manifest whose sha256 is
 * sealed in manifest.sha256. Restore verifies the seal, the runtime binding,
 * every object hash, re-validates the target against the allowed directories,
 * honours an optional expected-current-hash guard, snapshots the current state
 * first (preRestoreSnapshotId) and replaces the target via staged rename.
 * This is not an authorization feature: ACS decides whether it may run.
 */
export const SNAPSHOT_SCHEMA = 'dc.snapshot.v1' as const;
export const SNAPSHOT_LIMITS = Object.freeze({ maxEntries: 5_000, maxTotalBytes: 256 * 1024 * 1024, maxFileBytes: 64 * 1024 * 1024, maxDepth: 32 });
const SNAPSHOT_ID = /^snap_\d{8}T\d{6}Z_[a-f0-9]{16}$/;

export interface SnapshotEntry {
  relPath: string;
  type: 'file' | 'directory' | 'symlink';
  mode: number;
  size: number;
  mtimeMs: number;
  sha256?: string;
  target?: string;
}

export interface SnapshotManifest {
  schema: typeof SNAPSHOT_SCHEMA;
  snapshotId: string;
  runtimeId: string;
  requestId: string | null;
  createdAt: string;
  reason: string | null;
  originalPath: string;
  kind: 'file' | 'directory';
  contentSha256: string;
  entryCount: number;
  totalBytes: number;
  skipped: { relPath: string; reason: string }[];
  entries: SnapshotEntry[];
}

export function snapshotRoot(): string {
  return path.join(dcStateDirectory(), 'snapshots');
}

async function runtimeId(): Promise<string> {
  return (await getRuntimeIdentityState()).runtime_id;
}

/** Content hash of a tree: excludes mtimes, so equal content hashes equal. */
export function treeContentHash(entries: SnapshotEntry[]): string {
  const canonical = entries
    .map((e) => ({ p: e.relPath, t: e.type, m: e.mode & 0o777, ...(e.sha256 ? { h: e.sha256 } : {}), ...(e.target !== undefined ? { l: e.target } : {}) }))
    .sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
  return sha256Hex(strictCanonicalJsonV1(canonical));
}

interface Collected {
  kind: 'file' | 'directory';
  entries: SnapshotEntry[];
  skipped: { relPath: string; reason: string }[];
  totalBytes: number;
  files: Map<string, string>;
}

async function collect(root: string, exclude: string): Promise<Collected | null> {
  let top: fs.Stats;
  try {
    top = await fsp.lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const result: Collected = { kind: top.isDirectory() ? 'directory' : 'file', entries: [], skipped: [], totalBytes: 0, files: new Map() };
  const tooLarge = (why: string) => new DcToolError('DC_SNAPSHOT_TOO_LARGE', `snapshot rejected: ${why}`, { stage: 'validate', details: { ...SNAPSHOT_LIMITS } });
  const addFile = async (abs: string, relPath: string, stat: fs.Stats) => {
    if (stat.size > SNAPSHOT_LIMITS.maxFileBytes) throw tooLarge(`${relPath || path.basename(abs)} exceeds ${SNAPSHOT_LIMITS.maxFileBytes} bytes`);
    result.totalBytes += stat.size;
    if (result.totalBytes > SNAPSHOT_LIMITS.maxTotalBytes) throw tooLarge(`total exceeds ${SNAPSHOT_LIMITS.maxTotalBytes} bytes`);
    const bytes = await fsp.readFile(abs);
    const sha = sha256Hex(bytes);
    result.files.set(sha, abs);
    result.entries.push({ relPath, type: 'file', mode: stat.mode & 0o7777, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs), sha256: sha });
  };
  if (top.isFile()) {
    await addFile(root, '', top);
    return result;
  }
  if (!top.isDirectory()) throw new DcToolError('DC_INVALID_ARGUMENT', 'snapshot target must be a regular file or directory', { stage: 'validate' });
  const walk = async (abs: string, rel: string, depth: number) => {
    if (depth > SNAPSHOT_LIMITS.maxDepth) throw tooLarge(`depth exceeds ${SNAPSHOT_LIMITS.maxDepth}`);
    const names = (await fsp.readdir(abs)).sort();
    for (const name of names) {
      const childAbs = path.join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      if (childAbs === exclude || childAbs.startsWith(exclude + path.sep)) {
        result.skipped.push({ relPath: childRel, reason: 'desktop_commander_state_area' });
        continue;
      }
      if (result.entries.length >= SNAPSHOT_LIMITS.maxEntries) throw tooLarge(`more than ${SNAPSHOT_LIMITS.maxEntries} entries`);
      const stat = await fsp.lstat(childAbs);
      if (stat.isSymbolicLink()) {
        // Never followed: recorded (and restored) as a link, not its target's content.
        result.entries.push({ relPath: childRel, type: 'symlink', mode: 0o777, size: 0, mtimeMs: Math.trunc(stat.mtimeMs), target: await fsp.readlink(childAbs) });
      } else if (stat.isDirectory()) {
        result.entries.push({ relPath: childRel, type: 'directory', mode: stat.mode & 0o7777, size: 0, mtimeMs: Math.trunc(stat.mtimeMs) });
        await walk(childAbs, childRel, depth + 1);
      } else if (stat.isFile()) {
        await addFile(childAbs, childRel, stat);
      } else {
        result.skipped.push({ relPath: childRel, reason: 'unsupported_file_type' });
      }
    }
  };
  await walk(root, '', 1);
  return result;
}

function newSnapshotId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `snap_${stamp}_${crypto.randomBytes(8).toString('hex')}`;
}

export interface SnapshotResult {
  snapshotId: string;
  snapshotRoot: string;
  originalPath: string;
  kind: 'file' | 'directory';
  contentSha256: string;
  manifestSha256: string;
  entryCount: number;
  totalBytes: number;
  skipped: { relPath: string; reason: string }[];
  createdAt: string;
  requestId: string | null;
}

async function writeSnapshot(originalPath: string, reason: string | null, collected: Collected): Promise<SnapshotResult> {
  const root = snapshotRoot();
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  const snapshotId = newSnapshotId();
  const dir = path.join(root, snapshotId);
  await fsp.mkdir(dir, { mode: 0o700 });
  await fsp.mkdir(path.join(dir, 'objects'), { mode: 0o700 });
  for (const [sha, abs] of collected.files) {
    const bytes = await fsp.readFile(abs);
    if (sha256Hex(bytes) !== sha) {
      await fsp.rm(dir, { recursive: true, force: true });
      throw new DcToolError('DC_PATH_CHANGED', 'a file changed while it was being snapshotted; snapshot discarded', { stage: 'commit' });
    }
    await fsp.writeFile(path.join(dir, 'objects', sha), bytes, { mode: 0o400, flag: 'wx' });
  }
  const manifest: SnapshotManifest = {
    schema: SNAPSHOT_SCHEMA,
    snapshotId,
    runtimeId: await runtimeId(),
    requestId: currentRequestContext()?.requestId ?? null,
    createdAt: new Date().toISOString(),
    reason: reason ? redactText(reason).slice(0, 500) : null,
    originalPath,
    kind: collected.kind,
    contentSha256: collected.kind === 'file' ? collected.entries[0].sha256! : treeContentHash(collected.entries),
    entryCount: collected.entries.length,
    totalBytes: collected.totalBytes,
    skipped: collected.skipped,
    entries: collected.entries,
  };
  const manifestBytes = Buffer.from(strictCanonicalJsonV1(manifest), 'utf8');
  const manifestSha = sha256Hex(manifestBytes);
  await fsp.writeFile(path.join(dir, 'manifest.json'), manifestBytes, { mode: 0o400, flag: 'wx' });
  await fsp.writeFile(path.join(dir, 'manifest.sha256'), `${manifestSha}\n`, { mode: 0o400, flag: 'wx' });
  return {
    snapshotId,
    snapshotRoot: dir,
    originalPath,
    kind: manifest.kind,
    contentSha256: manifest.contentSha256,
    manifestSha256: manifestSha,
    entryCount: manifest.entryCount,
    totalBytes: manifest.totalBytes,
    skipped: manifest.skipped,
    createdAt: manifest.createdAt,
    requestId: manifest.requestId,
  };
}

export async function snapshotPath(input: { path: string; reason?: string }): Promise<SnapshotResult> {
  if (input.reason !== undefined && (typeof input.reason !== 'string' || input.reason.length > 2_000)) {
    throw new DcToolError('DC_INVALID_ARGUMENT', 'reason must be a string of at most 2000 characters', { stage: 'validate' });
  }
  const target = await resolveAllowedPath(input.path, 'path');
  const collected = await collect(target.resolved, dcStateDirectory());
  if (!collected) throw new DcToolError('DC_PATH_NOT_FOUND', `nothing to snapshot at ${input.path}`, { stage: 'resolve' });
  const result = await writeSnapshot(target.resolved, input.reason ?? null, collected);
  recordEvidence({ results: { snapshotId: result.snapshotId, contentSha256: result.contentSha256, manifestSha256: result.manifestSha256 } });
  return result;
}

/** Load and fully verify a snapshot created by this runtime. */
export async function loadVerifiedSnapshot(snapshotId: unknown): Promise<{ manifest: SnapshotManifest; dir: string }> {
  if (typeof snapshotId !== 'string' || !SNAPSHOT_ID.test(snapshotId)) {
    throw new DcToolError('DC_SNAPSHOT_INVALID', 'snapshotId has an invalid shape', { stage: 'validate' });
  }
  const root = await fsp.realpath(snapshotRoot()).catch(() => {
    throw new DcToolError('DC_SNAPSHOT_INVALID', 'no snapshots exist', { stage: 'resolve' });
  });
  const dir = path.join(root, snapshotId);
  let real: string;
  try {
    real = await fsp.realpath(dir);
  } catch {
    throw new DcToolError('DC_SNAPSHOT_INVALID', `snapshot not found: ${snapshotId}`, { stage: 'resolve' });
  }
  if (real !== dir) throw new DcToolError('DC_SNAPSHOT_INVALID', 'snapshot directory escapes the snapshot area', { stage: 'resolve' });
  const invalid = (why: string) => new DcToolError('DC_SNAPSHOT_INVALID', `snapshot ${snapshotId} failed integrity verification: ${why}`, { stage: 'validate' });
  let manifestBytes: Buffer;
  let sealed: string;
  try {
    manifestBytes = await fsp.readFile(path.join(dir, 'manifest.json'));
    sealed = (await fsp.readFile(path.join(dir, 'manifest.sha256'), 'utf8')).trim();
  } catch {
    throw invalid('manifest missing');
  }
  if (sha256Hex(manifestBytes) !== sealed) throw invalid('manifest hash does not match its seal');
  let manifest: SnapshotManifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw invalid('manifest is not JSON');
  }
  if (manifest.schema !== SNAPSHOT_SCHEMA || manifest.snapshotId !== snapshotId) throw invalid('schema or id mismatch');
  if (manifest.runtimeId !== await runtimeId()) throw invalid('snapshot was not created by this runtime');
  for (const entry of manifest.entries) {
    if (typeof entry.relPath !== 'string' || entry.relPath.split('/').some((seg) => seg === '..' || seg === '.')
      || entry.relPath.startsWith('/') || entry.relPath.includes('\0') || entry.relPath.includes('\\')) {
      throw invalid(`entry path traversal: ${JSON.stringify(entry.relPath)}`);
    }
    if (entry.type === 'file') {
      if (!entry.sha256 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw invalid('entry hash malformed');
      let bytes: Buffer;
      try {
        bytes = await fsp.readFile(path.join(dir, 'objects', entry.sha256));
      } catch {
        throw invalid(`object missing for ${entry.relPath || '(file)'}`);
      }
      if (sha256Hex(bytes) !== entry.sha256) throw invalid(`object corrupted for ${entry.relPath || '(file)'}`);
    }
  }
  return { manifest, dir };
}

async function currentContentHash(target: string, kind: 'file' | 'directory'): Promise<string | null> {
  const collected = await collect(target, dcStateDirectory());
  if (!collected) return null;
  if (collected.kind !== kind) return `kind-mismatch:${collected.kind}`;
  return kind === 'file' ? collected.entries[0].sha256! : treeContentHash(collected.entries);
}

async function materialize(manifest: SnapshotManifest, dir: string, staging: string): Promise<void> {
  const object = (sha: string) => path.join(dir, 'objects', sha);
  if (manifest.kind === 'file') {
    const entry = manifest.entries[0];
    await fsp.copyFile(object(entry.sha256!), staging, fs.constants.COPYFILE_EXCL);
    await fsp.chmod(staging, entry.mode & 0o7777);
    return;
  }
  await fsp.mkdir(staging, { mode: 0o700 });
  for (const entry of manifest.entries) {
    const dest = path.join(staging, ...entry.relPath.split('/'));
    if (!dest.startsWith(staging + path.sep)) throw new DcToolError('DC_SNAPSHOT_INVALID', 'entry escapes restore root', { stage: 'validate' });
    if (entry.type === 'directory') await fsp.mkdir(dest, { recursive: true });
    else if (entry.type === 'symlink') await fsp.symlink(entry.target!, dest);
    else {
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(object(entry.sha256!), dest, fs.constants.COPYFILE_EXCL);
      await fsp.chmod(dest, entry.mode & 0o7777);
    }
  }
  for (const entry of manifest.entries.filter((e) => e.type === 'directory')) {
    await fsp.chmod(path.join(staging, ...entry.relPath.split('/')), entry.mode & 0o7777);
  }
}

export interface RestoreResult {
  snapshotId: string;
  target: string;
  kind: 'file' | 'directory';
  beforeSha256: string | null;
  afterSha256: string;
  preRestoreSnapshotId: string | null;
}

export async function restoreSnapshot(input: { snapshotId: string; expectedCurrentSha256?: string }): Promise<RestoreResult> {
  const expectedCurrent = input.expectedCurrentSha256 === undefined ? undefined : assertHex(input.expectedCurrentSha256, 'expectedCurrentSha256', [64]);
  const { manifest, dir } = await loadVerifiedSnapshot(input.snapshotId);
  // Re-validate the target against the CURRENT allowed-directory configuration.
  const target = await resolveAllowedPath(manifest.originalPath, 'originalPath');
  if (target.resolved !== manifest.originalPath) {
    throw new DcToolError('DC_PATH_CHANGED', 'snapshot target now resolves elsewhere (symlink changed); refusing to restore', { stage: 'resolve' });
  }
  const before = await currentContentHash(target.resolved, manifest.kind);
  recordEvidence({ preconditions: { snapshotId: manifest.snapshotId, expectedCurrentSha256: expectedCurrent ?? null, actualCurrentSha256: before } });
  if (expectedCurrent !== undefined && before !== expectedCurrent) {
    throw new DcToolError('DC_HASH_MISMATCH', `current content hash is ${before ?? '(absent)'}, expected ${expectedCurrent}; nothing restored`, {
      stage: 'precondition',
      details: { expectedCurrentSha256: expectedCurrent, actualCurrentSha256: before },
    });
  }
  // Preserve divergent current data before replacing it.
  let preRestoreSnapshotId: string | null = null;
  if (before !== null && before !== manifest.contentSha256) {
    const collected = await collect(target.resolved, dcStateDirectory());
    if (collected) preRestoreSnapshotId = (await writeSnapshot(target.resolved, `pre-restore of ${manifest.snapshotId}`, collected)).snapshotId;
  }
  const parent = path.dirname(target.resolved);
  const suffix = crypto.randomBytes(6).toString('hex');
  const staging = path.join(parent, `.${path.basename(target.resolved)}.dc-restore-${suffix}`);
  const displaced = path.join(parent, `.${path.basename(target.resolved)}.dc-displaced-${suffix}`);
  try {
    await materialize(manifest, dir, staging);
    const staged = await collect(staging, dcStateDirectory());
    const stagedHash = staged ? (manifest.kind === 'file' ? staged.entries[0].sha256! : treeContentHash(staged.entries)) : null;
    if (stagedHash !== manifest.contentSha256) throw new DcToolError('DC_SNAPSHOT_INVALID', 'staged restore does not reproduce the snapshot content', { stage: 'commit' });
    // Guard again right before the swap.
    if ((await currentContentHash(target.resolved, manifest.kind)) !== before) {
      throw new DcToolError('DC_PATH_CHANGED', 'target changed during restore; not overwritten', { stage: 'commit' });
    }
    if (manifest.kind === 'file' || before === null) {
      await fsp.rename(staging, target.resolved);
    } else {
      await fsp.rename(target.resolved, displaced);
      try {
        await fsp.rename(staging, target.resolved);
      } catch (error) {
        await fsp.rename(displaced, target.resolved);
        throw error;
      }
      await fsp.rm(displaced, { recursive: true, force: true });
    }
  } catch (error) {
    await fsp.rm(staging, { recursive: true, force: true });
    throw error;
  }
  const after = await currentContentHash(target.resolved, manifest.kind);
  if (after !== manifest.contentSha256) {
    throw new DcToolError('DC_INTERNAL_ERROR', 'post-restore content hash does not match the snapshot', { stage: 'observe' });
  }
  recordEvidence({ results: { beforeSha256: before, afterSha256: after, preRestoreSnapshotId } });
  return { snapshotId: manifest.snapshotId, target: target.resolved, kind: manifest.kind, beforeSha256: before, afterSha256: after, preRestoreSnapshotId };
}
