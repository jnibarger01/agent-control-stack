import { execFile } from 'node:child_process';
import { DcToolError } from './errors.js';
import { assertHex, resolveAllowedPath } from './scope.js';
import { recordEvidence } from './context.js';

/**
 * Read-only git inspection and the shared HEAD optimistic-concurrency gate.
 *
 * Repository identity for write-sensitive operations is the HEAD commit SHA;
 * the branch name is informational only. git runs via execFile (argv, no
 * shell) with GIT_OPTIONAL_LOCKS=0 so inspection never takes index locks.
 */
const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
}

export function git(cwd: string, args: string[]): Promise<GitRun> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new DcToolError('DC_SUBSYSTEM_UNAVAILABLE', 'git executable not found', { stage: 'execute', errno: 'ENOENT' }));
        return;
      }
      if (error && (error as any).killed) {
        reject(new DcToolError('DC_TIMEOUT', `git ${args[0]} timed out`, { stage: 'execute' }));
        return;
      }
      resolve({ code: error ? (typeof (error as any).code === 'number' ? (error as any).code : 1) : 0, stdout, stderr });
    });
  });
}

async function repoRoot(dir: string): Promise<string> {
  const top = await git(dir, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) {
    throw new DcToolError('DC_NOT_A_GIT_REPOSITORY', `not inside a git work tree: ${dir}`, { stage: 'resolve' });
  }
  return top.stdout.trim();
}

async function headSha(root: string): Promise<string | null> {
  const head = await git(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
  return head.code === 0 ? head.stdout.trim() : null;
}

export interface StatusEntry {
  kind: 'ordinary' | 'renamed' | 'unmerged' | 'untracked';
  path: string;
  origPath?: string;
  index: string;
  worktree: string;
}

export interface ParsedStatus {
  oid: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  entries: StatusEntry[];
}

/** Parse `git status --porcelain=v2 --branch -z`. */
export function parsePorcelainV2(raw: string): ParsedStatus {
  const result: ParsedStatus = { oid: null, head: null, upstream: null, ahead: null, behind: null, entries: [] };
  const records = raw.split('\0');
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (!record) continue;
    if (record.startsWith('# ')) {
      const [, key, ...rest] = record.split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') result.oid = value === '(initial)' ? null : value;
      else if (key === 'branch.head') result.head = value === '(detached)' ? null : value;
      else if (key === 'branch.upstream') result.upstream = value;
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) {
          result.ahead = Number(m[1]);
          result.behind = Number(m[2]);
        }
      }
      continue;
    }
    const type = record[0];
    if (type === '1') {
      const parts = record.split(' ');
      result.entries.push({ kind: 'ordinary', index: parts[1][0], worktree: parts[1][1], path: parts.slice(8).join(' ') });
    } else if (type === '2') {
      const parts = record.split(' ');
      result.entries.push({ kind: 'renamed', index: parts[1][0], worktree: parts[1][1], path: parts.slice(9).join(' '), origPath: records[i + 1] });
      i += 1;
    } else if (type === 'u') {
      const parts = record.split(' ');
      result.entries.push({ kind: 'unmerged', index: parts[1][0], worktree: parts[1][1], path: parts.slice(10).join(' ') });
    } else if (type === '?') {
      result.entries.push({ kind: 'untracked', index: '?', worktree: '?', path: record.slice(2) });
    }
  }
  return result;
}

export interface GitState {
  repoRoot: string;
  headSha: string | null;
  unbornHead: boolean;
  branch: string | null;
  branchIsInformationalOnly: true;
  detached: boolean;
  dirty: boolean;
  counts: { staged: number; unstaged: number; untracked: number; conflicts: number };
  entries: StatusEntry[];
  entriesTruncated: boolean;
  stashes: { ref: string; sha: string; subject: string }[];
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
}

const MAX_ENTRIES = 2_000;

export async function gitState(repoPath: unknown): Promise<GitState> {
  const dir = await resolveAllowedPath(repoPath, 'repoPath');
  const root = await repoRoot(dir.resolved);
  const status = await git(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
  if (status.code !== 0) {
    throw new DcToolError('DC_INTERNAL_ERROR', `git status failed: ${status.stderr.trim().slice(0, 300)}`, { stage: 'execute' });
  }
  const parsed = parsePorcelainV2(status.stdout);
  const sha = await headSha(root);
  const stash = await git(root, ['stash', 'list', '--format=%gd%x00%H%x00%gs%x00']);
  const stashParts = stash.code === 0 ? stash.stdout.split('\0') : [];
  const stashes: GitState['stashes'] = [];
  for (let i = 0; i + 2 < stashParts.length; i += 3) {
    const ref = stashParts[i].replace(/^\n/, '');
    if (ref) stashes.push({ ref, sha: stashParts[i + 1], subject: stashParts[i + 2] });
  }
  const counts = { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 };
  for (const entry of parsed.entries) {
    if (entry.kind === 'untracked') counts.untracked += 1;
    else if (entry.kind === 'unmerged') counts.conflicts += 1;
    else {
      if (entry.index !== '.') counts.staged += 1;
      if (entry.worktree !== '.') counts.unstaged += 1;
    }
  }
  recordEvidence({ cwd: root, ...(sha ? { repoHeadSha: sha } : {}) });
  return {
    repoRoot: root,
    headSha: sha,
    unbornHead: sha === null,
    branch: parsed.head,
    branchIsInformationalOnly: true,
    detached: parsed.head === null && sha !== null,
    dirty: parsed.entries.length > 0,
    counts,
    entries: parsed.entries.slice(0, MAX_ENTRIES),
    entriesTruncated: parsed.entries.length > MAX_ENTRIES,
    stashes,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
  };
}

export interface HeadVerification {
  repoRoot: string;
  expectedSha: string;
  actualSha: string | null;
  match: boolean;
  dirty: boolean;
}

/** Shared optimistic-concurrency primitive. Full SHAs only (no prefixes). */
export async function verifyHead(repoPath: unknown, expectedSha: unknown): Promise<HeadVerification> {
  const expected = assertHex(expectedSha, 'expectedSha', [40, 64]);
  const dir = await resolveAllowedPath(repoPath, 'repoPath');
  const root = await repoRoot(dir.resolved);
  const actual = await headSha(root);
  const status = await git(root, ['status', '--porcelain=v2', '-z', '--untracked-files=normal']);
  const dirty = status.code === 0 ? status.stdout.length > 0 : true;
  recordEvidence({ cwd: root, ...(actual ? { repoHeadSha: actual } : {}), preconditions: { expectedHeadSha: expected } });
  return { repoRoot: root, expectedSha: expected, actualSha: actual, match: actual === expected, dirty };
}

/** For mutating tools: throws DC_HEAD_MISMATCH unless HEAD equals expected. */
export async function requireHead(repoPath: string, expectedSha: unknown): Promise<HeadVerification> {
  const verification = await verifyHead(repoPath, expectedSha);
  if (!verification.match) {
    throw new DcToolError('DC_HEAD_MISMATCH', `HEAD is ${verification.actualSha ?? '(unborn)'} but ${verification.expectedSha} was expected`, {
      stage: 'precondition',
      details: { expectedSha: verification.expectedSha, actualSha: verification.actualSha, repoRoot: verification.repoRoot },
    });
  }
  return verification;
}
