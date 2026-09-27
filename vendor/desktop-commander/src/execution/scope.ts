import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validatePath } from '../tools/filesystem.js';
import { configManager } from '../config-manager.js';
import { DcToolError, toDcError } from './errors.js';

/**
 * Mechanical scope helpers shared by the execution tools. These reuse Desktop
 * Commander's existing allowed-directory enforcement (validatePath: symlinks
 * resolved before the allowed-directory comparison) and blockedCommands
 * configuration. They enforce DC's own mechanical limits only; they are not an
 * authorization decision (ACS decides).
 */

export interface ResolvedPath {
  requested: string;
  resolved: string;
}

/** Resolve a caller path through validatePath, mapping failures onto DC codes. */
export async function resolveAllowedPath(requested: unknown, field = 'path'): Promise<ResolvedPath> {
  if (typeof requested !== 'string' || requested.length === 0 || requested.includes('\0')) {
    throw new DcToolError('DC_INVALID_ARGUMENT', `${field} must be a non-empty string without NUL`, { stage: 'validate' });
  }
  try {
    return { requested, resolved: await validatePath(requested) };
  } catch (error) {
    throw toDcError(error, 'resolve');
  }
}

export async function resolveAllowedDirectory(requested: unknown, field = 'cwd'): Promise<ResolvedPath> {
  const result = await resolveAllowedPath(requested, field);
  let stat;
  try {
    stat = await fs.stat(result.resolved);
  } catch (error) {
    throw toDcError(error, 'resolve');
  }
  if (!stat.isDirectory()) {
    throw new DcToolError('DC_INVALID_ARGUMENT', `${field} is not a directory: ${requested}`, { stage: 'resolve' });
  }
  return result;
}

/** Desktop Commander's private state directory (same rule as the session store). */
export function dcStateDirectory(): string {
  const configured = process.env.DESKTOP_COMMANDER_STATE_DIR;
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.desktop-commander');
}

/**
 * Mechanical blockedCommands check for an argv executable. Fails closed if the
 * configuration cannot be read (mirrors CommandManager.validateCommand).
 */
export async function assertExecutableNotBlocked(executable: string): Promise<void> {
  let blocked: string[];
  try {
    const config = await configManager.getConfig();
    blocked = Array.isArray(config.blockedCommands) ? config.blockedCommands : [];
  } catch (error) {
    throw new DcToolError('DC_SUBSYSTEM_UNAVAILABLE', 'command restrictions could not be loaded; refusing to execute', { stage: 'validate', cause: error });
  }
  const base = path.basename(executable).replace(/\.(exe|cmd|bat|com)$/i, '');
  if (blocked.includes(base) || blocked.includes(executable)) {
    throw new DcToolError('DC_COMMAND_FORBIDDEN', `executable is blocked by Desktop Commander blockedCommands: ${base}`, {
      stage: 'validate',
      ruleId: 'config.blockedCommands',
    });
  }
}

/**
 * Canonical target of a resolved executable (all symlinks followed). Callers
 * check the blocklist against this path and spawn this path, so a symlink
 * alias (e.g. /tmp/safe-name -> /usr/bin/dd) can neither dodge the check nor
 * be re-pointed between the check and spawn().
 */
export async function realExecutable(executable: string): Promise<string> {
  try {
    return await fs.realpath(executable);
  } catch (error) {
    throw new DcToolError('DC_COMMAND_NOT_FOUND', `executable could not be resolved: ${executable}`, { stage: 'resolve', cause: error });
  }
}

/** Resolve an executable like execvp would (no shell). Returns null if not found. */
export async function whichExecutable(executable: string, baseDir?: string): Promise<string | null> {
  if (executable.includes('/') || executable.includes('\\')) {
    // A relative executable path is resolved against the command's cwd,
    // exactly as the spawned process will see it.
    const candidate = path.resolve(baseDir ?? process.cwd(), executable);
    try {
      await fs.access(candidate, fsConstants.X_OK);
      if (!(await fs.stat(candidate)).isFile()) return null;
      return candidate;
    } catch {
      return null;
    }
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, executable);
    try {
      await fs.access(candidate, fsConstants.X_OK);
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // keep searching PATH
    }
  }
  return null;
}

export function assertHex(value: unknown, field: string, lengths: readonly number[]): string {
  if (typeof value !== 'string' || !/^[a-f0-9]+$/.test(value) || !lengths.includes(value.length)) {
    throw new DcToolError('DC_INVALID_ARGUMENT', `${field} must be a lowercase hex digest of length ${lengths.join(' or ')}`, { stage: 'validate' });
  }
  return value;
}
