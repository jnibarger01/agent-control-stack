/**
 * Fixed git subcommands. Callers cannot pass arbitrary git flags.
 * The repository must be a real git toplevel inside a JC filesystem root.
 *
 * Every invocation disables repository hooks, fsmonitor and ext:: transports,
 * so reading or committing in a repository cannot run code the repository
 * configured. Children get an allowlisted environment only.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { secretScan } from '../execution/secret-scan-tool.js';
import { jcChildEnv } from './child-env.js';
import { containJcPath, type JcFsPolicy } from './filesystem.js';
import { IntegrationError } from './integrations.js';

const exec = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_CONFIG = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'protocol.ext.allow=never',
  '-c', 'core.pager=cat',
];
const MAX_PUSH_SCAN_BYTES = 2 * 1024 * 1024;

async function git(repo: string, args: string[], maxBuffer = 1024 * 1024): Promise<string> {
  try {
    const result = await exec('git', [...SAFE_CONFIG, '-C', repo, ...args], {
      timeout: 30_000,
      maxBuffer,
      // SSH_AUTH_SOCK lets an approved fetch/push use the operator's agent.
      env: jcChildEnv({ GIT_TERMINAL_PROMPT: '0' }, ['SSH_AUTH_SOCK']),
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

function relativePath(input: unknown): string {
  if (typeof input !== 'string' || !input || input.includes('\0') || path.isAbsolute(input) || input.split(/[/\\]/).includes('..')) {
    throw new IntegrationError('invalid_argument', 'git path must be relative and must not contain ..');
  }
  // Pathspec magic (":(top)", ":!x") would widen what the caller named.
  if (input.startsWith(':')) throw new IntegrationError('invalid_argument', 'git pathspec magic is not allowed');
  return input;
}

async function currentBranch(repo: string): Promise<string> {
  // symbolic-ref also works on an unborn branch (before the first commit).
  let branch: string;
  try {
    branch = (await git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
  } catch {
    throw new IntegrationError('detached_head', 'HEAD is detached; check out a branch first');
  }
  if (!BRANCH.test(branch)) throw new IntegrationError('invalid_argument', 'current branch name is not supported');
  return branch;
}

async function configuredRemote(repo: string, requested: unknown): Promise<string> {
  const remote = requested === undefined ? 'origin' : requested;
  if (typeof remote !== 'string' || !REMOTE.test(remote)) throw new IntegrationError('invalid_argument', 'remote must be a configured remote name');
  const remotes = (await git(repo, ['remote'])).split('\n').map((line) => line.trim()).filter(Boolean);
  if (!remotes.includes(remote)) throw new IntegrationError('remote_not_configured', `remote "${remote}" is not configured in this repository`);
  return remote;
}

export async function gitStatus(args: Record<string, unknown>, policy: JcFsPolicy): Promise<Record<string, unknown>> {
  const repo = await repoRoot(args.repo, policy);
  const text = await git(repo, ['status', '--porcelain=v1', '-b']);
  const lines = text.split('\n').filter(Boolean);
  const header = lines[0] ?? '';
  const branchPart = header.replace(/^## /, '').split('...')[0] ?? '';
  const detached = branchPart.startsWith('HEAD (no branch)');
  const branch = detached ? 'HEAD' : branchPart.replace(/^No commits yet on /, '');
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
  return {
    repo,
    branch,
    head,
    ahead,
    behind,
    staged,
    modified,
    untracked,
    detached,
    clean: staged.length === 0 && modified.length === 0 && untracked.length === 0,
  };
}

export async function gitDiff(args: Record<string, unknown>, policy: JcFsPolicy): Promise<Record<string, unknown>> {
  const repo = await repoRoot(args.repo, policy);
  const gitArgs = ['diff', '--no-ext-diff', '--no-textconv', '--'];
  if (args.staged === true) gitArgs.splice(1, 0, '--cached');
  if (args.path !== undefined) gitArgs.push(relativePath(args.path));
  const diff = await git(repo, gitArgs);
  return { repo, staged: args.staged === true, truncated: diff.length > 200_000, diff: diff.slice(0, 200_000) };
}

export async function gitLog(args: Record<string, unknown>, policy: JcFsPolicy): Promise<Record<string, unknown>> {
  const repo = await repoRoot(args.repo, policy);
  const limit = args.limit === undefined ? 20 : args.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new IntegrationError('invalid_argument', 'limit must be an integer from 1 to 100');
  }
  const text = await git(repo, ['log', '-n', String(limit), '--format=%H%x09%s']);
  const commits = text.split('\n').filter(Boolean).map((line) => {
    const [sha, subject] = line.split('\t');
    return { sha, subject };
  });
  return { repo, commits };
}

export async function gitBranch(args: Record<string, unknown>, policy: JcFsPolicy): Promise<Record<string, unknown>> {
  const repo = await repoRoot(args.repo, policy);
  const text = await git(repo, ['branch', '--format=%(refname:short)']);
  let current: string | null = null;
  try {
    current = await currentBranch(repo);
  } catch {
    current = null;
  }
  return { repo, current, detached: current === null, branches: text.split('\n').filter(Boolean) };
}

export async function gitShow(args: Record<string, unknown>, policy: JcFsPolicy): Promise<Record<string, unknown>> {
  const repo = await repoRoot(args.repo, policy);
  const rev = args.rev === undefined ? 'HEAD' : args.rev;
  if (rev !== 'HEAD' && (typeof rev !== 'string' || !SHA.test(rev))) {
    throw new IntegrationError('invalid_argument', 'rev must be HEAD or a full 40-hex commit');
  }
  const text = await git(repo, ['show', '--no-ext-diff', '--no-textconv', '--stat', '--format=%H%n%s', String(rev)]);
  return { repo, rev, text: text.slice(0, 100_000) };
}

export async function gitAdd(args: Record<string, unknown>, policy: JcFsPolicy): Promise<Record<string, unknown>> {
  const repo = await repoRoot(args.repo, policy);
  if (!Array.isArray(args.paths) || args.paths.length < 1 || args.paths.length > 50) {
    throw new IntegrationError('invalid_argument', 'paths must contain 1 to 50 relative paths');
  }
  const paths = args.paths.map((item) => relativePath(item));
  await git(repo, ['add', '--', ...paths]);
  return { repo, added: paths };
}

export async function gitCommit(args: Record<string, unknown>, policy: JcFsPolicy): Promise<Record<string, unknown>> {
  const repo = await repoRoot(args.repo, policy);
  if (typeof args.message !== 'string' || args.message.length < 1 || args.message.length > 500) {
    throw new IntegrationError('invalid_argument', 'message must be 1 to 500 characters');
  }
  const branch = await currentBranch(repo);
  const staged = (await git(repo, ['diff', '--cached', '--name-only'])).split('\n').filter(Boolean);
  if (staged.length === 0) throw new IntegrationError('nothing_staged', 'nothing is staged; run git_add first');
  await git(repo, ['commit', '--no-verify', '-m', args.message]);
  const head = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  return { repo, branch, head, files: staged, message: args.message };
}

export async function gitFetch(args: Record<string, unknown>, policy: JcFsPolicy): Promise<Record<string, unknown>> {
  const repo = await repoRoot(args.repo, policy);
  const remote = await configuredRemote(repo, args.remote);
  const text = await git(repo, ['fetch', '--no-recurse-submodules', remote]);
  return { repo, remote, text: text.slice(0, 20_000) };
}

/**
 * Pushes exactly `expectedHead` (the commit the approver saw) to the current
 * branch on a configured remote. Refuses a detached HEAD, a moved HEAD, a
 * non-fast-forward (no force), and any commit the secret scan flags.
 */
export async function gitPush(args: Record<string, unknown>, policy: JcFsPolicy): Promise<Record<string, unknown>> {
  const repo = await repoRoot(args.repo, policy);
  const remote = await configuredRemote(repo, args.remote);
  if (typeof args.expectedHead !== 'string' || !SHA.test(args.expectedHead)) {
    throw new IntegrationError('invalid_argument', 'expectedHead must be the full 40-hex commit to push');
  }
  const branch = await currentBranch(repo);
  if (args.branch !== undefined && args.branch !== branch) {
    throw new IntegrationError('invalid_argument', 'branch must be the currently checked out branch');
  }
  const head = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  if (head !== args.expectedHead) {
    throw new IntegrationError('head_moved', `HEAD is ${head}, not the approved ${args.expectedHead}`);
  }
  let patch: string;
  try {
    patch = await git(repo, ['log', '-p', '--no-ext-diff', '--no-textconv', '--format=', head, '--not', `--remotes=${remote}`], MAX_PUSH_SCAN_BYTES + 1);
  } catch {
    throw new IntegrationError('secret_scan_unavailable', 'cannot collect the commits to push for a secret scan');
  }
  let scan: Awaited<ReturnType<typeof secretScan>>;
  try {
    scan = await secretScan({ target: 'diff', patch });
  } catch {
    throw new IntegrationError('secret_scan_unavailable', 'the push is too large to secret-scan; push smaller batches');
  }
  if (!scan.clean) {
    throw new IntegrationError('secret_detected', `secret scan found ${scan.findingCount} finding(s) (${Object.keys(scan.byCategory).join(', ')}); push refused`);
  }
  const text = await git(repo, ['push', '--no-recurse-submodules', '--', remote, `${head}:refs/heads/${branch}`]);
  return { repo, remote, branch, pushed: head, secretScan: { clean: true, scannedBytes: Buffer.byteLength(patch) }, text: text.slice(0, 20_000) };
}
