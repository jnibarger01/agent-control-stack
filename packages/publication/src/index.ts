import { runBoundedCommand, subprocessEnv } from "@agent-control-stack/machine-controller";

const GIT_COMMAND_TIMEOUT_MS = 120_000;
const GIT_COMMAND_TERMINATION_GRACE_MS = 5_000;
const GIT_COMMAND_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

const DEFAULT_COMMIT_AUTHOR_NAME = "ACS Autonomous Publisher";
const DEFAULT_COMMIT_AUTHOR_EMAIL = "acs-bot@users.noreply.github.com";
const DEFAULT_REMOTE = "origin";
const CONFIGURED_REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function validateGitRemote(remote: string): string {
  if (!CONFIGURED_REMOTE_NAME.test(remote)) {
    throw new Error("publication refused: git remote must be a configured remote name");
  }
  return remote;
}

export interface PublicationRecord {
  publicationId: string;
  workItemId: string;
  attemptId: string;
  branch: string;
  commitSha: string;
  pullRequestUrl: string;
  idempotencyKey: string;
}
export interface PublicationStore {
  getByIdempotency(key: string): PublicationRecord | undefined;
  record(record: PublicationRecord): PublicationRecord;
  /**
   * The attempt's own persisted, independently-run validation outcome -
   * never the caller's self-reported claim. Publication trusts only what
   * the store itself recorded.
   */
  getValidationRunForAttempt(attemptId: string): { passed: boolean } | undefined;
  /** Whether the work item's *current* execution plan actually authorizes a real push. */
  planAllowsPush(workItemId: string): boolean;
}
export interface PullRequestClient {
  createOrUpdate(input: { branch: string; commitSha: string; title: string; body: string; idempotencyKey: string }): Promise<{ url: string }>;
}
export interface PublicationInput {
  workItemId: string;
  attemptId: string;
  workspacePath: string;
  branch: string;
  title: string;
  body: string;
  leaseIsCurrent: () => Promise<boolean>;
  /** Remote to push to; defaults to "origin". */
  remote?: string;
  /** Overrides the commit's headline message; defaults to `title`. */
  commitMessage?: string;
  commitAuthorName?: string;
  commitAuthorEmail?: string;
  git?: string;
  gitRunner?: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

function attemptBranch(attemptId: string): string {
  return `acs/attempt/${attemptId}`;
}

const publicationLocks = new Map<string, Promise<void>>();
/**
 * Validated-attempt publication boundary; merge and deploy are intentionally absent.
 *
 * Commit + push of the workspace's actual diff is mandatory, not an opt-in flag: a
 * publication call must never open or update a PR against a stale pre-existing HEAD.
 * This is the only place permitted to turn a workspace's uncommitted changes into a
 * real commit and push it upstream. It fails closed: any branch that is not the
 * attempt's own convention-owned branch, any workspace with nothing staged to publish,
 * and any lease that goes stale mid-flight all abort before touching the remote.
 */
export async function publishValidatedAttempt(input: PublicationInput, store: PublicationStore, github: PullRequestClient): Promise<PublicationRecord> {
  const idempotencyKey = `publication:${input.workItemId}`;
  const previous = publicationLocks.get(idempotencyKey);
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  publicationLocks.set(idempotencyKey, current);
  await previous;
  try {
    return await publishValidatedAttemptUnlocked(input, store, github);
  } finally {
    release();
    if (publicationLocks.get(idempotencyKey) === current) publicationLocks.delete(idempotencyKey);
  }
}

async function publishValidatedAttemptUnlocked(input: PublicationInput, store: PublicationStore, github: PullRequestClient): Promise<PublicationRecord> {
  const validation = store.getValidationRunForAttempt(input.attemptId);
  if (!validation || !validation.passed) {
    throw new Error("publication requires a persisted, independently-run passing validation for this attempt");
  }
  if (!(await input.leaseIsCurrent())) throw new Error("publication requires a current lease");
  if (!store.planAllowsPush(input.workItemId)) {
    throw new Error("publication refused: the work item's current execution plan does not authorize a push");
  }

  const expectedBranch = attemptBranch(input.attemptId);
  if (input.branch !== expectedBranch) {
    throw new Error(`publication refused: branch "${input.branch}" is not owned by attempt "${input.attemptId}" (expected "${expectedBranch}")`);
  }

  const idempotencyKey = `publication:${input.workItemId}`;
  const existing = store.getByIdempotency(idempotencyKey);
  if (existing) return existing;

  const run = input.gitRunner ?? ((args: string[]) => runGit(input.git ?? "git", args, input.workspacePath));

  // Don't trust the caller-supplied input.branch alone - ask the actual
  // workspace what branch (if any) it is really on. A detached HEAD or a
  // checkout of the wrong branch means the engine's worktree diverged from
  // what the attempt claims to own, and publishing it would push history
  // from an unintended base while the check above still reports "passed".
  const actualBranch = await run(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (actualBranch.exitCode !== 0 || !actualBranch.stdout.trim()) {
    throw new Error("publication refused: workspace HEAD is detached, expected a checkout of the attempt's own branch");
  }
  if (actualBranch.stdout.trim() !== expectedBranch) {
    throw new Error(
      `publication refused: workspace is actually on branch "${actualBranch.stdout.trim()}", not the attempt's own branch "${expectedBranch}"`
    );
  }

  const statusBefore = await run(["status", "--porcelain"]);
  if (statusBefore.exitCode !== 0) throw new Error(`git status failed: ${statusBefore.stderr}`);

  const add = await run(["add", "-A"]);
  if (add.exitCode !== 0) throw new Error(`git add failed: ${add.stderr}`);

  const staged = await run(["diff", "--cached", "--name-only"]);
  if (staged.exitCode !== 0) throw new Error(`git diff --cached --name-only failed: ${staged.stderr}`);
  let commitSha: string;
  let alreadyPushed = false;
  if (!staged.stdout.trim()) {
    const current = await run(["rev-parse", "HEAD"]);
    if (current.exitCode !== 0 || !current.stdout.trim()) throw new Error("publication refused: no staged changes to publish after git add -A");
    const remote = validateGitRemote(input.remote ?? DEFAULT_REMOTE);
    const remoteHead = await run(["ls-remote", "--heads", "--", remote, input.branch]);
    const remoteSha = remoteHead.stdout.trim().split(/\s+/u)[0];
    if (remoteHead.exitCode !== 0 || remoteSha !== current.stdout.trim()) {
      throw new Error("publication refused: no staged changes to publish after git add -A");
    }
    commitSha = current.stdout.trim();
    alreadyPushed = true;
  } else {
    const diffCheck = await run(["diff", "--cached", "--check"]);
    if (diffCheck.exitCode !== 0) throw new Error(`git diff --cached --check failed: ${diffCheck.stderr || diffCheck.stdout}`);
    const authorName = input.commitAuthorName ?? DEFAULT_COMMIT_AUTHOR_NAME;
    const authorEmail = input.commitAuthorEmail ?? DEFAULT_COMMIT_AUTHOR_EMAIL;
    const headline = input.commitMessage?.trim() || input.title;
    const commitResult = await run(["-c", `user.name=${authorName}`, "-c", `user.email=${authorEmail}`, "commit", "-m", headline, "-m", input.body]);
    if (commitResult.exitCode !== 0) throw new Error(`git commit failed: ${commitResult.stderr || commitResult.stdout}`);
    const commit = await run(["rev-parse", "HEAD"]);
    if (commit.exitCode !== 0 || !commit.stdout.trim()) throw new Error("unable to resolve publication commit");
    commitSha = commit.stdout.trim();
  }

  if (!(await input.leaseIsCurrent())) throw new Error("lease became stale before publication push");

  if (!alreadyPushed) {
    const remote = validateGitRemote(input.remote ?? DEFAULT_REMOTE);
    const push = await run(["push", "--set-upstream", "--", remote, `HEAD:refs/heads/${input.branch}`]);
    if (push.exitCode !== 0) throw new Error(`git push failed: ${push.stderr || push.stdout}`);
  }

  // The push already landed and cannot be un-pushed, but every mutation
  // still ahead of us - opening/updating the PR, persisting the durable
  // publication record - must not proceed under authority that died in the
  // gap since the last check. Fencing at each externally visible boundary
  // (not only once before the first one) bounds how much a lease loss
  // mid-flight can still cause, instead of trusting one stale boolean for
  // the whole remaining sequence.
  if (!(await input.leaseIsCurrent())) throw new Error("lease became stale after publication push, before PR creation");

  const pullRequest = await github.createOrUpdate({ branch: input.branch, commitSha, title: input.title, body: input.body, idempotencyKey });

  if (!(await input.leaseIsCurrent())) throw new Error("lease became stale after PR creation, before persisting the publication record");

  return store.record({ publicationId: `publication-${input.workItemId}`, workItemId: input.workItemId, attemptId: input.attemptId, branch: input.branch, commitSha, pullRequestUrl: pullRequest.url, idempotencyKey });
}

async function runGit(git: string, args: string[], cwd: string) {
  const result = await runBoundedCommand({
    cwd,
    command: git,
    args,
    env: subprocessEnv(),
    timeoutMs: GIT_COMMAND_TIMEOUT_MS,
    terminationGraceMs: GIT_COMMAND_TERMINATION_GRACE_MS,
    maxOutputBytes: GIT_COMMAND_MAX_OUTPUT_BYTES
  });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? 1 };
}

export * from "./github.js";
