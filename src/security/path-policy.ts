/**
 * Shared workspace/path-policy kernel.
 *
 * Filesystem validation remains implemented by the existing canonical validator
 * so this seam can be adopted incrementally without duplicating security logic.
 * Privileged consumers should import this module rather than reaching into a
 * tool implementation directly.
 */
import fs from 'node:fs/promises';
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
