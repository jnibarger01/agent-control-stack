/**
 * Bounded filesystem mutations (fs.write). ACS must have approved the exact
 * arguments before the managed server reaches these handlers. Containment is
 * checked again here. Symlinks are never written through, and nothing under a
 * .git directory can be written: an approved file write must not be able to
 * plant a hook or config that a later unapproved git read would run.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { containJcPath, type JcFsPolicy } from './filesystem.js';
import { IntegrationError } from './integrations.js';

const MAX_WRITE_BYTES = 256 * 1024;
const MAX_EDIT_BYTES = 1024 * 1024;

function refuseGitMetadata(...paths: string[]): void {
  if (paths.some((item) => item.split(/[/\\]/).includes('.git'))) {
    throw new IntegrationError('path_denied', 'git metadata (.git) cannot be modified through filesystem tools');
  }
}

function refuseRoot(target: string, policy: JcFsPolicy): void {
  if (policy.roots.map((root) => path.resolve(root)).includes(path.resolve(target))) {
    throw new IntegrationError('path_denied', 'a configured filesystem root cannot be moved');
  }
}

async function replaceAtomically(dest: string, content: string | Buffer, mode?: number): Promise<void> {
  const tmp = path.join(path.dirname(dest), `.jc-write-${randomBytes(6).toString('hex')}`);
  await fs.writeFile(tmp, content, { flag: 'wx' });
  try {
    // Keep the replaced file's permission bits.
    if (mode !== undefined) await fs.chmod(tmp, mode & 0o7777);
    await fs.rename(tmp, dest);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw new IntegrationError('write_failed', error instanceof Error ? error.message : 'rename failed');
  }
}

async function destination(requested: unknown, policy: JcFsPolicy): Promise<string> {
  if (typeof requested !== 'string' || !path.isAbsolute(requested)) {
    throw new IntegrationError('invalid_argument', 'path must be an absolute path');
  }
  const parent = path.dirname(requested);
  const parentReal = containJcPath(parent, policy);
  const base = path.basename(requested);
  if (!base || base === '.' || base === '..') throw new IntegrationError('invalid_argument', 'path basename is invalid');
  const dest = path.join(parentReal, base);
  refuseGitMetadata(requested, dest);
  try {
    const link = await fs.lstat(dest);
    if (link.isSymbolicLink()) throw new IntegrationError('path_denied', 'refusing to write through a symlink');
    containJcPath(dest, policy);
  } catch (error) {
    if (error instanceof IntegrationError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw new IntegrationError('write_failed', 'cannot inspect destination');
  }
  return dest;
}

export async function writeFile(args: Record<string, unknown>, policy: JcFsPolicy): Promise<Record<string, unknown>> {
  if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > MAX_WRITE_BYTES) {
    throw new IntegrationError('invalid_argument', 'content must be a string of at most 256 KiB');
  }
  const dest = await destination(args.path, policy);
  let exists = false;
  let mode: number | undefined;
  try {
    mode = (await fs.lstat(dest)).mode;
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new IntegrationError('write_failed', 'cannot inspect destination');
  }
  if (exists && args.overwrite !== true) throw new IntegrationError('already_exists', 'destination exists; pass overwrite true');
  if (args.encoding !== undefined && args.encoding !== 'utf8' && args.encoding !== 'base64') {
    throw new IntegrationError('invalid_argument', 'unsupported content encoding');
  }
  const content = args.encoding === 'base64' ? Buffer.from(args.content, 'base64') : args.content;
  if (args.encoding === 'base64' && (content as Buffer).toString('base64') !== args.content) {
    throw new IntegrationError('invalid_argument', 'content must be canonical base64');
  }
  await replaceAtomically(dest, content, mode);
  return { path: dest, bytes: Buffer.byteLength(content), overwritten: exists };
}

export async function createDirectory(args: Record<string, unknown>, policy: JcFsPolicy): Promise<Record<string, unknown>> {
  if (args.recursive === true) return createDirectoryRecursive(args.path, policy);
  const dest = await destination(args.path, policy);
  await fs.mkdir(dest, { recursive: args.recursive === true });
  containJcPath(dest, policy);
  return { path: dest, created: true };
}

/**
 * Recursive creation: contain the nearest existing ancestor, then create each
 * missing component one level at a time, re-containing after every step, so a
 * missing intermediate directory does not fail containment before mkdir runs.
 */
async function createDirectoryRecursive(requested: unknown, policy: JcFsPolicy): Promise<Record<string, unknown>> {
  if (typeof requested !== 'string' || !path.isAbsolute(requested)) {
    throw new IntegrationError('invalid_argument', 'path must be an absolute path');
  }
  refuseGitMetadata(requested);
  const missing: string[] = [];
  let cursor = path.resolve(requested);
  for (;;) {
    try {
      await fs.lstat(cursor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new IntegrationError('write_failed', 'cannot inspect destination');
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new IntegrationError('not_found', 'no existing ancestor');
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  let current = containJcPath(cursor, policy);
  for (const part of missing) {
    const next = path.join(current, part);
    try {
      await fs.mkdir(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new IntegrationError('write_failed', 'cannot create directory');
    }
    current = containJcPath(next, policy);
  }
  return { path: current, created: true };
}

export async function moveFile(args: Record<string, unknown>, policy: JcFsPolicy): Promise<Record<string, unknown>> {
  const from = containJcPath(args.from, policy);
  refuseGitMetadata(String(args.from), from);
  refuseRoot(from, policy);
  const fromStat = await fs.lstat(from);
  if (fromStat.isSymbolicLink()) throw new IntegrationError('path_denied', 'refusing to move a symlink');
  const to = await destination(args.to, policy);
  try {
    await fs.lstat(to);
    throw new IntegrationError('already_exists', 'destination exists');
  } catch (error) {
    if (error instanceof IntegrationError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new IntegrationError('write_failed', 'cannot inspect destination');
  }
  await fs.rename(from, to);
  return { from, to };
}

export async function editBlock(args: Record<string, unknown>, policy: JcFsPolicy): Promise<Record<string, unknown>> {
  if (typeof args.old !== 'string' || typeof args.new !== 'string' || !args.old) {
    throw new IntegrationError('invalid_argument', 'old and new must be strings and old must be non-empty');
  }
  if (Buffer.byteLength(args.old) > 8192 || Buffer.byteLength(args.new) > 8192) {
    throw new IntegrationError('invalid_argument', 'old and new are limited to 8 KiB');
  }
  const file = containJcPath(args.path, policy);
  refuseGitMetadata(String(args.path), file);
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new IntegrationError('invalid_argument', 'edit target must be a regular file');
  if (stat.size > MAX_EDIT_BYTES) throw new IntegrationError('invalid_argument', 'file is larger than 1 MiB');
  const text = await fs.readFile(file, 'utf8');
  const first = text.indexOf(args.old);
  if (first < 0) throw new IntegrationError('not_found', 'old text was not found');
  if (text.indexOf(args.old, first + args.old.length) >= 0) {
    throw new IntegrationError('ambiguous_edit', 'old text matched more than once');
  }
  const next = text.slice(0, first) + args.new + text.slice(first + args.old.length);
  await replaceAtomically(file, next, stat.mode);
  return { path: file, bytes: Buffer.byteLength(next) };
}

/** Refuse root deletion and inspect the whole tree before any removal. */
export async function deleteFile(args: Record<string, unknown>, policy: JcFsPolicy): Promise<Record<string, unknown>> {
  if (typeof args.path !== 'string' || !path.isAbsolute(args.path)) throw new IntegrationError('invalid_argument', 'path must be absolute');
  const target = path.resolve(args.path);
  refuseRoot(target, policy);
  refuseGitMetadata(target);
  // Resolve the parent so a final symlink can be unlinked without following it.
  const parent = containJcPath(path.dirname(target), policy);
  const dest = path.join(parent, path.basename(target));
  const stat = await fs.lstat(dest);
  if (!stat.isSymbolicLink()) containJcPath(dest, policy);
  async function inspect(item: string): Promise<void> {
    refuseGitMetadata(item);
    const st = await fs.lstat(item);
    if (st.isSymbolicLink()) return;
    containJcPath(item, policy);
    if (st.isDirectory()) for (const child of await fs.readdir(item)) await inspect(path.join(item, child));
  }
  if (stat.isDirectory() && args.recursive !== true) throw new IntegrationError('invalid_argument', 'directory deletion requires recursive true');
  if (stat.isDirectory()) await inspect(dest);
  await fs.rm(dest, {recursive: args.recursive === true});
  return {path: dest, deleted: true};
}
