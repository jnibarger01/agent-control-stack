/**
 * Bounded filesystem mutations (fs.write). ACS must have approved the exact
 * arguments before the managed server reaches these handlers. Containment is
 * checked again here. Symlinks are never written through.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { containJcPath, type JcFsPolicy } from './filesystem.js';
import { IntegrationError } from './integrations.js';

const MAX_WRITE_BYTES = 256 * 1024;
const MAX_EDIT_BYTES = 1024 * 1024;

async function destination(requested: unknown, policy: JcFsPolicy): Promise<string> {
  if (typeof requested !== 'string' || !path.isAbsolute(requested)) {
    throw new IntegrationError('invalid_argument', 'path must be an absolute path');
  }
  const parent = path.dirname(requested);
  const parentReal = containJcPath(parent, policy);
  const base = path.basename(requested);
  if (!base || base === '.' || base === '..') throw new IntegrationError('invalid_argument', 'path basename is invalid');
  const dest = path.join(parentReal, base);
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
  try {
    await fs.lstat(dest);
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new IntegrationError('write_failed', 'cannot inspect destination');
  }
  if (exists && args.overwrite !== true) throw new IntegrationError('already_exists', 'destination exists; pass overwrite true');
  const tmp = path.join(path.dirname(dest), `.jc-write-${randomBytes(6).toString('hex')}`);
  await fs.writeFile(tmp, args.content, { flag: 'wx' });
  try {
    await fs.rename(tmp, dest);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw new IntegrationError('write_failed', error instanceof Error ? error.message : 'rename failed');
  }
  return { path: dest, bytes: Buffer.byteLength(args.content), overwritten: exists };
}

export async function createDirectory(args: Record<string, unknown>, policy: JcFsPolicy): Promise<Record<string, unknown>> {
  const dest = await destination(args.path, policy);
  await fs.mkdir(dest, { recursive: args.recursive === true });
  containJcPath(dest, policy);
  return { path: dest, created: true };
}

export async function moveFile(args: Record<string, unknown>, policy: JcFsPolicy): Promise<Record<string, unknown>> {
  const from = containJcPath(args.from, policy);
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
  await fs.writeFile(file, next);
  return { path: file, bytes: Buffer.byteLength(next) };
}
