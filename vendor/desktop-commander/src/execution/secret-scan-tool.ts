import fs from 'node:fs/promises';
import { DcToolError } from './errors.js';
import { resolveAllowedPath } from './scope.js';
import { scanText, type SecretFinding } from './secret-scan.js';
import { sha256Hex } from './context.js';

/**
 * secret_scan tool: text | file | diff targets. Returns detector ids,
 * categories and locations only — never raw secret values. File targets are
 * resolved inside the allowed directories and bounded in size. For diffs only
 * ADDED lines are scanned (what the patch would introduce).
 */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/**
 * Keeps only added-line content (line numbering preserved). Inside a hunk,
 * EVERY '+' line is content, including one whose text itself starts with
 * '++' (encoded as '+++…'); only a '+++ ' line directly after a '--- ' line
 * outside a hunk is a file header. Hunk extents come from the @@ counts.
 */
function addedLinesOnly(patch: string): string {
  const lines = patch.split('\n');
  const out: string[] = [];
  let oldLeft = 0;
  let newLeft = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/\r$/, '');
    const inHunk = oldLeft > 0 || newLeft > 0;
    if (inHunk) {
      if (line.startsWith('\\')) { out.push(''); continue; }
      const op = line[0];
      if (op === '+') { newLeft -= 1; out.push(line.slice(1)); continue; }
      if (op === '-') { oldLeft -= 1; out.push(''); continue; }
      oldLeft -= 1;
      newLeft -= 1;
      out.push('');
      continue;
    }
    const header = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (header) {
      oldLeft = header[1] === undefined ? 1 : Number(header[1]);
      newLeft = header[2] === undefined ? 1 : Number(header[2]);
      out.push('');
      continue;
    }
    const isFileHeader = line.startsWith('+++ ') && (lines[i - 1] ?? '').startsWith('--- ');
    // Outside any hunk (headerless fragments), still scan '+' lines.
    out.push(line.startsWith('+') && !isFileHeader ? line.slice(1) : '');
  }
  return out.join('\n');
}

export interface SecretScanInput {
  target: 'text' | 'file' | 'diff';
  text?: string;
  path?: string;
  patch?: string;
}

export async function secretScan(input: SecretScanInput) {
  let text: string;
  let subject: Record<string, unknown>;
  if (input.target === 'text') {
    if (typeof input.text !== 'string') throw new DcToolError('DC_INVALID_ARGUMENT', 'text is required for target=text', { stage: 'validate' });
    if (Buffer.byteLength(input.text) > MAX_TEXT_BYTES) throw new DcToolError('DC_INVALID_ARGUMENT', `text exceeds ${MAX_TEXT_BYTES} bytes`, { stage: 'validate' });
    text = input.text;
    subject = { target: 'text', bytes: Buffer.byteLength(text) };
  } else if (input.target === 'file') {
    const resolved = await resolveAllowedPath(input.path, 'path');
    const stat = await fs.stat(resolved.resolved).catch((error) => { throw new DcToolError('DC_PATH_NOT_FOUND', `cannot stat ${input.path}`, { stage: 'resolve', errno: error.code }); });
    if (!stat.isFile()) throw new DcToolError('DC_INVALID_ARGUMENT', 'path must be a regular file', { stage: 'resolve' });
    if (stat.size > MAX_FILE_BYTES) throw new DcToolError('DC_INVALID_ARGUMENT', `file exceeds the ${MAX_FILE_BYTES}-byte scan bound`, { stage: 'validate' });
    const bytes = await fs.readFile(resolved.resolved);
    text = bytes.toString('utf8');
    subject = { target: 'file', path: resolved.resolved, bytes: bytes.length, sha256: sha256Hex(bytes) };
  } else if (input.target === 'diff') {
    if (typeof input.patch !== 'string') throw new DcToolError('DC_INVALID_ARGUMENT', 'patch is required for target=diff', { stage: 'validate' });
    if (Buffer.byteLength(input.patch) > MAX_TEXT_BYTES) throw new DcToolError('DC_INVALID_ARGUMENT', `patch exceeds ${MAX_TEXT_BYTES} bytes`, { stage: 'validate' });
    // Keep line numbering aligned with the patch; blank out non-added lines.
    text = addedLinesOnly(input.patch);
    subject = { target: 'diff', bytes: Buffer.byteLength(input.patch), scanned: 'added_lines_only' };
  } else {
    throw new DcToolError('DC_INVALID_ARGUMENT', 'target must be text, file, or diff', { stage: 'validate' });
  }
  const findings: SecretFinding[] = scanText(text);
  const byCategory: Record<string, number> = {};
  for (const f of findings) byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
  return {
    schema: 'dc.secret-scan.v1',
    subject,
    clean: findings.length === 0,
    findingCount: findings.length,
    byCategory,
    findings: findings.slice(0, 500),
    findingsTruncated: findings.length > 500,
    redaction: 'values are never returned; locations are 1-based line/column',
    notice: 'Defence-in-depth preflight only; not an authorization decision.',
  };
}
