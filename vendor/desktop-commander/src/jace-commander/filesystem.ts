/**
 * Jace Commander read-only filesystem handlers (fs.read):
 * list_directory, get_file_info, read_file, read_multiple_files.
 *
 * Shared by the MCP server (server.ts) and, through it, the `jace-commander`
 * CLI, which is an MCP client of /jc/mcp. There is no second implementation.
 *
 * Containment here is Jace Commander's own mechanical check, applied after
 * ACS has already contained the same path against its own roots and signed
 * the exact arguments. Neither layer trusts the other:
 *   - the path must be absolute (the capability binds the exact string);
 *   - its realpath (symlinks resolved) must lie inside a JC_FS_ROOTS root;
 *   - it must not lie inside a denied root (JC state/credential dirs, service
 *     env dirs, common secret stores, JC_FS_DENIED_ROOTS) or look like a
 *     credential file.
 * With no JC_FS_ROOTS configured every filesystem tool fails closed.
 *
 * File content is read by Desktop Commander's proven file handlers
 * (utils/files/*: text windowing, binary detection, images, PDF, Excel, DOCX),
 * but NOT through tools/filesystem.ts: that layer's allow-list comes from
 * Desktop Commander's global config, whose empty default means "allow all".
 */
import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getFileHandler } from '../utils/files/factory.js';
import { IntegrationError } from './integrations.js';

/** Runtime output caps (argument limits live in the manifest schemas). */
export const JC_FS_RUNTIME_LIMITS = Object.freeze({
  defaultReadLines: 1000,
  maxListDepth: 5,
  maxListEntries: 2000,
  /** Largest content one read returns; longer content is cut and flagged. */
  maxReadBytes: 1024 * 1024,
});

export interface JcFsPolicy {
  readonly roots: readonly string[];
  readonly deniedRoots: readonly string[];
}

// Credential-looking basenames are refused even inside an allowed root.
const CREDENTIAL_BASENAME = /^(\.env(\..*)?|.*\.env|\.netrc|\.npmrc|\.pgpass|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\.json)?|.*\.pem|.*\.key)$/i;

/** Denied regardless of roots: JC's own state and common secret/config stores. */
export function defaultDeniedRoots(stateDir: string, home = os.homedir()): string[] {
  return [
    stateDir,
    '/etc/jace-commander',
    ...['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.config/gcloud',
      '.config/desktop-commander-mcp-gateway', '.config/dc-relay', '.desktop-commander']
      .map((relative) => path.join(home, relative)),
  ];
}

function realpathOrSelf(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * Contain one requested path. Returns its realpath. Throws IntegrationError:
 * fs_roots_unconfigured, invalid_argument, not_found, path_not_allowed,
 * path_denied.
 */
export function containJcPath(requested: unknown, policy: JcFsPolicy): string {
  if (policy.roots.length === 0) {
    throw new IntegrationError('fs_roots_unconfigured', 'no filesystem roots configured (set JC_FS_ROOTS); filesystem tools are disabled');
  }
  if (typeof requested !== 'string' || !path.isAbsolute(requested) || requested.includes('\0')) {
    throw new IntegrationError('invalid_argument', 'path must be an absolute path');
  }
  if (requested.split(/[/\\]/).includes('..')) {
    throw new IntegrationError('path_not_allowed', 'path must not contain parent traversal');
  }
  let real: string;
  try {
    real = realpathSync(requested);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new IntegrationError('not_found', `no such file or directory: ${requested}`);
    if (code === 'EACCES' || code === 'EPERM') throw new IntegrationError('permission_denied', `permission denied: ${requested}`);
    throw new IntegrationError('read_failed', `cannot resolve path: ${requested}`);
  }
  const roots = policy.roots.map(realpathOrSelf);
  if (!roots.some((root) => isInside(root, real))) {
    throw new IntegrationError('path_not_allowed', 'path is outside the configured filesystem roots');
  }
  const denied = policy.deniedRoots.map(realpathOrSelf);
  if (denied.some((root) => isInside(root, real)) || CREDENTIAL_BASENAME.test(path.basename(real))) {
    throw new IntegrationError('path_denied', 'path is a protected credential or configuration location');
  }
  return real;
}

type EntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface JcDirectoryEntry {
  name: string;
  /** Path relative to the listed directory. */
  path: string;
  type: EntryType;
  size?: number;
}

function entryType(stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): EntryType {
  if (stats.isSymbolicLink()) return 'symlink';
  if (stats.isDirectory()) return 'directory';
  if (stats.isFile()) return 'file';
  return 'other';
}

export async function listDirectory(args: Record<string, unknown>, policy: JcFsPolicy): Promise<Record<string, unknown>> {
  const root = containJcPath(args.path, policy);
  const depth = typeof args.depth === 'number' ? Math.min(args.depth, JC_FS_RUNTIME_LIMITS.maxListDepth) : 1;
  const rootStats = await fs.stat(root);
  if (!rootStats.isDirectory()) throw new IntegrationError('not_a_directory', `not a directory: ${args.path}`);

  const entries: JcDirectoryEntry[] = [];
  let truncated = false;
  const walk = async (dir: string, level: number): Promise<void> => {
    let names: string[];
    try {
      names = (await fs.readdir(dir)).sort((a, b) => a.localeCompare(b));
    } catch {
      return; // unreadable subdirectory: skip, do not fail the whole listing
    }
    for (const name of names) {
      if (entries.length >= JC_FS_RUNTIME_LIMITS.maxListEntries) {
        truncated = true;
        return;
      }
      const full = path.join(dir, name);
      let stats;
      try {
        stats = await fs.lstat(full);
      } catch {
        continue;
      }
      const type = entryType(stats);
      const relative = path.relative(root, full);
      // Denied locations inside a root are omitted entirely, not just unreadable.
      if (policy.deniedRoots.some((denied) => isInside(realpathOrSelf(denied), full))) continue;
      entries.push({ name, path: relative, type, ...(type === 'file' ? { size: stats.size } : {}) });
      // Symlinked directories are listed but never followed (no root escape).
      if (type === 'directory' && level < depth) await walk(full, level + 1);
    }
  };
  await walk(root, 1);
  return { path: root, depth, count: entries.length, truncated, entries };
}

export async function getFileInfo(args: Record<string, unknown>, policy: JcFsPolicy): Promise<Record<string, unknown>> {
  const real = containJcPath(args.path, policy);
  const lstat = await fs.lstat(String(args.path));
  const stats = await fs.stat(real);
  const base = {
    path: real,
    requestedPath: args.path,
    type: stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other',
    isSymlink: lstat.isSymbolicLink(),
    size: stats.size,
    created: stats.birthtime.toISOString(),
    modified: stats.mtime.toISOString(),
    accessed: stats.atime.toISOString(),
    permissions: (stats.mode & 0o777).toString(8).padStart(3, '0'),
  };
  if (!stats.isFile()) return base;
  const info = await (await getFileHandler(real)).getInfo(real);
  return {
    ...base,
    fileType: info.fileType,
    ...(typeof info.metadata?.lineCount === 'number' ? { lineCount: info.metadata.lineCount } : {}),
  };
}

function countLines(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

async function readOne(requested: unknown, offset: number, length: number, policy: JcFsPolicy): Promise<Record<string, unknown>> {
  const real = containJcPath(requested, policy);
  const stats = await fs.stat(real);
  if (stats.isDirectory()) throw new IntegrationError('is_a_directory', `is a directory (use list_directory): ${requested}`);
  if (!stats.isFile()) throw new IntegrationError('not_a_file', `not a regular file: ${requested}`);

  const handler = await getFileHandler(real);
  let result;
  try {
    result = await handler.read(real, { offset, length, includeStatusMessage: false });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') throw new IntegrationError('permission_denied', `permission denied: ${requested}`);
    throw new IntegrationError('read_failed', `read failed: ${requested}`);
  }
  const isImage = Boolean(result.metadata?.isImage);
  let content = typeof result.content === 'string'
    ? result.content
    : isImage ? result.content.toString('base64') : result.content.toString('utf8');
  let truncatedBytes = false;
  if (Buffer.byteLength(content, 'utf8') > JC_FS_RUNTIME_LIMITS.maxReadBytes) {
    content = Buffer.from(content, 'utf8').subarray(0, JC_FS_RUNTIME_LIMITS.maxReadBytes).toString('utf8');
    truncatedBytes = true;
  }

  const textual = !isImage && !result.metadata?.isBinary && result.mimeType.startsWith('text/');
  const info = textual ? await handler.getInfo(real).catch(() => undefined) : undefined;
  const totalLines = typeof info?.metadata?.lineCount === 'number' ? info.metadata.lineCount : undefined;
  const returnedLines = textual ? countLines(content) : undefined;
  const hasMore = textual && totalLines !== undefined && returnedLines !== undefined
    ? offset >= 0 ? offset + returnedLines < totalLines : returnedLines < totalLines
    : undefined;

  return {
    path: real,
    mimeType: result.mimeType,
    encoding: isImage ? 'base64' : 'utf8',
    content,
    offset,
    ...(returnedLines !== undefined ? { returnedLines } : {}),
    ...(totalLines !== undefined ? { totalLines } : {}),
    ...(hasMore !== undefined ? { hasMore } : {}),
    ...(truncatedBytes ? { truncatedBytes } : {}),
    ...(result.metadata?.isBinary ? { isBinary: true } : {}),
    ...(isImage ? { isImage: true } : {}),
    size: stats.size,
  };
}

export async function readFile(args: Record<string, unknown>, policy: JcFsPolicy): Promise<Record<string, unknown>> {
  const offset = typeof args.offset === 'number' ? args.offset : 0;
  const length = typeof args.length === 'number' ? args.length : JC_FS_RUNTIME_LIMITS.defaultReadLines;
  return readOne(args.path, offset, length, policy);
}

export async function readMultipleFiles(args: Record<string, unknown>, policy: JcFsPolicy): Promise<Record<string, unknown>> {
  const paths = Array.isArray(args.paths) ? args.paths : [];
  if (paths.length === 0) throw new IntegrationError('invalid_argument', 'paths must be a non-empty array');
  const files = [];
  for (const requested of paths) {
    try {
      files.push({ ok: true, ...(await readOne(requested, 0, JC_FS_RUNTIME_LIMITS.defaultReadLines, policy)) });
    } catch (error) {
      if (!(error instanceof IntegrationError)) throw error;
      files.push({ ok: false, path: requested, code: error.code, message: error.message });
    }
  }
  return { count: files.length, failed: files.filter((file) => !file.ok).length, files };
}
