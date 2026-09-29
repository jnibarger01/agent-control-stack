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
 *     env dirs, common secret stores, JC_FS_DENIED_ROOTS) or be a credential
 *     path (credential-paths.ts, which mirrors ACS's canonical pattern).
 * With no JC_FS_ROOTS configured every filesystem tool fails closed.
 *
 * Time-of-check/time-of-use: every file or directory is opened once with
 * O_NOFOLLOW, and the path of the inode actually opened (/proc/self/fd/N) is
 * contained again before a byte is read. All reads go through that
 * descriptor, so swapping a validated path for a symlink between the check
 * and the read is refused rather than followed. Off Linux, where /proc is
 * unavailable, the descriptor's (dev, ino) must match the checked realpath.
 *
 * Memory is bounded before reading, not after: text is streamed through the
 * descriptor with a byte cap, images and documents are refused above a size
 * limit instead of being loaded and truncated.
 */
import { existsSync, realpathSync, type Stats } from 'node:fs';
import fs, { constants as fsConstants, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isBinaryFile } from 'isbinaryfile';
import { DocxFileHandler } from '../utils/files/docx.js';
import { ExcelFileHandler } from '../utils/files/excel.js';
import { ImageFileHandler } from '../utils/files/image.js';
import { PdfFileHandler } from '../utils/files/pdf.js';
import { isCredentialPath } from './credential-paths.js';
import { IntegrationError } from './integrations.js';

/** Runtime output caps (argument limits live in the manifest schemas). */
export const JC_FS_RUNTIME_LIMITS = Object.freeze({
  defaultReadLines: 1000,
  maxListDepth: 5,
  maxListEntries: 2000,
  /** Largest text content one read returns; longer content is cut and flagged. */
  maxReadBytes: 1024 * 1024,
  /** Largest image returned (raw bytes; base64 stays under maxReadBytes * 4/3). */
  maxImageBytes: 768 * 1024,
  /** Largest PDF / DOCX / spreadsheet parsed (their parsers load the whole file). */
  maxDocumentBytes: 20 * 1024 * 1024,
  /** Above this size a text read does not scan the whole file to count lines. */
  maxLineCountBytes: 64 * 1024 * 1024,
  chunkBytes: 64 * 1024,
});

export interface JcFsPolicy {
  readonly roots: readonly string[];
  readonly deniedRoots: readonly string[];
}

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

const PROC_FD = process.platform === 'linux' && existsSync('/proc/self/fd');
const OPEN_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;

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

/** Predicate for denied locations; resolves the denied roots once per call site. */
function deniedMatcher(policy: JcFsPolicy): (real: string) => boolean {
  const denied = policy.deniedRoots.map(realpathOrSelf);
  return (real) => denied.some((root) => isInside(root, real)) || isCredentialPath(real);
}

/**
 * Per-walk containment guard for tools that enumerate many paths (list,
 * search). Roots and denied roots are resolved once; `isDenied` is the same
 * denied-root / credential-path predicate read_file and list_directory use,
 * and `isContainedReal` is assertContainedReal as a predicate.
 */
export interface JcWalkGuard {
  isDenied(candidate: string): boolean;
  isContainedReal(real: string): boolean;
}

export function jcWalkGuard(policy: JcFsPolicy): JcWalkGuard {
  const roots = policy.roots.map(realpathOrSelf);
  const isDenied = deniedMatcher(policy);
  return {
    isDenied,
    isContainedReal: (real) => roots.some((root) => isInside(root, real)) && !isDenied(real),
  };
}

/** The roots / denied / credential checks on an already-resolved path. */
function assertContainedReal(real: string, policy: JcFsPolicy): void {
  if (!policy.roots.map(realpathOrSelf).some((root) => isInside(root, real))) {
    throw new IntegrationError('path_not_allowed', 'path is outside the configured filesystem roots');
  }
  if (deniedMatcher(policy)(real)) {
    throw new IntegrationError('path_denied', 'path is a protected credential or configuration location');
  }
}

/**
 * Contain one requested path. Returns its realpath. Throws IntegrationError:
 * fs_roots_unconfigured, invalid_argument, not_found, permission_denied,
 * path_not_allowed, path_denied.
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
    throw fsError(error, requested);
  }
  assertContainedReal(real, policy);
  return real;
}

function fsError(error: unknown, requested: unknown): IntegrationError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return new IntegrationError('not_found', `no such file or directory: ${String(requested)}`);
  if (code === 'EACCES' || code === 'EPERM') return new IntegrationError('permission_denied', `permission denied: ${String(requested)}`);
  if (code === 'ELOOP') return new IntegrationError('path_not_allowed', 'path changed to a symlink during access');
  return new IntegrationError('read_failed', `cannot access path: ${String(requested)}`);
}

export interface OpenedPath {
  handle: FileHandle;
  /** Path of the inode actually opened (re-contained). */
  real: string;
  stats: Stats;
  /** A path that refers to exactly this open inode (for parsers that take a path). */
  fdPath: string;
}

let afterContainHook: ((checked: string) => Promise<void> | void) | undefined;

/**
 * Test-only: run `hook` between the containment check and the open, so tests
 * can deterministically swap the checked path (the race this module closes).
 */
export function setJcFsRaceHookForTests(hook: typeof afterContainHook): void {
  afterContainHook = hook;
}

/** Contain, open once without following symlinks, and re-contain what was opened. */
export async function openContained(requested: unknown, policy: JcFsPolicy): Promise<OpenedPath> {
  const checked = containJcPath(requested, policy);
  if (afterContainHook) await afterContainHook(checked);
  let handle: FileHandle;
  try {
    handle = await fs.open(checked, OPEN_FLAGS);
  } catch (error) {
    throw fsError(error, requested);
  }
  try {
    const stats = await handle.stat();
    let real = checked;
    let fdPath = checked;
    if (PROC_FD) {
      fdPath = `/proc/self/fd/${handle.fd}`;
      real = await fs.readlink(fdPath);
      if (real.endsWith(' (deleted)')) throw new IntegrationError('not_found', `no such file or directory: ${String(requested)}`);
      assertContainedReal(real, policy);
    } else {
      const now = await fs.stat(checked);
      if (now.dev !== stats.dev || now.ino !== stats.ino) {
        throw new IntegrationError('path_not_allowed', 'path changed during access');
      }
    }
    return { handle, real, stats, fdPath };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error instanceof IntegrationError ? error : fsError(error, requested);
  }
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

/** readdir through a no-follow descriptor, so a directory swapped for a symlink is not listed. */
export async function readdirNoFollow(dir: string): Promise<string[]> {
  if (!PROC_FD) return fs.readdir(dir);
  const handle = await fs.open(dir, OPEN_FLAGS | fsConstants.O_DIRECTORY);
  try {
    return await fs.readdir(`/proc/self/fd/${handle.fd}`);
  } finally {
    await handle.close();
  }
}

export async function listDirectory(args: Record<string, unknown>, policy: JcFsPolicy): Promise<Record<string, unknown>> {
  const opened = await openContained(args.path, policy);
  const root = opened.real;
  const isDirectory = opened.stats.isDirectory();
  await opened.handle.close();
  if (!isDirectory) throw new IntegrationError('not_a_directory', `not a directory: ${String(args.path)}`);
  const depth = typeof args.depth === 'number' ? Math.min(args.depth, JC_FS_RUNTIME_LIMITS.maxListDepth) : 1;

  const isDenied = deniedMatcher(policy);
  const entries: JcDirectoryEntry[] = [];
  let truncated = false;
  const walk = async (dir: string, level: number): Promise<void> => {
    let names: string[];
    try {
      names = (await readdirNoFollow(dir)).sort((a, b) => a.localeCompare(b));
    } catch {
      return; // unreadable (or swapped) subdirectory: skip, do not fail the whole listing
    }
    for (const name of names) {
      if (entries.length >= JC_FS_RUNTIME_LIMITS.maxListEntries) {
        truncated = true;
        return;
      }
      const full = path.join(dir, name);
      // Denied locations and credential files inside a root are omitted
      // entirely: not even their names or sizes are disclosed.
      if (isDenied(full)) continue;
      let stats;
      try {
        stats = await fs.lstat(full);
      } catch {
        continue;
      }
      const type = entryType(stats);
      entries.push({ name, path: path.relative(root, full), type, ...(type === 'file' ? { size: stats.size } : {}) });
      // Symlinked directories are listed but never followed (no root escape).
      if (type === 'directory' && level < depth) await walk(full, level + 1);
    }
  };
  await walk(root, 1);
  return { path: root, depth, count: entries.length, truncated, entries };
}

type FileKind = 'text' | 'binary' | 'image' | 'pdf' | 'docx' | 'excel';

const imageHandler = new ImageFileHandler();
const pdfHandler = new PdfFileHandler();
const docxHandler = new DocxFileHandler();
const excelHandler = new ExcelFileHandler();

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
};

/** Classify by extension (documents, images) and then by content read from the descriptor. */
async function classify(opened: OpenedPath): Promise<FileKind> {
  if (docxHandler.canHandle(opened.real)) return 'docx';
  if (pdfHandler.canHandle(opened.real)) return 'pdf';
  if (excelHandler.canHandle(opened.real)) return 'excel';
  if (imageHandler.canHandle(opened.real)) return 'image';
  const sample = Buffer.alloc(Math.min(4096, opened.stats.size));
  const { bytesRead } = sample.length ? await opened.handle.read(sample, 0, sample.length, 0) : { bytesRead: 0 };
  return bytesRead > 0 && (await isBinaryFile(sample, bytesRead)) ? 'binary' : 'text';
}

/** Count lines through the descriptor (bounded memory); undefined above maxLineCountBytes. */
async function countLinesFd(handle: FileHandle, size: number): Promise<number | undefined> {
  if (size > JC_FS_RUNTIME_LIMITS.maxLineCountBytes) return undefined;
  if (size === 0) return 0;
  const buffer = Buffer.alloc(JC_FS_RUNTIME_LIMITS.chunkBytes);
  let newlines = 0;
  let last = 0;
  for (let position = 0; position < size;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    const chunk = buffer.subarray(0, bytesRead);
    for (let index = chunk.indexOf(0x0a); index !== -1; index = chunk.indexOf(0x0a, index + 1)) newlines += 1;
    last = chunk[bytesRead - 1]!;
    position += bytesRead;
  }
  return last === 0x0a ? newlines : newlines + 1;
}

export async function getFileInfo(args: Record<string, unknown>, policy: JcFsPolicy): Promise<Record<string, unknown>> {
  const opened = await openContained(args.path, policy);
  try {
    const { stats } = opened;
    let isSymlink = false;
    try {
      isSymlink = (await fs.lstat(String(args.path))).isSymbolicLink();
    } catch {
      // informational only
    }
    const base = {
      path: opened.real,
      requestedPath: args.path,
      type: stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other',
      isSymlink,
      size: stats.size,
      created: stats.birthtime.toISOString(),
      modified: stats.mtime.toISOString(),
      accessed: stats.atime.toISOString(),
      permissions: (stats.mode & 0o777).toString(8).padStart(3, '0'),
    };
    if (!stats.isFile()) return base;
    const fileType = await classify(opened);
    const lineCount = fileType === 'text' ? await countLinesFd(opened.handle, stats.size) : undefined;
    return { ...base, fileType, ...(lineCount !== undefined ? { lineCount } : {}) };
  } finally {
    await opened.handle.close();
  }
}

interface TextWindow {
  content: string;
  returnedLines: number;
  truncatedBytes: boolean;
  /** Whether content exists beyond the returned window (end or, for a tail, start). */
  hasMore: boolean;
}

/** Drop one trailing newline: windows are returned as lines joined by "\n" (DC's format). */
function joinWindow(buffer: Buffer): string {
  const text = buffer.toString('utf8');
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

function countLines(text: string): number {
  return text === '' ? 0 : text.split('\n').length;
}

/** Lines [offset, offset + length) streamed through the descriptor, at most maxReadBytes kept. */
async function readHead(handle: FileHandle, size: number, offset: number, length: number): Promise<TextWindow> {
  const { chunkBytes, maxReadBytes } = JC_FS_RUNTIME_LIMITS;
  const buffer = Buffer.alloc(chunkBytes);
  const kept: Buffer[] = [];
  let keptBytes = 0;
  let truncatedBytes = false;
  let line = 0;
  let position = 0;
  const end = offset + length;
  const keep = (slice: Buffer) => {
    if (slice.length === 0) return;
    const room = maxReadBytes - keptBytes;
    if (room <= 0) {
      truncatedBytes = true;
      return;
    }
    const part = slice.length > room ? slice.subarray(0, room) : slice;
    if (part.length < slice.length) truncatedBytes = true;
    kept.push(Buffer.from(part));
    keptBytes += part.length;
  };
  while (position < size && line < end) {
    const { bytesRead } = await handle.read(buffer, 0, chunkBytes, position);
    if (bytesRead === 0) break;
    const chunk = buffer.subarray(0, bytesRead);
    let start = 0;
    while (start < bytesRead && line < end) {
      const newline = chunk.indexOf(0x0a, start);
      const stop = newline === -1 ? bytesRead : newline + 1;
      if (line >= offset) keep(chunk.subarray(start, stop));
      start = stop;
      if (newline !== -1) line += 1;
    }
    // Only what was scanned counts as consumed, so hasMore sees unread bytes.
    position += start;
  }
  const content = joinWindow(Buffer.concat(kept));
  return { content, returnedLines: countLines(content), truncatedBytes, hasMore: position < size };
}

/** The last `count` lines, read backwards through the descriptor, at most maxReadBytes kept. */
async function readTail(handle: FileHandle, size: number, count: number): Promise<TextWindow> {
  const { chunkBytes, maxReadBytes } = JC_FS_RUNTIME_LIMITS;
  const chunks: Buffer[] = [];
  let collected = 0;
  let separators = 0;
  let position = size;
  let truncatedBytes = false;
  // `count` separators before the end means `count` complete lines are held.
  // A newline that is the file's last byte ends the last line; it is not one.
  while (position > 0 && separators < count) {
    if (collected >= maxReadBytes) {
      truncatedBytes = true; // one enormous line: stop reading, return its tail
      break;
    }
    const readSize = Math.min(chunkBytes, position);
    position -= readSize;
    const chunk = Buffer.alloc(readSize);
    await handle.read(chunk, 0, readSize, position);
    for (let index = 0; index < readSize; index += 1) {
      if (chunk[index] === 0x0a && position + index !== size - 1) separators += 1;
    }
    chunks.unshift(chunk);
    collected += readSize;
  }
  const lines = joinWindow(Buffer.concat(chunks)).split('\n');
  const hasMore = position > 0 || lines.length > count;
  let content = lines.slice(Math.max(0, lines.length - count)).join('\n');
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length > maxReadBytes) {
    content = bytes.subarray(bytes.length - maxReadBytes).toString('utf8');
    truncatedBytes = true;
  }
  return { content, returnedLines: countLines(content), truncatedBytes, hasMore };
}

async function readOne(requested: unknown, offset: number, length: number, policy: JcFsPolicy): Promise<Record<string, unknown>> {
  const opened = await openContained(requested, policy);
  try {
    const { stats, real } = opened;
    if (stats.isDirectory()) throw new IntegrationError('is_a_directory', `is a directory (use list_directory): ${String(requested)}`);
    if (!stats.isFile()) throw new IntegrationError('not_a_file', `not a regular file: ${String(requested)}`);
    const kind = await classify(opened);
    const common = { path: real, offset, size: stats.size };
    const tooLarge = (limit: number, what: string) =>
      new IntegrationError('file_too_large', `${what} is ${stats.size} bytes; the limit is ${limit} bytes`);

    if (kind === 'image') {
      if (stats.size > JC_FS_RUNTIME_LIMITS.maxImageBytes) throw tooLarge(JC_FS_RUNTIME_LIMITS.maxImageBytes, 'image');
      const bytes = await opened.handle.readFile();
      return {
        ...common,
        mimeType: IMAGE_MIME[path.extname(real).toLowerCase()] ?? 'application/octet-stream',
        encoding: 'base64',
        content: bytes.toString('base64'),
        isImage: true,
      };
    }
    if (kind === 'binary') {
      return {
        ...common,
        mimeType: 'application/octet-stream',
        encoding: 'utf8',
        content: 'Binary file: content is not returned by read_file.',
        isBinary: true,
      };
    }
    if (kind === 'pdf' || kind === 'docx' || kind === 'excel') {
      if (stats.size > JC_FS_RUNTIME_LIMITS.maxDocumentBytes) throw tooLarge(JC_FS_RUNTIME_LIMITS.maxDocumentBytes, kind);
      return { ...common, ...(await readDocument(kind, opened.fdPath, real, offset, length)) };
    }

    const window = offset >= 0
      ? await readHead(opened.handle, stats.size, offset, length)
      : await readTail(opened.handle, stats.size, Math.min(-offset, length));
    const totalLines = await countLinesFd(opened.handle, stats.size);
    return {
      ...common,
      mimeType: 'text/plain',
      encoding: 'utf8',
      content: window.content,
      returnedLines: window.returnedLines,
      ...(totalLines !== undefined ? { totalLines } : {}),
      hasMore: window.hasMore,
      ...(window.truncatedBytes ? { truncatedBytes: true } : {}),
    };
  } catch (error) {
    if (error instanceof IntegrationError) throw error;
    throw fsError(error, requested);
  } finally {
    await opened.handle.close();
  }
}

/**
 * Parse a document through the verified descriptor path. PDF text lives in
 * metadata.pages in Desktop Commander's handler; it is projected into
 * `content` (and `pages`) here so a successful read is never empty.
 */
async function readDocument(kind: 'pdf' | 'docx' | 'excel', fdPath: string, real: string, offset: number, length: number): Promise<Record<string, unknown>> {
  const handler = kind === 'pdf' ? pdfHandler : kind === 'docx' ? docxHandler : excelHandler;
  const result = await handler.read(fdPath, { offset: Math.max(0, offset), length, includeStatusMessage: false });
  if (result.metadata?.error) {
    throw new IntegrationError('read_failed', `could not parse ${kind}: ${String(result.metadata.errorMessage ?? 'unknown error')}`);
  }
  const cap = (text: string) => {
    const bytes = Buffer.from(text, 'utf8');
    return bytes.length > JC_FS_RUNTIME_LIMITS.maxReadBytes
      ? { content: bytes.subarray(0, JC_FS_RUNTIME_LIMITS.maxReadBytes).toString('utf8'), truncatedBytes: true }
      : { content: text };
  };
  if (kind === 'pdf') {
    const pages = ((result.metadata?.pages ?? []) as Array<{ pageNumber: number; text: string }>);
    return {
      mimeType: 'application/pdf',
      encoding: 'utf8',
      ...cap(pages.map((page) => `<!-- page ${page.pageNumber} -->\n${page.text}`).join('\n\n')),
      totalPages: result.metadata?.totalPages,
      pages: pages.map((page) => page.pageNumber),
    };
  }
  // Parsers that echo their input path would otherwise show /proc/self/fd/N.
  const text = (typeof result.content === 'string' ? result.content : result.content.toString('utf8')).split(fdPath).join(real);
  return { mimeType: result.mimeType, encoding: 'utf8', ...cap(text) };
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
