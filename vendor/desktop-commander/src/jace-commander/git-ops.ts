/**
 * Fixed git subcommands. Callers cannot pass arbitrary git flags.
 * The repository must be a real git toplevel inside a JC filesystem root.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { containJcPath, type JcFsPolicy } from './filesystem.js';
import { IntegrationError } from './integrations.js';

const exec = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;
const REF = /^[A-Za-z0-9._/-]{1,128}$/;

async function git(repo: string, args: string[]): Promise<string> {
  try {
    const result = await exec('git', ['-C', repo, ...args], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return result.stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? '';
    throw new IntegrationError('git_failed', stderr.trim().slice(0, 500) || 'git command failed');
  }
}

async function repoRoot(requested: unknown, policy: JcFsPolicy): Promise<string> {
  const contained = containJcPath(requested, policy);
  const top = (await git(contained, ['rev-parse', '--show-toplevel'])).trim();
  return containJcPath(top, policy);
}

function relativePath(repo: string, input: unknown): string {
  if (typeof input !== 'string' || !input || path.isAbsolute(input) || input.split(/[/\\]/).includes('..')) {
    throw new IntegrationError('invalid_argument', 'git path must be relative and must not contain ..');
  }
  return input;
}

export async function gitStatus(args: Record<string, unknown>, policy: JcFsPolicy): Promise<Record<string, unknown>> {
  const repo = await repoRoot(args.repo, policy);
  const text = await git(repo, ['status', '--porcelain=v1', '-b']);
  const lines = text.split('\n').filter(Boolean);
  const header = lines[0] ?? '';
  const branch = header.replace(/^## /, '').split('...')[0] ?? '';
  const ahead = Number(/ahead (\d+)/.exec(header)?.[1] ?? 0);
  const behind = Number(/behind (\d+)/.exec(header)?.[1] ?? 0);
  const staged: string[] = [];
  const modified: string[] = [];
  const untracked: string[] = [];
  for (const line of lines.slice(1)) {
    const file = line.slice(3);
    if (line.startsWith('??')) untracked.push(file);
    else if (line[0] !== ' ' && line[0] !== '?') staged.push(file);
    if (line[1] !== ' ' && !line.startsWith('??')) modified.push(file);
  }
  let head = '';
  try {
    head = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  } catch {
    head = '';
  }
  return { repo, branch, head, ahead, behind, staged, modified, untracked, detached: branch === 'HEAD' };
}

export async function gitDiff(args: Record<string, unknown>, policy: JcFsPolicy): Promise<Record<string, unknown>> {
  const repo = await repoRoot(args.repo, policy);
  const gitArgs = ['diff', '--no-ext-diff', '--'];
  if (args.staged === true) gitArgs.splice(1, 0, '--cached');
  if (args.path !== undefined) gitArgs.push(relativePath(repo, args.path));
  const diff = await git(repo, gitArgs);
  return { repo, staged: args.staged === true, truncated: diff.length >= 1024 * 1024 - 1, diff: diff.slice(0, 200_000) };
}

export async function gitLog(args: Record<string, unknown>, policy: JcFsPolicy): Promise<Record<string, unknown>> {
  const repo = await repoRoot(args.repo, policy);
  const limit = typeof args.limit === 'number' ? args.limit : 20;
  const text = await git(repo, ['log', `-n`, String(limit), '--format=%H%x09%s']);
  const commits = text.split('\n').filter(Boolean).map((line) => {
    const [sha, subject] = line.split('\t');
    return { sha, subject };
  });
  return { repo, commits };
}

export async function gitBranch(args: Record<string, unknown>, policy: JcFsPolicy): Promise<Record<string, unknown>> {
  const repo = await repoRoot(args.repo, policy);
  const text = await git(repo, ['branch', '--format=%(refname:short)']);
  return { repo, branches: text.split('\n').filter(Boolean) };
}

export async function gitShow(args: Record<string, unknown>, policy: JcFsPolicy): Promise<Record<string, unknown>> {
  const repo = await repoRoot(args.repo, policy);
  const rev = args.rev === undefined ? 'HEAD' : args.rev;
  if (rev !== 'HEAD' && (typeof rev !== 'string' || !SHA.test(rev))) {
    throw new IntegrationError('invalid_argument', 'rev must be HEAD or a full 40-hex commit');
  }
  const text = await git(repo, ['show', '--stat', '--format=%H%n%s', String(rev)]);
  return { repo, rev, text: text.slice(0, 100_000) };
}

export async function gitAdd(args: Record<string, unknown>, policy: JcFsPolicy): Promise<Record<string, unknown>> {
  const repo = await repoRoot(args.repo, policy);
  if (!Array.isArray(args.paths) || args.paths.length < 1 || args.paths.length > 50) {
    throw new IntegrationError('invalid_argument', 'paths must contain 1 to 50 relative paths');
  }
  const paths = args.paths.map((item) => relativePath(repo, item));
  await git(repo, ['add', '--', ...paths]);
  return { repo, added: paths };
}

export async function gitCommit(args: Record<string, unknown>, policy: JcFsPolicy): Promise<Record<string, unknown>> {
  const repo = await repoRoot(args.repo, policy);
  if (typeof args.message !== 'string' || args.message.length < 1 || args.message.length > 500) {
    throw new IntegrationError('invalid_argument', 'message must be 1 to 500 characters');
  }
  await git(repo, ['commit', '-m', args.message]);
  const head = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  return { repo, head, message: args.message };
}

export async function gitFetch(args: Record<string, unknown>, policy: JcFsPolicy): Promise<Record<string, unknown>> {
  const repo = await repoRoot(args.repo, policy);
  const remote = typeof args.remote === 'string' ? args.remote : 'origin';
  if (!REF.test(remote)) throw new IntegrationError('invalid_argument', 'remote name is invalid');
  const text = await git(repo, ['fetch', remote]);
  return { repo, remote, text: text.slice(0, 20_000) };
}

export async function gitPush(args: Record<string, unknown>, policy: JcFsPolicy): Promise<Record<string, unknown>> {
  const repo = await repoRoot(args.repo, policy);
  const remote = typeof args.remote === 'string' ? args.remote : 'origin';
  if (!REF.test(remote)) throw new IntegrationError('invalid_argument', 'remote name is invalid');
  const branch = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (!REF.test(branch) || branch === 'HEAD') throw new IntegrationError('invalid_argument', 'refusing to push a detached HEAD');
  if (args.branch !== undefined && args.branch !== branch) {
    throw new IntegrationError('invalid_argument', 'branch must be the currently checked out branch');
  }
  const text = await git(repo, ['push', remote, branch]);
  return { repo, remote, branch, text: text.slice(0, 20_000) };
}
