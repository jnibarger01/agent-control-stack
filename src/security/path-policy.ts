/**
 * Shared workspace/path-policy kernel.
 *
 * Filesystem validation remains implemented by the existing canonical validator
 * so this seam can be adopted incrementally without duplicating security logic.
 * Privileged consumers should import this module rather than reaching into a
 * tool implementation directly.
 */
import fs from 'node:fs/promises';
import { realpath } from 'node:fs';
import { promisify } from 'node:util';

const realpathNative = promisify(realpath.native) as (p: string) => Promise<string>;
import path from 'node:path';
import { validatePath as validateCanonicalPath } from '../tools/filesystem.js';

export const validateWorkspacePath = validateCanonicalPath;

export async function validateWorkspaceDirectory(requestedPath: string): Promise<string> {
  const resolved = await validateCanonicalPath(requestedPath);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${requestedPath}`);
  }
  return resolved;
}

export interface PathAuthorizationResult {
  ok: boolean;
  canonical?: string;
  reason?: string;
}

function pathIsWithinRoot(candidate: string, root: string): boolean {
  // Case-sensitive compare: authorization must not treat /Home and /home as equal.
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * Canonicalizes `requestedPath` (symlinks fully resolved with
 * fs.realpath.native) and authorizes it against `allowedRoots`.
 *
 * Rejects:
 *  - traversal outside every allowed root (after resolution),
 *  - symlink escapes: a link inside a root whose target resolves outside,
 *  - non-canonical case tricks (comparison is case-sensitive).
 *
 * Never throws for policy rejections; returns {ok:false, reason} instead.
 */
export async function canonicalizeAndAuthorizePath(
  requestedPath: string,
  allowedRoots: readonly string[],
): Promise<PathAuthorizationResult> {
  if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
    return { ok: false, reason: 'requested path must be a non-empty string' };
  }
  if (!path.isAbsolute(requestedPath)) {
    return { ok: false, reason: `requested path is not absolute: ${requestedPath}` };
  }
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    return { ok: false, reason: 'at least one allowed root is required' };
  }
  for (const root of allowedRoots) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) {
      return { ok: false, reason: `allowed root is not absolute: ${String(root)}` };
    }
  }

  let canonical: string;
  try {
    // fs.realpath.native resolves ALL symlinks in the path; the returned
    // target is what the kernel will actually touch.
    canonical = await realpathNative(requestedPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // The final component may not exist yet (writes). Resolve the deepest
      // existing ancestor and rejoin the remaining lexical tail.
      const resolvedAncestor = await resolveExistingAncestor(requestedPath);
      if (resolvedAncestor === undefined) {
        return { ok: false, reason: `path cannot be resolved: ${requestedPath}` };
      }
      canonical = resolvedAncestor;
    } else {
      return { ok: false, reason: `path resolution failed (${code ?? 'error'}): ${requestedPath}` };
    }
  }

  const normalizedRoots = allowedRoots.map((root) => path.resolve(root));
  const within = normalizedRoots.some((root) => pathIsWithinRoot(canonical, root));
  if (!within) {
    return {
      ok: false,
      reason: `canonical path '${canonical}' escapes all allowed roots [${normalizedRoots.join(', ')}] (symlink or traversal escape)`,
    };
  }
  return { ok: true, canonical };
}

async function resolveExistingAncestor(requestedPath: string): Promise<string | undefined> {
  let current = path.resolve(requestedPath);
  const tail: string[] = [];
  while (true) {
    try {
      const resolved = await realpathNative(current);
      return tail.length === 0 ? resolved : path.join(resolved, ...tail);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') return undefined;
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}
