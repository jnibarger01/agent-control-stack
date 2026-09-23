import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DcToolError } from './errors.js';
import { assertHex, resolveAllowedPath } from './scope.js';
import { requireHead } from './git.js';
import { recordEvidence, sha256Hex } from './context.js';

/**
 * apply_patch: hash-guarded, atomic single-file unified-diff application.
 *
 * read pre-image (O_NOFOLLOW) -> sha256 must equal expectedSha256 ->
 * parse + apply fully in memory (strict: context/removals must match exactly)
 * -> write a same-directory temp file (original mode) + fsync ->
 * re-read the target and fail with DC_PATH_CHANGED if it moved/changed ->
 * rename(2) over the target -> fsync directory.
 * No partial writes: the target is only ever replaced by rename.
 */
export interface ApplyPatchInput {
  path: string;
  patch: string;
  expectedSha256: string;
  expectedHeadSha?: string;
}

export interface ApplyPatchResult {
  path: string;
  preSha256: string;
  postSha256: string;
  hunksApplied: number;
  linesAdded: number;
  linesRemoved: number;
  bytesBefore: number;
  bytesAfter: number;
  hunkOffsets: number[];
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: { op: ' ' | '-' | '+'; text: string }[];
  noNewlineOld: boolean;
  noNewlineNew: boolean;
}

const MAX_PATCH_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;

function reject(message: string): never {
  throw new DcToolError('DC_PATCH_REJECTED', message, { stage: 'validate' });
}

export function parseUnifiedDiff(patch: string): Hunk[] {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const hunks: Hunk[] = [];
  let fileHeaders = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('--- ')) {
      if (!lines[i + 1]?.startsWith('+++ ')) reject(`malformed file header at line ${i + 1}`);
      fileHeaders += 1;
      if (fileHeaders > 1) reject('patch touches more than one file; apply_patch patches exactly one target');
      i += 2;
      continue;
    }
    if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('new file mode') || line.startsWith('deleted file mode')
      || line.startsWith('old mode') || line.startsWith('new mode') || line.startsWith('similarity index') || line.startsWith('rename ')) {
      if (line.startsWith('new file mode') || line.startsWith('deleted file mode') || line.startsWith('rename ')) {
        reject('file creation, deletion and renames are not supported by apply_patch');
      }
      i += 1;
      continue;
    }
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!header) {
      if (hunks.length === 0 && line.trim() === '') { i += 1; continue; }
      reject(`unexpected line ${i + 1} outside a hunk: ${JSON.stringify(line.slice(0, 80))}`);
    }
    const hunk: Hunk = {
      oldStart: Number(header[1]),
      oldCount: header[2] === undefined ? 1 : Number(header[2]),
      newStart: Number(header[3]),
      newCount: header[4] === undefined ? 1 : Number(header[4]),
      lines: [],
      noNewlineOld: false,
      noNewlineNew: false,
    };
    i += 1;
    let oldSeen = 0;
    let newSeen = 0;
    while (i < lines.length && (oldSeen < hunk.oldCount || newSeen < hunk.newCount || lines[i]?.startsWith('\\'))) {
      const body = lines[i];
      if (body.startsWith('\\')) {
        const last = hunk.lines[hunk.lines.length - 1];
        if (!last) reject(`"\\ No newline" marker without a preceding line (line ${i + 1})`);
        if (last.op !== '+') hunk.noNewlineOld = true;
        if (last.op !== '-') hunk.noNewlineNew = true;
        i += 1;
        continue;
      }
      const op = body[0];
      if (op !== ' ' && op !== '-' && op !== '+') {
        // Tolerate an empty context line whose leading space was stripped.
        if (body === '') { hunk.lines.push({ op: ' ', text: '' }); oldSeen += 1; newSeen += 1; i += 1; continue; }
        reject(`invalid hunk line ${i + 1}: ${JSON.stringify(body.slice(0, 80))}`);
      }
      hunk.lines.push({ op, text: body.slice(1) });
      if (op !== '+') oldSeen += 1;
      if (op !== '-') newSeen += 1;
      i += 1;
    }
    if (oldSeen !== hunk.oldCount || newSeen !== hunk.newCount) {
      reject(`hunk at -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} has ${oldSeen}/${newSeen} lines; header counts do not match`);
    }
    hunks.push(hunk);
  }
  if (hunks.length === 0) reject('patch contains no hunks');
  return hunks;
}

function matchesAt(fileLines: string[], expected: string[], at: number): boolean {
  if (at < 0 || at + expected.length > fileLines.length) return false;
  for (let k = 0; k < expected.length; k += 1) if (fileLines[at + k] !== expected[k]) return false;
  return true;
}

/** Apply strictly: exact content match, at the stated line or a UNIQUE other location. */
export function applyHunks(original: string, hunks: Hunk[]): { text: string; offsets: number[]; added: number; removed: number } {
  const endsWithNewline = original.endsWith('\n');
  const fileLines = original.length === 0 ? [] : (endsWithNewline ? original.slice(0, -1) : original).split('\n');
  const out: string[] = [];
  let cursor = 0;
  let added = 0;
  let removed = 0;
  const offsets: number[] = [];
  let finalNoNewline: boolean | null = null;
  for (const hunk of hunks) {
    const oldLines = hunk.lines.filter((l) => l.op !== '+').map((l) => l.text);
    const newLines = hunk.lines.filter((l) => l.op !== '-').map((l) => l.text);
    const stated = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    let at = -1;
    if (matchesAt(fileLines, oldLines, stated) && stated >= cursor) at = stated;
    else if (oldLines.length > 0) {
      const candidates: number[] = [];
      for (let k = cursor; k + oldLines.length <= fileLines.length; k += 1) if (matchesAt(fileLines, oldLines, k)) candidates.push(k);
      if (candidates.length === 1) at = candidates[0];
      else if (candidates.length > 1) reject(`hunk -${hunk.oldStart},${hunk.oldCount} matches ${candidates.length} locations; refusing ambiguous application`);
    }
    if (at < 0) reject(`hunk -${hunk.oldStart},${hunk.oldCount} does not match the pre-image`);
    offsets.push(at - stated);
    out.push(...fileLines.slice(cursor, at), ...newLines);
    cursor = at + oldLines.length;
    added += newLines.length - hunk.lines.filter((l) => l.op === ' ').length;
    removed += oldLines.length - hunk.lines.filter((l) => l.op === ' ').length;
    if (cursor === fileLines.length) {
      if (hunk.noNewlineOld && endsWithNewline) reject('patch claims the pre-image lacks a trailing newline, but it has one');
      if (!hunk.noNewlineOld && !endsWithNewline && fileLines.length > 0) reject('pre-image lacks a trailing newline but the patch does not say so');
      finalNoNewline = hunk.noNewlineNew;
    }
  }
  out.push(...fileLines.slice(cursor));
  const trailingNewline = finalNoNewline === null ? endsWithNewline : !finalNoNewline;
  const text = out.length === 0 ? '' : out.join('\n') + (trailingNewline ? '\n' : '');
  return { text, offsets, added, removed };
}

function readNoFollow(target: string): { bytes: Buffer; stat: fs.Stats } {
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new DcToolError('DC_INVALID_ARGUMENT', 'apply_patch target must be a regular file', { stage: 'resolve' });
    if (stat.size > MAX_FILE_BYTES) throw new DcToolError('DC_INVALID_ARGUMENT', `target exceeds ${MAX_FILE_BYTES} bytes`, { stage: 'resolve' });
    return { bytes: fs.readFileSync(fd), stat };
  } finally {
    fs.closeSync(fd);
  }
}

/** Internal test seam (not reachable via MCP: the tool schema is strict). */
export interface ApplyPatchHooks {
  beforeCommit?: (target: string) => void | Promise<void>;
}

export async function applyPatch(input: ApplyPatchInput, hooks: ApplyPatchHooks = {}): Promise<ApplyPatchResult> {
  const expected = assertHex(input.expectedSha256, 'expectedSha256', [64]);
  if (typeof input.patch !== 'string' || input.patch.length === 0 || Buffer.byteLength(input.patch) > MAX_PATCH_BYTES) {
    throw new DcToolError('DC_INVALID_ARGUMENT', `patch must be a non-empty string of at most ${MAX_PATCH_BYTES} bytes`, { stage: 'validate' });
  }
  const target = await resolveAllowedPath(input.path, 'path');
  if (input.expectedHeadSha !== undefined) await requireHead(path.dirname(target.resolved), input.expectedHeadSha);

  let pre: { bytes: Buffer; stat: fs.Stats };
  try {
    pre = readNoFollow(target.resolved);
  } catch (error) {
    if (error instanceof DcToolError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') throw new DcToolError('DC_PATH_CHANGED', 'target became a symlink after resolution; refusing', { stage: 'resolve', errno: code });
    throw new DcToolError(code === 'ENOENT' ? 'DC_PATH_NOT_FOUND' : 'DC_INTERNAL_ERROR', `cannot read target: ${code ?? 'error'}`, { stage: 'resolve', errno: code, cause: error });
  }
  const preSha = sha256Hex(pre.bytes);
  recordEvidence({ preconditions: { expectedSha256: expected, actualSha256: preSha } });
  if (preSha !== expected) {
    throw new DcToolError('DC_HASH_MISMATCH', `pre-image sha256 is ${preSha}, expected ${expected}; file not modified`, {
      stage: 'precondition',
      details: { expectedSha256: expected, actualSha256: preSha },
    });
  }
  const original = pre.bytes.toString('utf8');
  if (Buffer.from(original, 'utf8').compare(pre.bytes) !== 0) {
    throw new DcToolError('DC_PATCH_REJECTED', 'target is not valid UTF-8 text', { stage: 'validate' });
  }
  const applied = applyHunks(original, parseUnifiedDiff(input.patch));
  const postBytes = Buffer.from(applied.text, 'utf8');
  const postSha = sha256Hex(postBytes);

  const dir = path.dirname(target.resolved);
  const temp = path.join(dir, `.${path.basename(target.resolved)}.dc-patch-${crypto.randomBytes(6).toString('hex')}.tmp`);
  const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), pre.stat.mode & 0o7777);
  try {
    try {
      fs.writeFileSync(fd, postBytes);
      fs.fchmodSync(fd, pre.stat.mode & 0o7777);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (hooks.beforeCommit) await hooks.beforeCommit(target.resolved);
    // Commit guard: the target must still be the exact pre-image we validated.
    let current: { bytes: Buffer; stat: fs.Stats };
    try {
      current = readNoFollow(target.resolved);
    } catch {
      throw new DcToolError('DC_PATH_CHANGED', 'target changed (removed or replaced) during apply; not overwritten', { stage: 'commit' });
    }
    if (current.stat.ino !== pre.stat.ino || current.stat.dev !== pre.stat.dev || sha256Hex(current.bytes) !== preSha) {
      throw new DcToolError('DC_PATH_CHANGED', 'target content changed between validation and commit; not overwritten', { stage: 'commit' });
    }
    await fsp.rename(temp, target.resolved);
  } catch (error) {
    await fsp.rm(temp, { force: true });
    throw error;
  }
  try {
    const dirFd = fs.openSync(dir, fs.constants.O_RDONLY);
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch {
    // Directory fsync is best-effort on platforms that do not support it.
  }
  recordEvidence({ results: { preSha256: preSha, postSha256: postSha, bytesAfter: postBytes.length } });
  return {
    path: target.resolved,
    preSha256: preSha,
    postSha256: postSha,
    hunksApplied: applied.offsets.length,
    linesAdded: applied.added,
    linesRemoved: applied.removed,
    bytesBefore: pre.bytes.length,
    bytesAfter: postBytes.length,
    hunkOffsets: applied.offsets,
  };
}
